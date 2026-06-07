import { Component, Injector, Input, OnInit, OnDestroy, ChangeDetectorRef, ElementRef } from '@angular/core'
import { Subscription } from 'rxjs'
import { SplitTabComponent, SplitContainer, LogService, Logger, TabsService, HotkeysService, GetRecoveryTokenOptions, RecoveryToken } from 'tabby-core'
import { TabRecoveryService } from 'tabby-core'
import { TmuxController } from '../session'
import { TmuxService } from '../services/tmux.service'
import { TmuxPaneTabComponent } from './tmuxPaneTab.component'
import { parseTmuxLayout, TmuxLayoutNode, flattenLayout } from '../layoutParser'

/** A draggable divider derived from the tmux layout tree */
interface TmuxDivider {
    /** 'h' = horizontal bar (splits top/bottom), 'v' = vertical bar (splits left/right) */
    orientation: 'h' | 'v'
    /** Pixel position relative to .pane-area (computed from tmux cell coords) */
    xPx: number
    yPx: number
    wPx: number
    hPx: number
}

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
        <div class="pane-area" #paneAreaEl>
            <ng-container #vc></ng-container>
        </div>
        <tmux-window-bar
            [controller]="controller"
            [activeWindowId]="activeWindowId"
            (windowSwitch)="switchToWindow($event)"
            (windowClose)="onWindowClose($event)"
            (disconnect)="onDisconnect()"
            (createWindow)="onCreateWindow()"
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
        /* SplitTab.layoutInternal() positions .child with inline left/top/width/height %.
           border-right + border-bottom render the tmux pane separator line.
           box-sizing: border-box keeps the border inside the layout box so
           xterm content is not displaced.
           The border area also serves as the resize drag handle (see onPaneAreaMouseDown). */
        ::ng-deep .pane-area > .child {
            position: absolute;
            transition: 0.125s all;
            opacity: .75;
            box-sizing: border-box;
            border-right: 1px solid rgba(128,128,128,0.3);
            border-bottom: 1px solid rgba(128,128,128,0.3);
        }
        ::ng-deep .pane-area > .child.focused {
            opacity: 1;
        }
        /*
         * Transparent hit-target overlays at the right/bottom edges.
         * xterm renders a scrollbar (~14px wide) that intercepts mouse events,
         * preventing the pane-area mousemove handler from detecting border
         * proximity.  These ::after pseudo-elements sit above the scrollbar
         * (z-index: 10) and capture events for resize dragging.
         */
        ::ng-deep .pane-area > .child::after {
            content: '';
            position: absolute;
            top: 0;
            right: 0;
            width: 10px;
            height: 100%;
            z-index: 10;
            pointer-events: auto;
            cursor: col-resize;
        }
        ::ng-deep .pane-area > .child::before {
            content: '';
            position: absolute;
            bottom: 0;
            left: 0;
            width: 100%;
            height: 10px;
            z-index: 10;
            pointer-events: auto;
            cursor: row-resize;
        }
        /* Highlight the border when hovering near the right/bottom edge */
        ::ng-deep .pane-area > .child.border-hover-right {
            border-right-color: rgba(128,128,128,0.75);
        }
        ::ng-deep .pane-area > .child.border-hover-bottom {
            border-bottom-color: rgba(128,128,128,0.75);
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

    /** Queue for serializing async event processing */
    private eventQueue: Promise<void> = Promise.resolve()

    controller: TmuxController | null = null
    activeWindowId: number | null = null
    connected = false
    sessionName = ''
    private _initialized = false
    private _tabsService: TabsService
    private _resizeHandler: (() => void) | null = null
    private _resizeTimer: any = null
    private _paneAreaObserver: ResizeObserver | null = null
    /** Last dimensions sent to tmux, for dedup */
    private _lastSentCols = 0
    private _lastSentRows = 0

    /** Custom tmux pane dividers — kept for interface compatibility but not rendered */
    _tmuxDividers: TmuxDivider[] = []
    /** mousedown handler attached to .pane-area for border drag detection */
    private _paneAreaMouseDownHandler: ((e: MouseEvent) => void) | null = null
    /** mousemove handler for border hover highlight */
    private _paneAreaMouseMoveHandler: ((e: MouseEvent) => void) | null = null

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

        // Subscribe to controller events.
        // Events are queued to ensure serial async processing — critical because
        // handleControllerEvent contains async operations (switchToWindow, syncLayout)
        // that must not interleave. Without serialization, concurrent switches from
        // multiple window-add events (during refreshPanes) corrupt activeWindowId.
        this.eventSubscription = this.controller.events.subscribe(event => {
            this.eventQueue = this.eventQueue.then(() => this.handleControllerEvent(event))
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

            // Wait for all queued events (window-add, pane-add) from refreshPanes
            // to be processed before switching to the first window.
            await this.eventQueue

            // Prefer the tmux-side active window (from list-windows #{window_active}
            // or %session-window-changed). Fall back to the first window in the map.
            const activeWindowId = this.controller!.getActiveWindowId()
            const targetWindowId = (activeWindowId !== null && this.windowPaneTabs.has(activeWindowId))
                ? activeWindowId
                : this.controller!.getFirstWindowId()
            if (targetWindowId !== undefined) {
                await this.switchToWindow(targetWindowId)
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

            // Attach border hover + drag handlers to the pane-area
            this.attachPaneAreaBorderHandlers()

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
        // This is critical: discoverWindowsAndPanes() emits window-add and pane-add
        // during the first call (triggered by session-changed), but the SessionTab
        // component may not exist yet. By the time ngOnInit runs, the controller
        // already knows about all windows and panes — we must create pane tabs
        // here so switchToWindow finds non-empty paneMaps.
        for (const windowState of this.controller.getAllWindowStates()) {
            if (!this.windowPaneTabs.has(windowState.id)) {
                this.windowPaneTabs.set(windowState.id, new Map())
            }
            // Create pane tabs for all panes the controller already knows about
            const paneMap = this.windowPaneTabs.get(windowState.id)!
            const ctrlWindowState = this.controller.getWindowState(windowState.id)
            if (ctrlWindowState) {
                for (const paneId of ctrlWindowState.panes) {
                    if (!paneMap.has(paneId)) {
                        this.logger.info(`Bootstrap: creating pane tab for %${paneId} in window @${windowState.id}`)
                        const paneTab = this.createPaneTab(paneId)
                        paneTab.controller = this.controller
                        paneTab.paneId = paneId
                        paneMap.set(paneId, paneTab)
                    }
                }
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
                    const isNewWindow = !this.windowPaneTabs.has(event.windowId)
                    // Ensure the window has an entry in our map
                    if (isNewWindow) {
                        this.logger.info(`Adding new window @${event.windowId} to map`)
                        this.windowPaneTabs.set(event.windowId, new Map())
                    }
                    // Switch to a new window if:
                    // 1. No active window yet (initial attach), OR
                    // 2. This is a genuinely new window created after attach
                    //    AND we are past the initial bootstrap phase.
                    //    During batch discovery, we defer switching to ngAfterViewInit.
                    //
                    // MUST await: switchToWindow is async and rebuilds the SplitContainer
                    // tree. Without await, concurrent switches from multiple window-add
                    // events (during refreshPanes) interleave and corrupt activeWindowId.
                    if (this._initialized && this.activeWindowId === null) {
                        this.logger.info(`Switching to first window @${event.windowId}`)
                        await this.switchToWindow(event.windowId)
                    } else if (this._initialized && isNewWindow && this.activeWindowId !== null) {
                        // Runtime window creation (after initial attach)
                        this.logger.info(`Switching to new runtime window @${event.windowId}`)
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

            case 'pane-close':
                if (event.paneId !== undefined && event.windowId !== undefined) {
                    this.logger.info(`Handling pane-close event: pane=${event.paneId}, window=${event.windowId}`)
                    this.handlePaneClose(event.paneId, event.windowId)
                }
                break

            case 'layout-change':
                // NOTE: We always call syncLayout for the active window.
                // For non-active windows, we save the layout but don't rebuild
                // the tree (it will be rebuilt when the user switches to it).
                if (event.windowId !== undefined && event.data?.layout) {
                    if (event.windowId === this.activeWindowId) {
                        this.logger.info(`Syncing layout for active window @${event.windowId}`)
                        await this.syncLayout(event.data.layout)
                    } else {
                        this.logger.info(`Layout changed for inactive window @${event.windowId}, saved for next switch`)
                    }
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

        // Clear dividers while switching windows
        this._tmuxDividers = []

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
            // First time visiting this window. Pane tabs will be created by
            // handlePaneAdd (triggered by discoverPanesFromLayout on
            // %layout-change). We don't call addPanesForWindow — panes are
            // discovered asynchronously (iTerm2-style).
            //
            // HOWEVER: if the controller already knows the layout for this
            // window (from batch discovery during attach), we can proactively
            // discover panes from it instead of waiting for a layout-change
            // event that may never come (tmux doesn't re-send layout-change
            // for windows that haven't changed).
            const windowState = this.controller?.getWindowState(windowId)
            if (windowState?.layout) {
                this.logger.info(`No pane tabs yet for window @${windowId}, but layout is known — discovering panes proactively`)
                // Extract pane IDs from the known layout and create pane tabs
                const { parseTmuxLayout, flattenLayout } = await import('../layoutParser')
                const layoutTree = parseTmuxLayout(windowState.layout)
                if (layoutTree) {
                    for (const pane of flattenLayout(layoutTree)) {
                        if (!paneMap.has(pane.paneId)) {
                            this.logger.info(`Proactively creating pane tab for %${pane.paneId} in window @${windowId}`)
                            const paneTab = this.createPaneTab(pane.paneId)
                            paneTab.controller = this.controller!
                            paneTab.paneId = pane.paneId
                            paneMap.set(pane.paneId, paneTab)
                        }
                    }
                }
            } else {
                this.logger.info(`No pane tabs yet for window @${windowId}, waiting for pane-add events`)
            }
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
                await this.syncLayout(windowState.layout)
            }
        }

        // 6. Detect changes; precise client size refresh happens via the
        //    .pane-area ResizeObserver once xterm renders its cell grid.
        this.cdr.detectChanges()

        // 7. Push the correct client size to tmux once panes are mounted.
        //    We use requestAnimationFrame to wait for xterm to render its
        //    character grid (getCellSize needs real cell dimensions), then
        //    force a non-deduplicated refresh-client -C.
        if (paneTabs.length > 0) {
            requestAnimationFrame(() => {
                // Reset dedup so the next call always goes through
                this._lastSentCols = 0
                this._lastSentRows = 0
                this.refreshClientSize()
            })
        }
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
     *
     * NOTE: We do NOT call addTab here. Instead, we just register the pane in
     * the map and let syncLayout (called from the %layout-change event that
     * tmux sends alongside new-pane creation) build the correct tree.
     * Calling addTab with a fixed direction ('r') would create a wrong tree
     * structure that syncLayout then has to undo — and the async view
     * attachment inside addTab races with syncLayout, leaving panes invisible.
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

        // Create the pane tab and register it — the actual tree mounting
        // happens when syncLayout runs from the %layout-change event.
        const paneTab = this.createPaneTab(paneId)
        paneTab.controller = this.controller
        paneTab.paneId = paneId
        paneMap.set(paneId, paneTab)
        this.logger.info(`Registered new pane %${paneId} for window @${windowId}, awaiting layout sync`)
    }

    /**
     * Handle pane-update event (pane might have moved between windows).
     *
     * IMPORTANT: This method MUST NOT trigger switchToWindow or handlePaneAdd.
     * Doing so creates an infinite loop: pane-update → switchToWindow →
     * refreshPanes → pane-update → switchToWindow → ...
     *
     * Only handle panes already tracked in windowPaneTabs. Untracked panes
     * will be picked up by handlePaneAdd (from pane-add events triggered
     * by discoverPanesFromLayout on %layout-change).
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
     *
     * This is the SINGLE place where the SplitTab tree is built.
     * It creates missing pane tabs, attaches their views, cleans up stale
     * panes, and rebuilds the entire tree from the tmux layout string.
     */
    private async syncLayout(layoutStr: string): Promise<void> {
        const layoutTree = parseTmuxLayout(layoutStr)
        if (!layoutTree) {
            this.logger.warn('Failed to parse layout:', layoutStr)
            return
        }

        const panes = flattenLayout(layoutTree)
        this.logger.info(`Syncing layout for window @${this.activeWindowId}: ${panes.length} panes`)

        // Ensure pane tabs exist and have attached views for every pane in
        // the layout. New panes (from split-window) are registered by
        // handlePaneAdd but have no view yet — we call addTab to create one.
        if (this.activeWindowId !== null) {
            let paneMap = this.windowPaneTabs.get(this.activeWindowId)
            if (!paneMap) {
                paneMap = new Map()
                this.windowPaneTabs.set(this.activeWindowId, paneMap)
            }
            for (const pane of panes) {
                if (!paneMap.has(pane.paneId)) {
                    this.logger.info(`Creating pane tab for %${pane.paneId} during layout sync`)
                    const paneTab = this.createPaneTab(pane.paneId)
                    paneTab.controller = this.controller!
                    paneTab.paneId = pane.paneId
                    paneMap.set(pane.paneId, paneTab)
                }
            }

            // Attach views for panes that don't have one yet.
            // The tree structure will be rebuilt below, so the addTab direction
            // doesn't matter — we just need the view to exist.
            for (const pane of panes) {
                const paneTab = paneMap.get(pane.paneId)!
                if (!(this as any).viewRefs?.has(paneTab)) {
                    this.logger.info(`Attaching view for pane %${pane.paneId}`)
                    const existingTabs = this.getAllTabs()
                    if (existingTabs.length === 0) {
                        await this.addTab(paneTab as any, null, 'r')
                    } else {
                        await this.addTab(paneTab as any, existingTabs[existingTabs.length - 1] as any, 'r')
                    }
                    ;(paneTab as any).emitVisibility(true)
                    ;(paneTab as any).emitFocused()
                }
            }
        }

        // Detect and clean up stale pane tabs that are no longer in the layout.
        // When tmux closes a pane, the %layout-change notification omits it.
        // We remove the corresponding tab so the UI stays consistent.
        if (this.activeWindowId !== null) {
            const paneMap = this.windowPaneTabs.get(this.activeWindowId)
            if (paneMap) {
                const layoutPaneIds = new Set(panes.map(p => p.paneId))
                for (const [paneId, paneTab] of paneMap) {
                    if (!layoutPaneIds.has(paneId)) {
                        this.logger.info(`Pane %${paneId} no longer in layout, cleaning up`)
                        paneMap.delete(paneId)
                        ;(paneTab as any).emitVisibility(false)
                        this.detachPaneView(paneTab as any)
                        ;(paneTab as any).destroy()
                    }
                }
            }
        }

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

        this.cdr.detectChanges()

        // tmux is authoritative over each pane's character grid: push the exact
        // cell dimensions from the layout string into each xterm. This keeps
        // wrapping aligned with tmux and avoids any pixel-derived resize.
        this.applyLayoutGrids(layoutTree)
    }

    /**
     * Handle a pane being closed (from %pane-close event or manual cleanup).
     */
    private handlePaneClose(paneId: number, windowId: number): void {
        const paneMap = this.windowPaneTabs.get(windowId)
        if (!paneMap) return

        const paneTab = paneMap.get(paneId)
        if (!paneTab) return

        this.logger.info(`Cleaning up closed pane %${paneId} in window @${windowId}`)
        paneMap.delete(paneId)

        if (windowId === this.activeWindowId) {
            ;(paneTab as any).emitVisibility(false)
            this.detachPaneView(paneTab as any)
            this.layout()
            this.cdr.detectChanges()
        }
        ;(paneTab as any).destroy()
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

        // UI spanner pixel widths: tabby's split-tab-spanner is 10px each.
        // Our custom tmux dividers are purely visual overlays with no pixel cost.
        // _spanners is still populated by layoutInternal() for tabby's internal
        // bookkeeping, but we no longer render split-tab-spanner elements, so
        // their pixel width should not be subtracted here.
        const spannerPx = 0
        // Per-pane visual padding defined in tmuxPaneTab.component.scss.
        // Each pane has 4px on all sides (8px total per axis).
        // For N panes in a row: total horizontal padding = N * 8px.
        // For N panes in a column: total vertical padding = N * 8px.
        // Approximate as all panes contributing to both axes (safe overestimate).
        const panePadPerAxis = 8
        const totalPadPx = paneCount * panePadPerAxis

        const availableWidth = rect.width - spannerPx - totalPadPx
        const availableHeight = rect.height - totalPadPx

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

    // ─── Border-based pane separator ────────────────────────────────────────

    /** Pixels from the right/bottom edge of a .child that counts as "on border" */
    private static readonly BORDER_HIT = 10

    /**
     * Attach mousemove + mousedown handlers to .pane-area so that hovering
     * near a .child's right/bottom border highlights it, and dragging starts
     * a tmux resize-pane operation.
     */
    private attachPaneAreaBorderHandlers(): void {
        const host = this.hostElement.nativeElement as HTMLElement
        const paneArea = host.querySelector('.pane-area') as HTMLElement | null
        if (!paneArea) return

        const HIT = TmuxSessionTabComponent.BORDER_HIT

        // Track which child + edge is currently hovered
        let hoveredChild: Element | null = null
        let hoveredEdge: 'right' | 'bottom' | null = null

        const clearHover = () => {
            if (hoveredChild) {
                hoveredChild.classList.remove('border-hover-right', 'border-hover-bottom')
            }
            hoveredChild = null
            hoveredEdge = null
            paneArea.style.cursor = ''
        }

        const onMove = (e: MouseEvent) => {
            const areaRect = paneArea.getBoundingClientRect()
            const mx = e.clientX - areaRect.left
            const my = e.clientY - areaRect.top

            // Find a .child whose right or bottom border is within HIT pixels
            clearHover()
            const children = paneArea.querySelectorAll('.child')
            for (const child of Array.from(children)) {
                const el = child as HTMLElement
                const r = el.getBoundingClientRect()
                const right = r.right - areaRect.left
                const bottom = r.bottom - areaRect.top
                const left = r.left - areaRect.left
                const top = r.top - areaRect.top

                // Right border hit: within HIT of right edge, vertically inside
                if (Math.abs(mx - right) <= HIT && my >= top && my <= bottom) {
                    el.classList.add('border-hover-right')
                    paneArea.style.cursor = 'col-resize'
                    hoveredChild = el
                    hoveredEdge = 'right'
                    break
                }
                // Bottom border hit: within HIT of bottom edge, horizontally inside
                if (Math.abs(my - bottom) <= HIT && mx >= left && mx <= right) {
                    el.classList.add('border-hover-bottom')
                    paneArea.style.cursor = 'row-resize'
                    hoveredChild = el
                    hoveredEdge = 'bottom'
                    break
                }
            }
        }

        const onDown = (e: MouseEvent) => {
            if (!hoveredChild || !hoveredEdge || !this.controller) return
            e.preventDefault()
            e.stopPropagation()

            const edge = hoveredEdge
            const cell = this.getCellSize()
            if (!cell) return

            const startX = e.clientX
            const startY = e.clientY

            // Find the pane ID for this .child element
            const resizeTarget = hoveredChild
            const paneId = this.findPaneIdForElement(resizeTarget)
            if (paneId === null) return

            // Track last sent delta to send incremental resize commands
            let lastSentCols = 0
            let lastSentRows = 0

            const onDragMove = (de: MouseEvent) => {
                document.body.style.cursor = edge === 'right' ? 'col-resize' : 'row-resize'

                if (edge === 'right') {
                    const deltaCols = Math.round((de.clientX - startX) / cell.width)
                    if (deltaCols !== lastSentCols) {
                        const diff = deltaCols - lastSentCols
                        const flag = diff > 0 ? '-R' : '-L'
                        this.controller!.gateway.sendCommand(
                            `resize-pane ${flag} -t %${paneId} ${Math.abs(diff)}`
                        )
                        lastSentCols = deltaCols
                    }
                } else {
                    const deltaRows = Math.round((de.clientY - startY) / cell.height)
                    if (deltaRows !== lastSentRows) {
                        const diff = deltaRows - lastSentRows
                        const flag = diff > 0 ? '-D' : '-U'
                        this.controller!.gateway.sendCommand(
                            `resize-pane ${flag} -t %${paneId} ${Math.abs(diff)}`
                        )
                        lastSentRows = deltaRows
                    }
                }
            }

            const onDragUp = () => {
                document.removeEventListener('mousemove', onDragMove)
                document.removeEventListener('mouseup', onDragUp)
                document.body.style.cursor = ''
                clearHover()
            }

            document.addEventListener('mousemove', onDragMove)
            document.addEventListener('mouseup', onDragUp)
        }

        const onLeave = () => clearHover()

        this._paneAreaMouseMoveHandler = onMove
        this._paneAreaMouseDownHandler = onDown
        paneArea.addEventListener('mousemove', onMove)
        paneArea.addEventListener('mousedown', onDown)
        paneArea.addEventListener('mouseleave', onLeave)
    }

    private detachPaneAreaBorderHandlers(): void {
        const host = this.hostElement.nativeElement as HTMLElement
        const paneArea = host.querySelector('.pane-area') as HTMLElement | null
        if (!paneArea) return
        if (this._paneAreaMouseMoveHandler) {
            paneArea.removeEventListener('mousemove', this._paneAreaMouseMoveHandler)
            this._paneAreaMouseMoveHandler = null
        }
        if (this._paneAreaMouseDownHandler) {
            paneArea.removeEventListener('mousedown', this._paneAreaMouseDownHandler)
            this._paneAreaMouseDownHandler = null
        }
    }

    /**
     * Map a .child DOM element back to the tmux pane ID it represents.
     */
    private findPaneIdForElement(el: Element): number | null {
        if (this.activeWindowId === null) return null
        const paneMap = this.windowPaneTabs.get(this.activeWindowId)
        if (!paneMap) return null
        for (const [paneId, paneTab] of paneMap) {
            const tabEl = (paneTab as any).hostElement?.nativeElement
                ?? (paneTab as any).element?.nativeElement
            if (tabEl && (tabEl === el || tabEl.contains(el) || el.contains(tabEl))) {
                return paneId
            }
        }
        return null
    }

    // ─── (legacy divider stubs removed) ─────────────────────────────────────

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
        const ctx = this.tmuxService.findContextForTab(this)
        if (ctx) {
            this.tmuxService.disconnectContext(ctx)
        }
    }

    async onWindowClose(windowId: number): Promise<void> {
        if (this.controller) {
            await this.controller.killWindow(windowId)
        }
    }

    async onCreateWindow(): Promise<void> {
        if (this.controller) {
            const newWindowId = await this.controller.createWindow()
            if (newWindowId !== null) {
                await this.switchToWindow(newWindowId)
            }
        }
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
        this.detachPaneAreaBorderHandlers()
        super.ngOnDestroy()
    }

    override async canClose(): Promise<boolean> {
        return true
    }

    /**
     * Override recovery to delegate to the hidden host tab.
     *
     * When Tabby saves tabs on exit, the original terminal tab (topmostTab)
     * is hidden from app.tabs and would be lost. Instead of persisting the
     * tmux session tab (which cannot be meaningfully restored), we return
     * the host tab's recovery token so Tabby restores the pre-tmux terminal.
     * The tmux session remains alive in the background and can be re-attached.
     */
    override async getRecoveryToken (options?: GetRecoveryTokenOptions): Promise<RecoveryToken|null> {
        const ctx = this.tmuxService.findContextForTab(this)
        if (ctx?.topmostTab) {
            return ctx.topmostTab.getRecoveryToken(options)
        }
        return null
    }
}
