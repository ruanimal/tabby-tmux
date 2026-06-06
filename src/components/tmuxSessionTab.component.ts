import { Component, Injector, Input, OnInit, OnDestroy, ChangeDetectorRef, ElementRef } from '@angular/core'
import { Subscription } from 'rxjs'
import { SplitTabComponent, SplitContainer, LogService, Logger, TabsService, HotkeysService } from 'tabby-core'
import { TabRecoveryService } from 'tabby-core'
import { TmuxController } from '../session'
import { TmuxService } from '../services/tmux.service'
import { TmuxPaneTabComponent } from './tmuxPaneTab.component'
import { parseTmuxLayout, TmuxLayoutNode, flattenLayout } from '../layoutParser'

export interface TmuxSessionProfile {
    sessionName?: string
}

/**
 * TmuxSessionTabComponent - Manages an entire tmux session within a single Tabby tab.
 *
 * Each tmux window is represented by its pane tabs, which are hidden/shown via
 * removeTab()/addTab() when switching windows. The bottom window bar provides
 * window switching UI.
 *
 * Always created by TmuxService.attachToTerminal() with existingController set.
 */
@Component({
    selector: 'tmux-session-tab',
    host: {
        '[class.tmux-session-host]': 'true'
    },
    template: `
        <div class="pane-area">
            <ng-container #vc></ng-container>
            <split-tab-spanner
                *ngFor='let spanner of _spanners'
                [container]='spanner.container'
                [index]='spanner.index'
                (change)='onSpannerAdjusted(spanner)'
                (resizing)='onSpannerResizing($event)'
            ></split-tab-spanner>
            <split-tab-drop-zone
                *ngFor='let dropZone of _dropZones'
                [parent]='this'
                [dropZone]='dropZone'
                (tabDropped)='onTabDropped($event, dropZone)'
            >
            </split-tab-drop-zone>
            <split-tab-pane-label
                *ngFor='let tab of getAllTabs()'
                cdkDropList
                cdkAutoDropGroup='app-tabs'
                [tab]='tab'
                [parent]='this'
            >
            </split-tab-pane-label>
        </div>
        <tmux-window-bar
            [controller]="controller"
            [activeWindowId]="activeWindowId"
            [collapsed]="windowBarCollapsed"
            [sessionName]="sessionName"
            (windowSwitch)="switchToWindow($event)"
            (disconnect)="onDisconnect()"
            (createWindow)="onCreateWindow()"
            (collapsedChange)="onToggleCollapse($event)"
        ></tmux-window-bar>
    `,
    styles: [`
        :host {
            position: relative;
            display: flex;
            flex-direction: column;
            width: 100%;
            height: 100%;
        }
        .pane-area {
            flex: 1 1 0;
            position: relative;
            min-height: 0;
        }
        /* SplitTab.layoutInternal() adds .child class and sets inline left/top/width/height % */
        /* but position:absolute comes from CSS — must match inside pane-area */
        ::ng-deep .pane-area > .child {
            position: absolute;
            transition: 0.125s all;
            opacity: .75;
        }
        ::ng-deep .pane-area > .child.focused {
            opacity: 1;
        }
        tmux-window-bar {
            flex: 0 0 auto;
            position: relative;
            z-index: 10;
        }
    `]
})
export class TmuxSessionTabComponent extends SplitTabComponent implements OnInit, OnDestroy {
    @Input() profile: TmuxSessionProfile = {}
    @Input() existingController!: TmuxController

    private logger: Logger
    private eventSubscription: Subscription | null = null

    // windowId → (paneId → paneTab)
    private windowPaneTabs = new Map<number, Map<number, TmuxPaneTabComponent>>()

    controller: TmuxController | null = null
    activeWindowId: number | null = null
    connected = false
    sessionName = ''
    windowBarCollapsed = false
    private _initialized = false
    private _tabsService: TabsService
    private _resizeHandler: (() => void) | null = null
    private _resizeTimer: any = null
    private _paneAreaObserver: ResizeObserver | null = null
    /** Last dimensions sent to tmux, for dedup */
    private _lastSentCols = 0
    private _lastSentRows = 0

