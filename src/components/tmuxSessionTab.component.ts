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
    private paneResizeSubscription: Subscription | null = null

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

        // Subscribe to pane display resize events.
        // Whenever any pane's xterm.js refits (due to container resize, window resize,
        // spanner drag, layout sync, etc.), we recalculate the total client size.
        this.paneResizeSubscription = this.controller.paneDisplayResized$.subscribe(() => {
            this.scheduleRefreshClientSize()
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
            // before creating panes so that capture-pane output is roughly correct.
            // The precise size will be sent automatically when panes mount and
            // their xterm.js fires resize (via paneDisplayResized$ subscription).
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

        // 6. Detect changes; precise client size refresh will happen
        //    automatically via paneDisplayResized$ when xterm.js fits to container.
        this.cdr.detectChanges()
    }

    /**
     * Override focus to NOT blur other pane tabs.
     * In tmux integration, all panes are visible simultaneously (split layout).
     * SplitTab's default focus() blurs all other tabs, which prevents their
     * xterm frontends from initializing.
     */
    override focus(tab: any): void {
        ;(this as any).focusedTab = tab
        tab.emitFocused()
        // DO NOT blur other tabs — they all need to remain initialized
        // to display their terminal content simultaneously.
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
     * Refresh tmux client size based on actual pane dimensions.
     *
     * Strategy (following iTerm2's variableTmuxSize algorithm):
     * 1. If panes have valid xterm dimensions: compute from the layout tree.
     *    - Sum character widths across horizontal splits + add tmux dividers (1 char each)
     *    - Sum character heights across vertical splits + add tmux dividers
     *    - This is the most accurate because xterm.cols/rows already accounts for
     *      scrollbar, padding, and all per-pane decorations.
     * 2. Fallback (before panes mount): pixel-based approximation from .pane-area.
     */
    private refreshClientSize(): void {
        if (!this.controller || !this._initialized) return
        if (this.activeWindowId === null) return

        let totalCols: number | null = null
        let totalRows: number | null = null

        // Try to compute from mounted panes + layout structure (most accurate)
        const fromLayout = this.computeClientSizeFromLayout()
        if (fromLayout) {
            totalCols = fromLayout.cols
            totalRows = fromLayout.rows
        }

        // Fallback: pixel-based measurement
        if (totalCols === null || totalRows === null) {
            const measured = this.measurePaneArea()
            if (!measured) return
            totalCols = measured.cols
            totalRows = measured.rows
        }

        if (totalCols > 0 && totalRows > 0 &&
            (totalCols !== this._lastSentCols || totalRows !== this._lastSentRows)) {
            this._lastSentCols = totalCols
            this._lastSentRows = totalRows
            this.logger.info(`Setting tmux client size: ${totalCols}x${totalRows}`)
            this.controller.resizePane(0, totalCols, totalRows)
        }
    }

    /**
     * Compute tmux client size from mounted panes' actual xterm dimensions.
     *
     * Uses the layout tree structure to correctly account for tmux dividers:
     * - Horizontal split: total_cols = sum(child_cols) + (num_children - 1)
     * - Vertical split: total_rows = sum(child_rows) + (num_children - 1)
     *
     * Falls back to summing all pane cols + dividers for simple layouts
     * when no layout tree is available.
     */
    private computeClientSizeFromLayout(): { cols: number; rows: number } | null {
        if (this.activeWindowId === null) return null
        const paneMap = this.windowPaneTabs.get(this.activeWindowId)
        if (!paneMap || paneMap.size === 0) return null

        // Check that all panes have valid xterm dimensions
        const paneDims = new Map<number, { cols: number; rows: number }>()
        for (const [paneId, paneTab] of paneMap) {
            const frontend = (paneTab as any).frontend
            if (!frontend?.xterm?.cols || frontend.xterm.cols <= 0 ||
                !frontend?.xterm?.rows || frontend.xterm.rows <= 0) {
                // Not all panes ready yet
                return null
            }
            paneDims.set(paneId, {
                cols: frontend.xterm.cols,
                rows: frontend.xterm.rows,
            })
        }

        // Single pane: trivial
        if (paneDims.size === 1) {
            const dim = paneDims.values().next().value
            return { cols: dim.cols, rows: dim.rows }
        }

        // Multi-pane: use the layout tree if available
        const windowState = this.controller?.getWindowState(this.activeWindowId)
        if (windowState?.layout) {
            const layoutTree = parseTmuxLayout(windowState.layout)
            if (layoutTree) {
                const computed = this.computeSizeFromNode(layoutTree, paneDims)
                if (computed) return computed
            }
        }

        // Fallback for multi-pane without layout tree:
        // Assume a simple horizontal split (most common)
        let sumCols = 0
        let maxRows = 0
        for (const dim of paneDims.values()) {
            sumCols += dim.cols
            if (dim.rows > maxRows) maxRows = dim.rows
        }
        // Add tmux dividers: (numPanes - 1) vertical dividers, each 1 char wide
        const clientCols = sumCols + (paneDims.size - 1)
        return { cols: clientCols, rows: maxRows }
    }

    /**
     * Recursively compute tmux window size from a layout tree node.
     * For each container, sums children dimensions along split axis and
     * adds 1-char tmux dividers between children.
     */
    private computeSizeFromNode(
        node: TmuxLayoutNode,
        paneDims: Map<number, { cols: number; rows: number }>
    ): { cols: number; rows: number } | null {
        if (node.type === 'pane' && node.paneId !== undefined) {
            const dim = paneDims.get(node.paneId)
            return dim || null
        }

        if (!node.children || node.children.length === 0) return null

        const childSizes: { cols: number; rows: number }[] = []
        for (const child of node.children) {
            const size = this.computeSizeFromNode(child, paneDims)
            if (!size) return null
            childSizes.push(size)
        }

        const numDividers = childSizes.length - 1

        if (node.type === 'horizontal') {
            // Children side by side: sum widths + dividers, take max height
            const totalCols = childSizes.reduce((s, c) => s + c.cols, 0) + numDividers
            const totalRows = Math.min(...childSizes.map(c => c.rows))
            return { cols: totalCols, rows: totalRows }
        } else {
            // Vertical: children stacked: take max width, sum heights + dividers
            const totalCols = Math.min(...childSizes.map(c => c.cols))
            const totalRows = childSizes.reduce((s, c) => s + c.rows, 0) + numDividers
            return { cols: totalCols, rows: totalRows }
        }
    }

    /**
     * Pixel-based fallback for measuring client size before panes mount.
     * Less accurate than xterm-based computation but provides an initial estimate.
     *
     * Accounts for:
     * - Spanner (UI divider) pixel widths (10px each)
     * - Per-pane scrollbar width (~14px per pane, estimated)
     * - Tmux character dividers (+1 per split)
     */
    private measurePaneArea(): { cols: number; rows: number } | null {
        const host = this.hostElement.nativeElement as HTMLElement
        const paneArea = host.querySelector('.pane-area') ?? host
        const rect = paneArea.getBoundingClientRect()
        if (rect.width < 10 || rect.height < 10) return null

        // Read char cell size from any mounted pane's xterm
        let cellW = 0
        let cellH = 0
        for (const paneMap of this.windowPaneTabs.values()) {
            for (const paneTab of paneMap.values()) {
                const frontend = (paneTab as any).frontend
                if (!frontend?.xtermCore) continue
                const dims = frontend.xtermCore?._renderService?.dimensions
                if (dims?.css?.cell?.width > 0 && dims?.css?.cell?.height > 0) {
                    cellW = dims.css.cell.width
                    cellH = dims.css.cell.height
                    break
                }
                // Fallback: compute from xterm element
                const xtermEl = frontend.xtermCore.element as HTMLElement | undefined
                if (xtermEl && frontend.xterm.cols > 0 && frontend.xterm.rows > 0) {
                    const r = xtermEl.getBoundingClientRect()
                    if (r.width > 0 && r.height > 0) {
                        cellW = r.width / frontend.xterm.cols
                        cellH = r.height / frontend.xterm.rows
                        break
                    }
                }
            }
            if (cellW > 0) break
        }

        // Fallback: default xterm cell size (conservative)
        if (cellW <= 0) cellW = 9
        if (cellH <= 0) cellH = 17

        // Determine number of panes and splits for the active window
        const paneMap = this.activeWindowId !== null
            ? this.windowPaneTabs.get(this.activeWindowId)
            : null
        const paneCount = paneMap?.size ?? 1

        // UI spanner pixel widths (10px each, from splitTabSpanner CSS)
        const spannerPx = this._spanners.length * 10
        // Estimated per-pane scrollbar width (xterm.js renders a scrollbar)
        const scrollbarPxPerPane = 14
        const totalScrollbarPx = paneCount * scrollbarPxPerPane

        // Available pixels for character content
        const availableWidth = rect.width - spannerPx - totalScrollbarPx
        const availableHeight = rect.height

        // Character cells that fit in the available space
        const contentCols = Math.floor(availableWidth / cellW)
        const contentRows = Math.floor(availableHeight / cellH)

        // Add tmux dividers: for N panes in a row, tmux uses N-1 dividers (1 char each)
        // For the approximate case, assume horizontal split
        const numDividers = Math.max(0, paneCount - 1)
        const clientCols = contentCols + numDividers

        return {
            cols: Math.max(2, clientCols),
            rows: Math.max(1, contentRows),
        }
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
        if (this.paneResizeSubscription) {
            this.paneResizeSubscription.unsubscribe()
        }
        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler)
            this._resizeHandler = null
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
