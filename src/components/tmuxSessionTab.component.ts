import { Component, Injector, Input, OnInit, OnDestroy, ChangeDetectorRef, ElementRef } from '@angular/core'
import { Subscription } from 'rxjs'
import { SplitTabComponent, SplitContainer, LogService, Logger, TabsService, HotkeysService, GetRecoveryTokenOptions, RecoveryToken, ConfigService } from 'tabby-core'
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
 * Layout is pixel-absolute: pane positions are computed from tmux's character
 * coordinates × cell pixel size, NOT from SplitTab's ratio-based percentage
 * layout. The SplitContainer tree is only used by addTab()/removeTab() for
 * ViewContainerRef management.
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
            padding: 4px;
            box-sizing: border-box;
        }
        /* Pane containers: pixel-absolute positioned by applyPixelLayout().
           No border, no padding — the xterm canvas fills the entire box. */
        ::ng-deep .pane-area > .child {
            position: absolute;
            box-sizing: border-box;
            opacity: .75;
            transition: opacity 0.125s;
        }
        ::ng-deep .pane-area > .child.focused {
            opacity: 1;
        }
        /* Independent divider elements for pane boundaries + resize dragging.
           Width/height is set inline to 1 cell to match tmux's 1-char separator.
           The visible line is a 1px ::after pseudo-element centered in the hit area. */
        ::ng-deep .tmux-divider {
            position: absolute;
            z-index: 5;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        ::ng-deep .tmux-divider::after {
            content: '';
            background: rgba(128,128,128,0.3);
            transition: background 0.15s;
        }
        ::ng-deep .tmux-divider:hover::after {
            background: rgba(128,128,128,0.75);
        }
        ::ng-deep .tmux-divider.v {   /* vertical divider: left-right split */
            cursor: col-resize;
        }
        ::ng-deep .tmux-divider.v::after {
            width: 1px;
            height: 100%;
        }
        ::ng-deep .tmux-divider.h {   /* horizontal divider: top-bottom split */
            cursor: row-resize;
        }
        ::ng-deep .tmux-divider.h::after {
            height: 1px;
            width: 100%;
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

    /** Active divider DOM elements for the current window layout */
    private _dividerElements: HTMLElement[] = []

    constructor(
        injector: Injector,
        private tmuxService: TmuxService,
        private configService: ConfigService,
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

            // ── Step A: Push client size FIRST ──
            // tmux may start with stale client size from the previous attach.
            // Tell tmux our actual size before discovering panes, so the
            // layout-change events carry coordinates matching our window.
            this.refreshClientSize()
            await this.eventQueue

            // ── Step B: Pane discovery (now based on correct size) ──
            await this.controller!.refreshPanes()
            this.bootstrapFromControllerState()
            await this.eventQueue

            const activeWindowId = this.controller!.getActiveWindowId()
            const targetWindowId = (activeWindowId !== null && this.windowPaneTabs.has(activeWindowId))
                ? activeWindowId
                : this.controller!.getFirstWindowId()
            if (targetWindowId !== undefined) {
                await this.switchToWindow(targetWindowId)
            }

            // ── Step C: ResizeObserver + window resize ──
            this._resizeHandler = () => this.scheduleRefreshClientSize()
            window.addEventListener('resize', this._resizeHandler)

            const host = this.hostElement.nativeElement as HTMLElement
            const paneArea = host.querySelector('.pane-area')
            if (paneArea && typeof ResizeObserver !== 'undefined') {
                this._paneAreaObserver = new ResizeObserver(() => this.scheduleRefreshClientSize())
                this._paneAreaObserver.observe(paneArea)
            }
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
        this.clearDividers()

        // 1. Detach current active window's pane views
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
            const windowState = this.controller?.getWindowState(windowId)
            if (windowState?.layout) {
                this.logger.info(`No pane tabs yet for window @${windowId}, but layout is known — discovering panes proactively`)
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

        // 4. Attach views for all pane tabs
        // Reset root tree so addTab() registers panes into a clean structure.
        // We don't rely on the tree for layout (applyPixelLayout does that),
        // but addTab() needs a valid root to attach ViewContainerRefs.
        this.root = new SplitContainer()
        this.root.orientation = 'h'

        const paneTabs = Array.from(paneMap.values())
        if (paneTabs.length > 0) {
            for (const paneTab of paneTabs) {
                if (!(this as any).viewRefs?.has(paneTab)) {
                    await this.addTab(paneTab as any, null, 'r')
                }
                ;(paneTab as any).emitVisibility(true)
                ;(paneTab as any).emitFocused()
            }

            // 5. Apply pixel layout from tmux
            const windowState = this.controller?.getWindowState(windowId)
            if (windowState?.layout) {
                const layoutTree = parseTmuxLayout(windowState.layout)
                if (layoutTree) {
                    this.applyPixelLayout(layoutTree)
                    this.updateDividers(layoutTree)
                }
            }
        }

        // 6. Detect changes and push size
        this.cdr.detectChanges()

        if (paneTabs.length > 0) {
            requestAnimationFrame(() => {
                this._lastSentCols = 0
                this._lastSentRows = 0
                this.refreshClientSize()
            })
        }
    }

    /**
     * Override layout() to no-op. SplitTab's layoutInternal() uses percentage
     * positioning which conflicts with our pixel-absolute layout. Pane
     * positioning is handled exclusively by applyPixelLayout().
     */
    override layout(): void {
        // Intentionally empty — pixel-absolute layout replaces SplitTab layout.
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
                // No windows left — clear dividers
                this.clearDividers()
                this.cdr.detectChanges()
            }
        }
    }

    /**
     * Synchronize layout with tmux's layout string.
     *
     * Creates missing pane tabs, attaches their views, cleans up stale
     * panes, and positions everything via pixel-absolute layout.
     */
    private async syncLayout(layoutStr: string): Promise<void> {
        const layoutTree = parseTmuxLayout(layoutStr)
        if (!layoutTree) {
            this.logger.warn('Failed to parse layout:', layoutStr)
            return
        }

        const panes = flattenLayout(layoutTree)
        this.logger.info(`Syncing layout for window @${this.activeWindowId}: ${panes.length} panes`)

        // Ensure pane tabs exist and have attached views
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
            // Ensure root exists for addTab to register ViewContainerRefs.
            if (!(this.root instanceof SplitContainer)) {
                this.root = new SplitContainer()
                this.root.orientation = 'h'
            }
            for (const pane of panes) {
                const paneTab = paneMap.get(pane.paneId)!
                if (!(this as any).viewRefs?.has(paneTab)) {
                    this.logger.info(`Attaching view for pane %${pane.paneId}`)
                    await this.addTab(paneTab as any, null, 'r')
                    ;(paneTab as any).emitVisibility(true)
                    ;(paneTab as any).emitFocused()
                }
            }

            // Clean up stale pane tabs no longer in the layout
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

        // Position panes using pixel-absolute layout + set character grids
        this.applyPixelLayout(layoutTree)

        // Update divider elements
        this.updateDividers(layoutTree)

        this.cdr.detectChanges()
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
            this.cdr.detectChanges()
        }
        ;(paneTab as any).destroy()
    }

    /**
     * Position each pane using tmux's absolute character coordinates × cell pixel size.
     * Also sets the xterm character grid for each pane. One pass, zero rounding.
     */
    private applyPixelLayout(layoutTree: TmuxLayoutNode): void {
        const cell = this.getCellSize()
        if (!cell) return

        const paneMap = this.windowPaneTabs.get(this.activeWindowId!)
        if (!paneMap) return

        // Read pane-area padding so absolute-positioned panes respect it.
        // CSS absolute positioning ignores parent padding, so we offset manually.
        const host = this.hostElement.nativeElement as HTMLElement
        const paneArea = host.querySelector('.pane-area') as HTMLElement
        const padL = paneArea ? parseFloat(getComputedStyle(paneArea).paddingLeft) || 0 : 0
        const padT = paneArea ? parseFloat(getComputedStyle(paneArea).paddingTop) || 0 : 0

        for (const pane of flattenLayout(layoutTree)) {
            const paneTab = paneMap.get(pane.paneId) as any
            if (!paneTab) continue

            // Set pixel position from tmux char coords
            const viewRef = (this as any).viewRefs?.get(paneTab)
            if (viewRef) {
                const el = viewRef.rootNodes[0] as HTMLElement
                el.classList.add('child')
                el.style.left   = `${padL + pane.x * cell.width}px`
                el.style.top    = `${padT + pane.y * cell.height}px`
                el.style.width  = `${pane.width * cell.width}px`
                el.style.height = `${pane.height * cell.height}px`
            }

            // Set xterm character grid
            if (paneTab.setTmuxGrid) {
                paneTab.setTmuxGrid(pane.width, pane.height)
            }
        }
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
     * Measure the whole-window character grid from the .pane-area container.
     *
     * Pure pixel-to-cell conversion. Uses clientWidth/clientHeight to
     * exclude padding from the measurement — pane-area padding is purely
     * cosmetic and must not affect the tmux grid calculation.
     */
    private measureClientSize(): { cols: number; rows: number } | null {
        const host = this.hostElement.nativeElement as HTMLElement
        const paneArea = host.querySelector('.pane-area') ?? host
        const pw = (paneArea as HTMLElement).clientWidth
        const ph = (paneArea as HTMLElement).clientHeight
        if (pw < 10 || ph < 10) return null

        const cell = this.getCellSize()
        if (!cell) return null

        return {
            cols: Math.max(2, Math.floor(pw / cell.width)),
            rows: Math.max(1, Math.floor(ph / cell.height)),
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
        const debounceMs = this.configService.store.tmuxPlugin?.resizeDebounceMs ?? 150
        this._resizeTimer = setTimeout(() => {
            this._resizeTimer = null
            this.refreshClientSize()
        }, debounceMs)
    }

    // ─── Divider management ──────────────────────────────────────────────────

    /**
     * Generate independent divider <div> elements for adjacent pane boundaries.
     * Walks the layout tree to find sibling edges and creates draggable lines.
     */
    private updateDividers(layoutTree: TmuxLayoutNode): void {
        const host = this.hostElement.nativeElement as HTMLElement
        const paneArea = host.querySelector('.pane-area') as HTMLElement
        if (!paneArea) return

        this.clearDividers()

        const cell = this.getCellSize()
        if (!cell) return

        this.collectDividers(layoutTree, cell, paneArea)
    }

    /**
     * Recursively collect divider lines from the layout tree.
     * For each container node, consecutive children share a boundary → divider.
     *
     * tmux layout semantics:
     * - 'vertical' ([...]): children stacked top-to-bottom → horizontal divider line
     * - 'horizontal' ({...}): children side-by-side → vertical divider line
     *
     * Same-level siblings always share the same cross-axis extent (tmux guarantees
     * this for its binary splits), so divider size is simply derived from the parent.
     *
     * For container children (non-leaf), we find the actual pane IDs at the
     * boundary using helper methods so drag-resize works at every level.
     */
    private collectDividers(node: TmuxLayoutNode, cell: { width: number; height: number }, paneArea: HTMLElement): void {
        if (!node.children || node.children.length < 2) {
            return
        }

        // Read pane-area padding to offset divider positions (same as applyPixelLayout)
        const cs = getComputedStyle(paneArea)
        const padL = parseFloat(cs.paddingLeft) || 0
        const padT = parseFloat(cs.paddingTop) || 0

        for (let i = 0; i < node.children.length - 1; i++) {
            const left = node.children[i]
            const right = node.children[i + 1]

            if (node.type === 'horizontal') {
                // Children are side-by-side → vertical divider between left and right
                // Divider is 1 cell wide, centered at the shared boundary
                const x = padL + (left.x + left.width) * cell.width
                const top = padT + node.y * cell.height
                const height = node.height * cell.height

                // Find the rightmost pane(s) in `left` and leftmost pane(s) in `right`
                const paneIdA = this.getRightmostLeafPaneId(left)
                const paneIdB = this.getLeftmostLeafPaneId(right)

                this.createDividerElement(paneArea, 'v', x, top, cell.width, height, paneIdA, paneIdB, cell)
            } else {
                // Children are stacked top-to-bottom → horizontal divider between top and bottom
                // Divider is 1 cell tall, centered at the shared boundary
                const y = padT + (left.y + left.height) * cell.height
                const leftPx = padL + node.x * cell.width
                const width = node.width * cell.width

                // Find the bottommost pane(s) in `left` and topmost pane(s) in `right`
                const paneIdA = this.getBottommostLeafPaneId(left)
                const paneIdB = this.getTopmostLeafPaneId(right)

                this.createDividerElement(paneArea, 'h', leftPx, y, width, cell.height, paneIdA, paneIdB, cell)
            }
        }

        // Recurse into children
        for (const child of node.children) {
            this.collectDividers(child, cell, paneArea)
        }
    }

    /** Find the rightmost leaf pane in a layout subtree (for vertical divider) */
    private getRightmostLeafPaneId(node: TmuxLayoutNode): number | undefined {
        if (node.type === 'pane') return node.paneId
        if (!node.children?.length) return undefined
        return this.getRightmostLeafPaneId(node.children[node.children.length - 1])
    }

    /** Find the leftmost leaf pane in a layout subtree (for vertical divider) */
    private getLeftmostLeafPaneId(node: TmuxLayoutNode): number | undefined {
        if (node.type === 'pane') return node.paneId
        if (!node.children?.length) return undefined
        return this.getLeftmostLeafPaneId(node.children[0])
    }

    /** Find the bottommost leaf pane in a layout subtree (for horizontal divider) */
    private getBottommostLeafPaneId(node: TmuxLayoutNode): number | undefined {
        if (node.type === 'pane') return node.paneId
        if (!node.children?.length) return undefined
        return this.getBottommostLeafPaneId(node.children[node.children.length - 1])
    }

    /** Find the topmost leaf pane in a layout subtree (for horizontal divider) */
    private getTopmostLeafPaneId(node: TmuxLayoutNode): number | undefined {
        if (node.type === 'pane') return node.paneId
        if (!node.children?.length) return undefined
        return this.getTopmostLeafPaneId(node.children[0])
    }

    /**
     * Create a single divider DOM element with drag-to-resize behavior.
     */
    private createDividerElement(
        paneArea: HTMLElement,
        orientation: 'v' | 'h',
        x: number, y: number, w: number, h: number,
        paneIdA: number | undefined, paneIdB: number | undefined,
        cell: { width: number; height: number },
    ): void {
        const div = document.createElement('div')
        div.className = `tmux-divider ${orientation}`
        div.style.left = `${x}px`
        div.style.top = `${y}px`
        div.style.width = `${w}px`
        div.style.height = `${h}px`

        // Divider is already 1 cell wide/tall — natural hit target matches tmux

        if (paneIdA !== undefined && paneIdB !== undefined) {
            const onDown = (e: MouseEvent) => {
                e.preventDefault()
                e.stopPropagation()

                const startX = e.clientX
                const startY = e.clientY
                let lastSentCols = 0
                let lastSentRows = 0

                const onMove = (de: MouseEvent) => {
                    document.body.style.cursor = orientation === 'v' ? 'col-resize' : 'row-resize'

                    if (orientation === 'v') {
                        const deltaCols = Math.round((de.clientX - startX) / cell.width)
                        if (deltaCols !== lastSentCols) {
                            const diff = deltaCols - lastSentCols
                            const flag = diff > 0 ? '-R' : '-L'
                            this.controller?.gateway.sendCommand(
                                `resize-pane ${flag} -t %${paneIdA} ${Math.abs(diff)}`
                            )
                            lastSentCols = deltaCols
                        }
                    } else {
                        const deltaRows = Math.round((de.clientY - startY) / cell.height)
                        if (deltaRows !== lastSentRows) {
                            const diff = deltaRows - lastSentRows
                            const flag = diff > 0 ? '-D' : '-U'
                            this.controller?.gateway.sendCommand(
                                `resize-pane ${flag} -t %${paneIdA} ${Math.abs(diff)}`
                            )
                            lastSentRows = deltaRows
                        }
                    }
                }

                const onUp = () => {
                    document.removeEventListener('mousemove', onMove)
                    document.removeEventListener('mouseup', onUp)
                    document.body.style.cursor = ''
                }

                document.addEventListener('mousemove', onMove)
                document.addEventListener('mouseup', onUp)
            }
            div.addEventListener('mousedown', onDown)
        }

        paneArea.appendChild(div)
        this._dividerElements.push(div)
    }

    /**
     * Remove all divider elements from the DOM.
     */
    private clearDividers(): void {
        for (const el of this._dividerElements) {
            el.remove()
        }
        this._dividerElements = []
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
        this.clearDividers()
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