    constructor(
        injector: Injector,
        private tmuxService: TmuxService,
        tabsService: TabsService,
        private cdr: ChangeDetectorRef,
        private hostElement: ElementRef,
        log: LogService,
    ) {
        super(
            injector.get(HotkeysService),
            tabsService,
            injector.get(TabRecoveryService),
            injector
        )
        this._tabsService = tabsService
        this.logger = log.create('tmux-session')
    }

    ngOnInit(): void {
        this.logger.info('ngOnInit initialized')
        this.controller = this.existingController

        if (!this.controller) {
            this.logger.error('No controller provided')
            return
        }

        this.sessionName = this.controller.getSessionName() || this.profile.sessionName || 'default'
        this.setTitle(`Tmux: ${this.sessionName}`)

        // Subscribe to controller events
        this.eventSubscription = this.controller.events.subscribe(event => {
            this.handleControllerEvent(event)
        })

        // Bootstrap from current controller snapshot in case early events were missed
        this.bootstrapFromControllerState()
    }

    /**
     * Called after the view is initialized.
     * The parent SplitTabComponent has finished its own ngAfterViewInit
     * (including recoverContainer if any), so #vc is ready.
     */
    async ngAfterViewInit(): Promise<void> {
        await super.ngAfterViewInit()

        if (!this.controller) return

        // Wait one more frame to ensure the wrapper's attachTabView
        // has finished inserting us into its ViewContainerRef
        requestAnimationFrame(async () => {
            this._initialized = true
            await this.controller!.refreshPanes()
            this.bootstrapFromControllerState()

            const firstWindowId = this.controller!.getFirstWindowId()
            if (firstWindowId !== undefined) {
                this.switchToWindow(firstWindowId)
            }

            // Listen for window resize events (like iTerm2's windowDidResize).
            // Only fires when the browser window changes size, not during
            // internal SplitTab layout operations. Debounced to avoid flooding.
            this._resizeHandler = () => this.scheduleRefreshClientSize()
            window.addEventListener('resize', this._resizeHandler)

            // Observe the .pane-area container directly. This is the single
            // source of truth for the client size: any time the container's
            // pixel size changes (window resize, spanner drag, sidebar toggle,
            // first mount), we recompute and push the whole-window grid to tmux.
            // Per-pane xterm fit is disabled, so this never feeds back.
            const host = this.hostElement.nativeElement as HTMLElement
            const paneArea = host.querySelector('.pane-area')
            if (paneArea && typeof ResizeObserver !== 'undefined') {
                this._paneAreaObserver = new ResizeObserver(() => this.scheduleRefreshClientSize())
                this._paneAreaObserver.observe(paneArea)
            }

            // Initial size sync after pane mount
            this.scheduleRefreshClientSize()
        })
    }

    private bootstrapFromControllerState(): void {
        if (!this.controller) {
            return
        }

        // Prime local maps from controller state so UI can render even if
        // window-add / pane-add events happened before this component subscribed.
        for (const windowState of this.controller.getAllWindowStates()) {
            if (!this.windowPaneTabs.has(windowState.id)) {
                this.windowPaneTabs.set(windowState.id, new Map())
            }
        }

        if (this.controller.isAttached) {
            this.connected = true
        }

        this.cdr.detectChanges()
    }

    private async handleControllerEvent(event: { type: string; paneId?: number; windowId?: number; data?: any }): Promise<void> {
        this.logger.info('SessionTab event:', event.type, event)

        switch (event.type) {
            case 'initialized':
            case 'session-changed':
                this.connected = true
                this.sessionName = this.controller?.getSessionName() || this.profile.sessionName || 'default'
                this.setTitle(`Tmux: ${this.sessionName}`)
                this.cdr.detectChanges()
                break

            case 'window-add':
                if (event.windowId !== undefined) {
                    // Ensure the window has an entry in our map
                    if (!this.windowPaneTabs.has(event.windowId)) {
                        this.logger.info(`Adding new window @${event.windowId} to map`)
                        this.windowPaneTabs.set(event.windowId, new Map())
                    }
                    // If no active window yet, switch to this one (only if view is ready)
                    if (this.activeWindowId === null && this._initialized) {
                        this.logger.info(`Switching to newly added window @${event.windowId}`)
                        await this.switchToWindow(event.windowId)
                    }
                }
                break

            case 'window-close':
                if (event.windowId !== undefined) {
                    await this.handleWindowClose(event.windowId)
                }
                break

            case 'pane-add':
                if (event.paneId !== undefined && event.windowId !== undefined) {
                    this.logger.info(`Handling pane-add event: pane=${event.paneId}, window=${event.windowId}`)
                    await this.handlePaneAdd(event.paneId, event.windowId)
                }
                break

            case 'pane-update':
                if (event.paneId !== undefined && event.windowId !== undefined) {
                    // Pane might have moved to a different window
                    this.logger.info(`Handling pane-update event: pane=${event.paneId}, window=${event.windowId}`)
                    await this.handlePaneUpdate(event.paneId, event.windowId)
                }
                break

            case 'layout-change':
                if (event.windowId === this.activeWindowId && event.data?.layout) {
                    this.logger.info(`Syncing layout for window @${event.windowId}`)
                    this.syncLayout(event.data.layout)
                    // NOTE: Do NOT call refreshClientSize here.
                    // refresh-client -C causes tmux to re-layout, which sends
                    // another %layout-change, creating an infinite loop.
                }
                break

            case 'exit':
                this.connected = false
                this.cdr.detectChanges()
                break
        }
    }

    /**
     * Switch to a different tmux window.
     * Hides current window's panes and shows target window's panes.
     */
    async switchToWindow(windowId: number): Promise<void> {
        if (windowId === this.activeWindowId) return

        this.logger.info(`Switching to window @${windowId}`)

        // 1. Detach current active window's pane views (don't use removeTab —
        //    SplitTabComponent.removeTab destroys the tab when root.children
        //    becomes empty). Instead, clear the root directly.
        if (this.activeWindowId !== null) {
            const paneMap = this.windowPaneTabs.get(this.activeWindowId)
            if (paneMap) {
                this.logger.info(`Detaching ${paneMap.size} pane(s) for window @${this.activeWindowId}`)
                for (const paneTab of paneMap.values()) {
                    (paneTab as any).emitVisibility(false)
                    this.detachPaneView(paneTab as any)
                }
            }
        }

        // 2. Update active window
        this.activeWindowId = windowId

        // 3. Ensure pane tabs exist for this window
        if (!this.windowPaneTabs.has(windowId)) {
            this.windowPaneTabs.set(windowId, new Map())
        }
        const paneMap = this.windowPaneTabs.get(windowId)!

        if (paneMap.size === 0) {
            // First time visiting this window — send an approximate client size
            // before creating panes so capture-pane output is roughly correct.
            // The precise size is sent once the .pane-area ResizeObserver fires
            // after the panes mount and render their character grid.
            this.refreshClientSize()

            this.logger.info(`Creating panes for newly visited window @${windowId}`)
            await this.addPanesForWindow(windowId)
        } else {
            this.logger.info(`Mounting existing ${paneMap.size} pane(s) for window @${windowId}`)
        }

        // 4. Rebuild SplitContainer tree with this window's panes
        this.root = new SplitContainer()
        this.root.orientation = 'h'

        const paneTabs = Array.from(paneMap.values())
        if (paneTabs.length > 0) {
            this.logger.info(`Adding ${paneTabs.length} pane tab(s) to SplitTab`)
            for (let i = 0; i < paneTabs.length; i++) {
                const paneTab = paneTabs[i] as any
                if (i === 0) {
                    await this.addTab(paneTab, null, 'r')
                } else {
                    await this.addTab(paneTab, paneTabs[i - 1] as any, 'r')
                }
                paneTab.emitVisibility(true)
            }

            // 5. Sync layout from tmux
            const windowState = this.controller?.getWindowState(windowId)
            if (windowState?.layout) {
                this.logger.info('Syncing layout after mounting panes')
                this.syncLayout(windowState.layout)
            }
        }

        // 6. Detect changes; precise client size refresh happens via the
        //    .pane-area ResizeObserver once xterm renders its cell grid.
        this.cdr.detectChanges()
    }

    /**
     * Override focus to manage which pane is the active (hotkey-target) pane.
     *
     * In tmux integration, all panes are visible simultaneously (split layout),
     * so we cannot blur other tabs (that would prevent their xterm frontends
     * from staying initialized). Instead, all pane tabs keep `hasFocus = true`
     * for frontend initialization, and we use `TmuxPaneTabComponent._tmuxActive`
     * to control which pane processes hotkeys.
     */
    override focus(tab: any): void {
        ;(this as any).focusedTab = tab
        tab.emitFocused()
        // Mark only the focused pane as active for hotkey routing.
        // Other panes remain visible and initialized but won't process
        // hotkey-triggered input (Ctrl+C, paste, etc.).
        for (const t of this.getAllTabs()) {
            if (t instanceof TmuxPaneTabComponent) {
                t._tmuxActive = (t === tab)
            }
        }
    }

    /**
     * Detach a pane tab's view from the ViewContainer without calling
     * removeTab() which would trigger self-destruction when root empties.
     */
    private detachPaneView(tab: any): void {
        // Remove from root tree structure
        const parent = this.getParentOf(tab)
        if (parent) {
            const index = parent.children.indexOf(tab)
            if (index !== -1) {
                parent.children.splice(index, 1)
                parent.ratios.splice(index, 1)
            }
        }
        // Remove the embedded view reference so layout() won't position it
        ;(this as any).viewRefs?.delete(tab)
        tab.removeFromContainer()
        tab.parent = null
    }

    /**
     * Override removeTab to prevent self-destruction when root.children
     * becomes empty. In TmuxSessionTab, an empty root is normal during
     * window switches and should not destroy the session tab.
     */
    override removeTab(tab: any): void {
        const parent = this.getParentOf(tab)
        if (!parent) return

        const index = parent.children.indexOf(tab)
        parent.ratios.splice(index, 1)
        parent.children.splice(index, 1)

        tab.removeFromContainer()
        tab.parent = null
        ;(this as any).viewRefs?.delete(tab)

        this.layout()

        // Do NOT destroy self when root is empty — this is normal during
        // tmux window switches.
    }

    /**
     * Create pane tabs for a window that hasn't been visited yet.
     */
    private async addPanesForWindow(windowId: number): Promise<void> {
        if (!this.controller) return

        const paneIds = this.controller.getWindowPanes(windowId)
        this.logger.info(`Controller returned pane IDs for window @${windowId}: ${paneIds.map(p => '%' + p).join(', ')}`)

        const paneMap = this.windowPaneTabs.get(windowId) || new Map<number, TmuxPaneTabComponent>()
        this.windowPaneTabs.set(windowId, paneMap)

        for (const paneId of paneIds) {
            if (paneMap.has(paneId)) continue

            this.logger.info(`Creating pane tab for %${paneId}`)
            const paneTab = this.createPaneTab(paneId)
            paneMap.set(paneId, paneTab)
        }
        this.logger.info(`Created ${paneMap.size} pane tab(s) for window @${windowId}`)
    }

    /**
     * Create a TmuxPaneTabComponent using TabsService (proper Angular DI).
     * This ensures the component has a hostView and ViewContainerRef.
     */
    private createPaneTab(paneId: number): TmuxPaneTabComponent {
        this.logger.info(`Creating TmuxPaneTabComponent for pane %${paneId}`)
        const tab = this._tabsService.create({
            type: TmuxPaneTabComponent as any,
            inputs: {
                controller: this.controller,
                paneId,
            },
        }) as any as TmuxPaneTabComponent
        this.logger.info(`TmuxPaneTabComponent created for pane %${paneId}`)
        return tab
    }

    /**
     * Handle a new pane being added to a window (real-time from tmux).
     */
    private async handlePaneAdd(paneId: number, windowId: number): Promise<void> {
        if (!this.controller) return

        let paneMap = this.windowPaneTabs.get(windowId)
        if (!paneMap) {
            paneMap = new Map()
            this.windowPaneTabs.set(windowId, paneMap)
        }

        if (paneMap.has(paneId)) {
            this.logger.debug(`Pane %${paneId} already tracked for window @${windowId}`)
            return
        }

        // Create the pane tab using TabsService (proper Angular DI)
        const paneTab = this.createPaneTab(paneId)
        paneTab.controller = this.controller
        paneTab.paneId = paneId
        paneMap.set(paneId, paneTab)

        // If this pane belongs to the active window and view is ready, mount it
        if (windowId === this.activeWindowId && this._initialized) {
            const existingTabs = this.getAllTabs()
            this.logger.info(`Mounting new pane %${paneId} to active window @${windowId}, existing tabs: ${existingTabs.length}`)
            if (existingTabs.length === 0) {
                await this.addTab(paneTab as any, null, 'r')
            } else {
                await this.addTab(paneTab as any, existingTabs[existingTabs.length - 1] as any, 'r')
            }
            (paneTab as any).emitVisibility(true)
            (paneTab as any).emitFocused()

            // Re-sync layout
            const windowState = this.controller.getWindowState(windowId)
            if (windowState?.layout) {
                this.syncLayout(windowState.layout)
            }
            this.cdr.detectChanges()
        }
    }

    /**
     * Handle pane-update event (pane might have moved between windows).
     *
     * IMPORTANT: This method MUST NOT trigger switchToWindow or handlePaneAdd.
     * Doing so creates an infinite loop: pane-update → switchToWindow →
     * refreshPanes → pane-update → switchToWindow → ...
     *
     * Only handle panes already tracked in windowPaneTabs. Untracked panes
     * will be picked up by handlePaneAdd (from pane-add events) or
     * addPanesForWindow (from switchToWindow).
     */
    private handlePaneUpdate(paneId: number, windowId: number): void {
        // Find which window currently owns this pane in our map
        let currentWindowId: number | null = null
        for (const [wid, paneMap] of this.windowPaneTabs) {
            if (paneMap.has(paneId)) {
                currentWindowId = wid
                break
            }
        }

        if (currentWindowId === null) {
            // Pane not yet tracked — will be added via pane-add or switchToWindow
            return
        }

        if (currentWindowId === windowId) {
            // Same window — no action needed
            return
        }

        // Pane moved between windows — move the tab object
        this.logger.info(`Moving pane %${paneId} from window @${currentWindowId} to @${windowId}`)
        const oldPaneMap = this.windowPaneTabs.get(currentWindowId)!
        const paneTab = oldPaneMap.get(paneId)
        if (paneTab) {
            oldPaneMap.delete(paneId)
            let newPaneMap = this.windowPaneTabs.get(windowId)
            if (!newPaneMap) {
                newPaneMap = new Map()
                this.windowPaneTabs.set(windowId, newPaneMap)
            }
            newPaneMap.set(paneId, paneTab)

            // If it was in the active window, remove from SplitTab
            if (currentWindowId === this.activeWindowId) {
                (paneTab as any).emitVisibility(false)
                this.detachPaneView(paneTab as any)
            }
        }
    }

    /**
     * Handle a tmux window being closed.
     */
    private async handleWindowClose(windowId: number): Promise<void> {
        const paneMap = this.windowPaneTabs.get(windowId)
        if (paneMap) {
            // Destroy all pane tabs for this window
            for (const paneTab of paneMap.values()) {
                if (windowId === this.activeWindowId) {
                    (paneTab as any).emitVisibility(false)
                    this.detachPaneView(paneTab as any)
                }
                (paneTab as any).destroy()
            }
            this.windowPaneTabs.delete(windowId)
        }

        // If we just closed the active window, switch to another one
        if (windowId === this.activeWindowId) {
            this.activeWindowId = null
            const remainingWindows = Array.from(this.windowPaneTabs.keys())
            if (remainingWindows.length > 0) {
                await this.switchToWindow(remainingWindows[0])
            } else {
                // No windows left — reset
                this.root = new SplitContainer()
                this.root.orientation = 'h'
                this.layout()
                this.cdr.detectChanges()
            }
        }
    }

    /**
     * Synchronize SplitTab layout with tmux's layout string.
     */
    private syncLayout(layoutStr: string): void {
        const layoutTree = parseTmuxLayout(layoutStr)
        if (!layoutTree) {
            this.logger.warn('Failed to parse layout:', layoutStr)
            return
        }

        const panes = flattenLayout(layoutTree)
        this.logger.info(`Syncing layout for window @${this.activeWindowId}: ${panes.length} panes`)

        // Build the SplitContainer tree from the parsed layout
        const newRoot = this.buildSplitContainerFromLayout(layoutTree)
        if (newRoot instanceof SplitContainer) {
            this.root = newRoot
            this.layout()
        } else if (newRoot) {
            // Single pane — wrap in a container
            this.root = new SplitContainer()
            this.root.orientation = 'h'
            this.root.children.push(newRoot as any)
            this.root.ratios.push(1)
            this.layout()
        }

        // tmux is authoritative over each pane's character grid: push the exact
        // cell dimensions from the layout string into each xterm. This keeps
        // wrapping aligned with tmux and avoids any pixel-derived resize.
        this.applyLayoutGrids(layoutTree)
    }

    /**
     * Build a SplitContainer tree from a tmux layout node.
     */
    private buildSplitContainerFromLayout(node: TmuxLayoutNode): SplitContainer | TmuxPaneTabComponent | null {
        if (node.type === 'pane' && node.paneId !== undefined && this.activeWindowId !== null) {
            const paneMap = this.windowPaneTabs.get(this.activeWindowId)
            return paneMap?.get(node.paneId) || null
        }

        if (!node.children || node.children.length === 0) {
            return null
        }

        const container = new SplitContainer()
        container.orientation = node.type === 'horizontal' ? 'h' : 'v'

        const totalSize = node.type === 'horizontal'
            ? node.children.reduce((sum, c) => sum + c.width, 0)
            : node.children.reduce((sum, c) => sum + c.height, 0)

        for (const child of node.children) {
            const childComponent = this.buildSplitContainerFromLayout(child)
            if (childComponent) {
                container.children.push(childComponent as any)
                const ratio = totalSize > 0
                    ? (node.type === 'horizontal' ? child.width / totalSize : child.height / totalSize)
                    : 1 / node.children.length
                container.ratios.push(ratio)
            }
        }

        return container.children.length > 0 ? container : null
    }

    /**
     * Refresh tmux client size based purely on the container (.pane-area) size.
     *
     * This is the SINGLE source of truth for the overall client size and is the
     * key to avoiding the resize feedback loop:
     *
     *   - We compute the whole-window character grid from the .pane-area pixel
     *     size divided by the xterm cell size. This value depends only on the
     *     container, NOT on tmux's per-pane layout.
     *   - tmux receives this via `refresh-client -C` and decides how to split
     *     the grid among panes (sending %layout-change).
     *   - On %layout-change we set each pane's xterm grid explicitly
     *     (TmuxPaneTabComponent.setTmuxGrid) — panes never fit-to-pixels and
     *     never report a size back up.
     *
     * Because the result is derived from the (stable) container size, a tmux
     * relayout does not change it, so `_lastSentCols/Rows` dedup terminates the
     * loop after a single iteration.
     */
    private refreshClientSize(): void {
        if (!this.controller || !this._initialized) return
        if (this.activeWindowId === null) return

        const measured = this.measureClientSize()
        if (!measured) {
            // Cell size not available yet (no pane frontend mounted/rendered).
            // Retry shortly so the first real size still gets sent once a pane
            // has rendered its character grid — but only if panes are expected.
            const paneMap = this.windowPaneTabs.get(this.activeWindowId)
            if (paneMap && paneMap.size > 0) {
                this.scheduleRefreshClientSize()
            }
            return
        }

        const { cols, rows } = measured
        if (cols > 0 && rows > 0 &&
            (cols !== this._lastSentCols || rows !== this._lastSentRows)) {
            this._lastSentCols = cols
            this._lastSentRows = rows
            this.logger.info(`Setting tmux client size: ${cols}x${rows}`)
            this.controller.resizePane(0, cols, rows)
        }
    }

    /**
     * Apply the tmux-authoritative character grid to each mounted pane.
     *
     * tmux's layout string gives the exact width/height (in cells) of every
     * pane. We push those directly into the corresponding xterm so display
     * wrapping matches tmux exactly. xterm auto-fit is disabled for tmux panes,
     * so this is the only thing that sizes them.
     */
    private applyLayoutGrids(layoutTree: TmuxLayoutNode): void {
        if (this.activeWindowId === null) return
        const paneMap = this.windowPaneTabs.get(this.activeWindowId)
        if (!paneMap) return

        for (const pane of flattenLayout(layoutTree)) {
            const paneTab = paneMap.get(pane.paneId) as any
            if (paneTab?.setTmuxGrid) {
                paneTab.setTmuxGrid(pane.width, pane.height)
            }
        }
    }

    /**
     * Measure the whole-window character grid from the .pane-area container.
     *
     * The container width includes per-pane decorations (xterm scrollbar +
     * padding) and UI spanner dividers, none of which belong to the tmux
     * character grid. We subtract them, divide by the real xterm cell size,
     * then add tmux's 1-char dividers between panes so tmux's own grid lines up.
     */
    private measureClientSize(): { cols: number; rows: number } | null {
        const host = this.hostElement.nativeElement as HTMLElement
        const paneArea = host.querySelector('.pane-area') ?? host
        const rect = paneArea.getBoundingClientRect()
        if (rect.width < 10 || rect.height < 10) return null

        const cell = this.getCellSize()
        if (!cell) return null

        // Determine pane/split counts for the active window.
        const paneMap = this.activeWindowId !== null
            ? this.windowPaneTabs.get(this.activeWindowId)
            : null
        const paneCount = paneMap?.size ?? 1

        // UI spanner (split divider) pixel widths — 10px each (splitTabSpanner CSS).
        const spannerPx = this._spanners.length * 10
        // xterm renders a scrollbar/overview-ruler (~14px) + ~2px padding per pane.
        const decorationPxPerPane = 16
        const totalDecorationPx = paneCount * decorationPxPerPane

        const availableWidth = rect.width - spannerPx - totalDecorationPx
        const availableHeight = rect.height

        const contentCols = Math.floor(availableWidth / cell.width)
        const contentRows = Math.floor(availableHeight / cell.height)

        // tmux inserts a 1-char divider between adjacent panes; add them back so
        // the size we report covers content + dividers (tmux subtracts them again
        // when splitting). Approximate as a horizontal split (most common case).
        const numDividers = Math.max(0, paneCount - 1)
        const cols = contentCols + numDividers

        return {
            cols: Math.max(2, cols),
            rows: Math.max(1, contentRows),
        }
    }

    /**
     * Read the xterm character cell size (in CSS pixels) from any mounted pane.
     */
    private getCellSize(): { width: number; height: number } | null {
        for (const paneMap of this.windowPaneTabs.values()) {
            for (const paneTab of paneMap.values()) {
                const frontend = (paneTab as any).frontend
                const dims = frontend?.xtermCore?._renderService?.dimensions
                if (dims?.css?.cell?.width > 0 && dims?.css?.cell?.height > 0) {
                    return { width: dims.css.cell.width, height: dims.css.cell.height }
                }
            }
        }
        return null
    }
    /**
     * Debounced version of refreshClientSize.
     * Multiple sources (window resize, switchToWindow, layout-change) may
     * fire close together — debounce into one refresh-client -C call.
     */
    private scheduleRefreshClientSize(): void {
        if (this._resizeTimer) clearTimeout(this._resizeTimer)
        this._resizeTimer = setTimeout(() => {
            this._resizeTimer = null
            this.refreshClientSize()
        }, 150)
    }

    /**
     * Override onSpannerAdjusted to notify tmux of layout change.
     * When the user drags a spanner (split divider), the pane containers
     * resize and xterm.js auto-fits. We need to tell tmux the new client size
     * so it can recalculate its layout accordingly.
     */
    override onSpannerAdjusted(spanner: any): void {
        super.onSpannerAdjusted(spanner)
        this.scheduleRefreshClientSize()
    }

    // --- UI Event Handlers ---

    onDisconnect(): void {
        this.tmuxService.disconnect()
    }

    async onCreateWindow(): Promise<void> {
        if (this.controller) {
            const newWindowId = await this.controller.createWindow()
            if (newWindowId !== null) {
                await this.switchToWindow(newWindowId)
            }
        }
    }

    onToggleCollapse(collapsed: boolean): void {
        this.windowBarCollapsed = collapsed
        this.cdr.detectChanges()
    }

    override ngOnDestroy(): void {
        if (this.eventSubscription) {
            this.eventSubscription.unsubscribe()
        }
        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler)
            this._resizeHandler = null
        }
        if (this._paneAreaObserver) {
            this._paneAreaObserver.disconnect()
            this._paneAreaObserver = null
        }
        if (this._resizeTimer) {
            clearTimeout(this._resizeTimer)
            this._resizeTimer = null
        }
        super.ngOnDestroy()
    }

    override async canClose(): Promise<boolean> {
        return true
    }
}
