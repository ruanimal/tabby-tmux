import {
    Component,
    Injector,
    Input,
    OnInit,
    OnDestroy,
    ChangeDetectorRef,
    ElementRef,
} from '@angular/core'
import { Subscription } from 'rxjs'
import {
    SplitTabComponent,
    SplitContainer,
    LogService,
    Logger,
    TabsService,
    HotkeysService,
    GetRecoveryTokenOptions,
    RecoveryToken,
    ConfigService,
} from 'tabby-core'
import { TabRecoveryService } from 'tabby-core'
import { TmuxController } from '../session'
import { TmuxService } from '../services/tmux.service'
import { TMUX_COMMAND_TOLERATE_ERRORS } from '../gateway'
import { TmuxPaneTabComponent } from './tmuxPaneTab.component'
import { parseTmuxLayout, TmuxLayoutNode, flattenLayout } from '../layoutParser'
import { renderDividers } from '../divider'

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
        '[class.tmux-session-host]': 'true',
    },
    template: `
        <div class="pane-area" #paneAreaEl>
            <ng-container #vc></ng-container>
        </div>
        <tmux-window-bar
            [controller]="controller"
            [activeWindowId]="activeWindowId"
            (windowSwitch)="enqueueSwitchToWindow($event, true)"
            (windowClose)="onWindowClose($event)"
            (disconnect)="onDisconnect()"
            (createWindow)="onCreateWindow()"
        ></tmux-window-bar>
    `,
    styles: [
        `
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
                opacity: 0.75;
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
                background: rgba(128, 128, 128, 0.3);
                transition: background 0.15s;
            }
            ::ng-deep .tmux-divider:hover::after {
                background: rgba(128, 128, 128, 0.75);
            }
            ::ng-deep .tmux-divider.v {
                /* vertical divider: left-right split */
                cursor: col-resize;
            }
            ::ng-deep .tmux-divider.v::after {
                width: 1px;
                height: 100%;
            }
            ::ng-deep .tmux-divider.h {
                /* horizontal divider: top-bottom split */
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
        `,
    ],
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
        super(injector.get(HotkeysService), tabsService, injector.get(TabRecoveryService), injector)
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
        this.eventSubscription = this.controller.events.subscribe((event) => {
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
            // tmux may start with a stale client size from a previous attach.
            // Tell tmux our actual size before discovering panes, so the
            // layout-change events carry coordinates matching our window.
            //
            // Note: pane borders are NOT suppressed here. In control mode,
            // tmux's pane-border render is purely internal — border characters
            // never reach the client via %output or capture-pane (those streams
            // carry only each pane's own program output, not tmux's drawn UI).
            // The previous `set-option -gw pane-border-lines off` was a no-op
            // against this architecture ("off" is also an illegal enum value in
            // tmux 3.x, so it emitted %error on every entry and stalled the
            // command queue for several seconds). CSS .tmux-divider elements
            // are the sole source of visible separators.
            this.refreshClientSize()
            await this.eventQueue

            // ── Step B: Pane discovery (now based on correct size) ──
            // refreshPanes() sends list-windows + list-panes + capture-pane.
            // tmux serializes these behind the relayout triggered by the
            // refresh-client -C above, so this await naturally waits for tmux
            // to finish relaying-out every window — that wait is unavoidable
            // (tmux processes commands serially). Using layout-change-driven
            // discovery instead was tried but broke the pane-add → create tab →
            // start() → restorePaneHistory(snapshot) ordering: bootstrap built
            // pane tabs before capture-pane populated pendingSnapshots, so
            // restorePaneHistory found empty snapshots and panes showed no
            // prompt. Keeping refreshPanes() preserves the capture-then-
            // pane-add ordering that pendingSnapshots depends on.
            await this.controller!.refreshPanes()
            this.bootstrapFromControllerState()
            await this.eventQueue

            const activeWindowId = this.controller!.getActiveWindowId()
            const targetWindowId =
                activeWindowId !== null && this.windowPaneTabs.has(activeWindowId)
                    ? activeWindowId
                    : this.controller!.getFirstWindowId()
            if (targetWindowId !== undefined) {
                // Route through the serial queue so this initial switch cannot
                // interleave with queued pane/layout events.
                this.enqueueSwitchToWindow(targetWindowId)
                await this.eventQueue
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
                        this.logger.info(
                            `Bootstrap: creating pane tab for %${paneId} in window @${windowState.id}`,
                        )
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

    private async handleControllerEvent(event: {
        type: string
        paneId?: number
        windowId?: number
        data?: any
    }): Promise<void> {
        this.logger.info('SessionTab event:', event.type, event)

        switch (event.type) {
            case 'initialized':
            case 'session-changed':
                this.connected = true
                this.sessionName =
                    this.controller?.getSessionName() || this.profile.sessionName || 'default'
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
                    this.logger.info(
                        `Handling pane-add event: pane=${event.paneId}, window=${event.windowId}`,
                    )
                    await this.handlePaneAdd(event.paneId, event.windowId)
                }
                break

            case 'pane-update':
                if (event.paneId !== undefined && event.windowId !== undefined) {
                    // Pane might have moved to a different window
                    this.logger.info(
                        `Handling pane-update event: pane=${event.paneId}, window=${event.windowId}`,
                    )
                    await this.handlePaneUpdate(event.paneId, event.windowId)
                }
                break

            case 'pane-close':
                if (event.paneId !== undefined && event.windowId !== undefined) {
                    this.logger.info(
                        `Handling pane-close event: pane=${event.paneId}, window=${event.windowId}`,
                    )
                    this.handlePaneClose(event.paneId, event.windowId)
                }
                break

            case 'active-pane-changed':
                if (event.paneId !== undefined && event.windowId !== undefined) {
                    this.handleActivePaneChanged(event.paneId, event.windowId)
                }
                break

            case 'layout-change':
                // NOTE: We always call syncLayout for the active window.
                // For non-active windows, we save the layout but don't rebuild
                // the tree (it will be rebuilt when the user switches to it).
                if (event.windowId !== undefined && event.data?.layout) {
                    if (event.windowId === this.activeWindowId) {
                        this.logger.info(`Syncing layout for active window @${event.windowId}`)
                        await this.syncLayout(
                            event.data.layout,
                            event.data.zoomed,
                            event.data.visibleLayout,
                        )
                    } else {
                        this.logger.info(
                            `Layout changed for inactive window @${event.windowId}, saved for next switch`,
                        )
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
     * Queue a window switch through the serial event queue.
     *
     * switchToWindow is async and rebuilds the SplitContainer tree; running
     * it outside the queue (e.g. directly from the window bar template)
     * interleaves with queued events (layout-change → syncLayout,
     * active-pane-changed → handleActivePaneChanged), which caused focus
     * thrash: restores and pane-changed responses kept overwriting each
     * other and firing select-pane repeatedly.
     *
     * `syncToTmux` is true only for USER-INITIATED switches (window bar
     * clicks): the switch is then also sent to tmux via select-window so the
     * tmux-side active window follows the UI. Internal switches (bootstrap,
     * window-add events, the initial ngAfterViewInit switch, close fallbacks)
     * leave it false — they follow tmux instead of leading it.
     */
    enqueueSwitchToWindow(windowId: number, syncToTmux = false): void {
        this.eventQueue = this.eventQueue
            .then(() => this.switchToWindow(windowId, syncToTmux))
            .catch((err) => this.logger.warn('switchToWindow failed:', err))
    }

    /**
     * Switch to a different tmux window.
     * Hides current window's panes and shows target window's panes.
     */
    async switchToWindow(windowId: number, syncToTmux = false): Promise<void> {
        if (windowId === this.activeWindowId) {
            // User clicked the ALREADY-active window tab. UI and tmux may still
            // be out of sync (tmux's active window changed on another client,
            // or attach restored a different window) — a user-initiated click
            // must re-align tmux anyway, so still send select-window. It is a
            // no-op on the tmux side and only re-emits %session-window-changed
            // (which has no SessionTab event case, so no feedback loop).
            if (syncToTmux && this.controller) {
                this.controller.gateway
                    .sendCommand(`select-window -t @${windowId}`, TMUX_COMMAND_TOLERATE_ERRORS)
                    .catch(() => {
                        /* tmux may reject during detach */
                    })
            }
            return
        }

        this.logger.info(`Switching to window @${windowId}`)

        // Clear dividers while switching windows
        this.clearDividers()

        // 1. Detach current active window's pane views
        if (this.activeWindowId !== null) {
            const paneMap = this.windowPaneTabs.get(this.activeWindowId)
            if (paneMap) {
                this.logger.info(
                    `Detaching ${paneMap.size} pane(s) for window @${this.activeWindowId}`,
                )
                for (const paneTab of paneMap.values()) {
                    ;(paneTab as any).emitVisibility(false)
                    this.detachPaneView(paneTab as any)
                }
            }
        }

        // 2. Update active window
        this.activeWindowId = windowId

        // Sync a USER-INITIATED window switch to tmux via select-window, so the
        // tmux-side active window follows the window bar. Without this, tmux
        // keeps its stale active window (typically the last window created,
        // which tmux auto-activates) while the UI shows another one — on
        // re-attach the session restores tmux's stale active window instead of
        // the window the user was actually looking at.
        //
        // select-window replies with %session-window-changed, which only
        // updates controller.activeWindowId (there is no SessionTab event case
        // for it), so no feedback loop forms. Internal restore paths
        // (bootstrap, window-add, initial switch) must NOT sync — they follow
        // tmux instead of leading it.
        if (syncToTmux && this.controller) {
            this.controller.gateway
                .sendCommand(`select-window -t @${windowId}`, TMUX_COMMAND_TOLERATE_ERRORS)
                .catch(() => {
                    /* tmux may reject during detach */
                })
        }

        // 3. Ensure pane tabs exist for this window
        if (!this.windowPaneTabs.has(windowId)) {
            this.windowPaneTabs.set(windowId, new Map())
        }
        const paneMap = this.windowPaneTabs.get(windowId)!

        if (paneMap.size === 0) {
            const windowState = this.controller?.getWindowState(windowId)
            if (windowState?.layout) {
                this.logger.info(
                    `No pane tabs yet for window @${windowId}, but layout is known — discovering panes proactively`,
                )
                const { parseTmuxLayout, flattenLayout } = await import('../layoutParser')
                const layoutTree = parseTmuxLayout(windowState.layout)
                if (layoutTree) {
                    for (const pane of flattenLayout(layoutTree)) {
                        if (!paneMap.has(pane.paneId)) {
                            this.logger.info(
                                `Proactively creating pane tab for %${pane.paneId} in window @${windowId}`,
                            )
                            const paneTab = this.createPaneTab(pane.paneId)
                            paneTab.controller = this.controller!
                            paneTab.paneId = pane.paneId
                            paneMap.set(pane.paneId, paneTab)
                        }
                    }
                }
            } else {
                this.logger.info(
                    `No pane tabs yet for window @${windowId}, waiting for pane-add events`,
                )
            }
        } else {
            this.logger.info(`Mounting existing ${paneMap.size} pane(s) for window @${windowId}`)
        }

        // 4. Determine zoom state and discover all pane tabs needed.
        // layout = real multi-pane layout (always has all pane IDs)
        // visibleLayout = zoomed display layout (single pane filling window)
        const windowState = this.controller?.getWindowState(windowId)
        const isZoomed = !!windowState?.zoomedPaneId

        // Ensure pane tabs for ALL panes exist (discovered from layout, which is always real)
        if (windowState?.layout) {
            const fullTree = parseTmuxLayout(windowState.layout)
            if (fullTree) {
                for (const pane of flattenLayout(fullTree)) {
                    if (!paneMap.has(pane.paneId)) {
                        this.logger.info(
                            `Creating pane tab for %${pane.paneId}` +
                                (isZoomed ? ' (zoomed window)' : ''),
                        )
                        const paneTab = this.createPaneTab(pane.paneId)
                        paneTab.controller = this.controller!
                        paneTab.paneId = pane.paneId
                        paneMap.set(pane.paneId, paneTab)
                    }
                }
            }
        }

        // 5. Attach views for display pane tabs only
        // Reset root tree so addTab() registers panes into a clean structure.
        this.root = new SplitContainer()
        this.root.orientation = 'h'

        // Display layout: visibleLayout when zoomed (what's on screen), layout otherwise
        const displayLayoutStr =
            isZoomed && windowState?.visibleLayout ? windowState.visibleLayout : windowState?.layout
        const displayTree = displayLayoutStr ? parseTmuxLayout(displayLayoutStr) : null
        const displayPanes = displayTree ? flattenLayout(displayTree) : null
        const displayPaneIds = displayPanes
            ? new Set(displayPanes.map((p) => p.paneId))
            : new Set(paneMap.keys()) // no layout → show all

        const paneTabs = Array.from(paneMap.values())
        if (paneTabs.length > 0) {
            for (const paneTab of paneTabs) {
                const isDisplay = displayPaneIds.has(paneTab.paneId)
                if (!(this as any).viewRefs?.has(paneTab)) {
                    if (isDisplay) {
                        await this.addTab(paneTab as any, null, 'r')
                    }
                }
                if (isDisplay) {
                    ;(paneTab as any).emitVisibility(true)
                    ;(paneTab as any).emitFocused()
                } else {
                    ;(paneTab as any).emitVisibility(false)
                }
            }

            // Restore tmux's active pane for this window (window-level state,
            // tracked per window in the controller — see getActivePaneId).
            // MUST run after the emitFocused() loop: each emitFocused() makes
            // the xterm frontend grab DOM focus (frontend.focus() in
            // BaseTerminalTabComponent), so without this the DOM focus would
            // end up on the last pane of the loop instead of tmux's active
            // pane — breaking keyboard input routing.
            this.restoreActivePaneFocus(windowId, paneTabs, displayPanes)

            // 6. Apply pixel layout from tmux
            if (displayTree) {
                this.applyPixelLayout(displayTree)
                this.updateDividers(displayTree)
            }
        }

        // 7. Detect changes and push size
        this.cdr.detectChanges()
        this.updateZoomIndicators()

        if (paneTabs.length > 0) {
            // Refresh the client size after mounting panes. The dedup
            // (_lastSentCols/Rows) is deliberately NOT reset here: the size
            // only changes when the container actually changes (window resize),
            // which the ResizeObserver already reports. Forcing a re-send on
            // every window switch made tmux relayout ALL its windows each time
            // — an unnecessary full relayout. The very first push still
            // happens because _lastSent starts at 0.
            requestAnimationFrame(() => {
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
    override focus(tab: any, syncToTmux = false): void {
        const changed = (this as any).focusedTab !== tab
        ;(this as any).focusedTab = tab
        tab.emitFocused()
        // Mark only the focused pane as active for hotkey routing.
        // Other panes remain visible and initialized but won't process
        // hotkey-triggered input (Ctrl+C, paste, etc.).
        for (const t of this.getAllTabs()) {
            if (t instanceof TmuxPaneTabComponent) {
                t._tmuxActive = t === tab
            }
        }
        this.updatePaneFocusClasses()

        // Sync a USER-INITIATED focus change to tmux via select-pane, so the
        // tmux side stays consistent regardless of tmux mouse mode. Only the
        // user-click path (focusPaneFromUserClick) passes syncToTmux=true.
        //
        // Internal focus calls (restoreActivePaneFocus, handleActivePaneChanged,
        // ensureVisiblePaneFocused, and the base class's onAfterTabAdded
        // setImmediate focus after every addTab) must NOT send select-pane:
        // they follow tmux state instead of leading it, and letting them send
        // commands caused a feedback loop — select-pane → %window-pane-changed
        // → focus() → select-pane ... thrashing the active pane.
        //
        // `changed` additionally breaks the loop for the one remaining path:
        // select-pane → %window-pane-changed → handleActivePaneChanged →
        // focus(tab) where focusedTab is already `tab`.
        if (syncToTmux && changed && this.controller && tab instanceof TmuxPaneTabComponent) {
            this.logger.info(`focus changed → select-pane %${tab.paneId}`)
            this.controller.gateway
                .sendCommand(`select-pane -t %${tab.paneId}`, TMUX_COMMAND_TOLERATE_ERRORS)
                .catch(() => {
                    /* tmux may reject during detach */
                })
        }
    }

    /**
     * User clicked a pane (via TmuxPaneTabComponent's host click handler).
     * Routes through focus(_, true) so the click is synced to tmux with
     * select-pane — independent of tmux mouse mode.
     */
    focusPaneFromUserClick(paneTab: TmuxPaneTabComponent): void {
        this.focus(paneTab, true)
    }

    /**
     * Keep the DOM focus marker in sync with focusedTab.
     *
     * SplitTabComponent normally does this from layoutInternal(), but tmux
     * panes use a custom pixel layout and override layout() with a no-op.
     *
     * Intentionally does not replicate the upstream `_allFocusMode` branch
     * (all panes get the `focused` class in fullscreen focus mode): this
     * component overrides focus()/layout() and `_allFocusMode` is never
     * activated in this integration.
     */
    private updatePaneFocusClasses(): void {
        const focusedTab = this.getFocusedTab() as TmuxPaneTabComponent | null
        const viewRefs = (this as any).viewRefs as
            Map<TmuxPaneTabComponent, { rootNodes: Node[] }> | undefined

        for (const [paneTab, viewRef] of viewRefs ?? []) {
            const element = viewRef.rootNodes[0] as HTMLElement | undefined
            element?.classList.toggle('focused', paneTab === focusedTab)
        }
    }

    /** Ensure the custom layout always has one visible focused pane. */
    private ensureVisiblePaneFocused(paneTabs: TmuxPaneTabComponent[]): void {
        const focusedTab = this.getFocusedTab() as TmuxPaneTabComponent | null
        if (!focusedTab || !paneTabs.includes(focusedTab)) {
            const firstPane = paneTabs[0]
            if (firstPane) {
                this.focus(firstPane)
            }
            return
        }

        this.updatePaneFocusClasses()
    }

    /**
     * Restore tmux's active pane for a window (window-level state, tracked
     * per window in the controller — see TmuxController.getActivePaneId) as
     * the UI focused pane. Falls back to the first display pane when the
     * record is missing (e.g. active pane just closed and %window-pane-changed
     * not yet received).
     *
     * MUST be called after any emitFocused() loop: each emitFocused() makes
     * the xterm frontend grab DOM focus (frontend.focus() subscribed in
     * BaseTerminalTabComponent), so without this the DOM focus would land on
     * the last pane of the loop instead of tmux's active pane — keyboard
     * input would go to the wrong pane.
     */
    private restoreActivePaneFocus(
        windowId: number,
        paneTabs: TmuxPaneTabComponent[],
        displayPanes: Array<{ paneId: number }> | null,
    ): void {
        // Defer to setImmediate: the base class's onAfterTabAdded() schedules
        // `setImmediate(() => this.focus(tab))` for EVERY addTab() in the
        // mount loop, so the last added pane grabs focusedTab after our
        // synchronous restore below. Deferring the restore lets it run after
        // those queued focus calls and win — without sending select-pane
        // (focus defaults syncToTmux=false; only user clicks sync to tmux).
        setImmediate(() => {
            const ctrlActivePaneId = this.controller?.getActivePaneId(windowId)
            // Fall back in tmux layout order (left-to-right, top-to-bottom),
            // NOT paneMap insertion order — pane creation order is unrelated
            // to visual order and picking the wrong pane caused unstable
            // activation.
            const activePaneTab =
                paneTabs.find((t) => t.paneId === ctrlActivePaneId) ??
                (displayPanes
                    ? displayPanes
                          .map((p) => paneTabs.find((t) => t.paneId === p.paneId))
                          .find((t) => t !== undefined)
                    : paneTabs[0])
            this.logger.info(
                `restoreActivePaneFocus win=@${windowId} ctrlPane=${ctrlActivePaneId} ` +
                    `target=${activePaneTab ? `%${activePaneTab.paneId}` : 'none'}`,
            )
            if (activePaneTab) {
                this.focus(activePaneTab as any)
            }
        })
    }

    /**
     * Detach a pane tab's view from the ViewContainer without calling
     * removeTab() which would trigger self-destruction when root empties.
     */
    private detachPaneView(tab: any): void {
        // A pane detached from the view (window switch / move / close) must
        // stop being a hotkey target.  Pane tabs stay alive while detached
        // (their session keeps running and their hotkey$ subscription stays
        // active), so without clearing `_tmuxActive` and the focus flag a
        // stale pane from another window would still process hotkey-triggered
        // input (Ctrl+C, paste, ...) for its tmux pane — killing commands
        // running in other windows.
        if (tab instanceof TmuxPaneTabComponent) {
            tab._tmuxActive = false
        }
        ;(tab as any).emitBlurred()

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
        this.logger.info(
            `Registered new pane %${paneId} for window @${windowId}, awaiting layout sync`,
        )
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
                ;(paneTab as any).emitVisibility(false)
                this.detachPaneView(paneTab as any)
            }
        }
    }

    /**
     * Handle a tmux window being closed.
     *
     * tmux automatically activates an adjacent window (next by index, or
     * previous if it was the last) and sends %session-window-changed.
     * The controller updates activeWindowId from that event, so we check
     * it to decide which window to switch to — matching tmux default
     * behavior (and browser tab close behavior).
     */
    private async handleWindowClose(windowId: number): Promise<void> {
        const paneMap = this.windowPaneTabs.get(windowId)
        if (paneMap) {
            // Destroy all pane tabs for this window
            for (const paneTab of paneMap.values()) {
                if (windowId === this.activeWindowId) {
                    ;(paneTab as any).emitVisibility(false)
                    this.detachPaneView(paneTab as any)
                }
                ;(paneTab as any).destroy()
            }
            this.windowPaneTabs.delete(windowId)
        }

        // If we just closed the active window, switch to another one
        if (windowId === this.activeWindowId) {
            this.activeWindowId = null
            const remainingWindows = Array.from(this.windowPaneTabs.keys())
            if (remainingWindows.length > 0) {
                // tmux sends %session-window-changed which updates
                // controller.activeWindowId — prefer that over arbitrary choice
                const tmuxActiveId = this.controller?.getActiveWindowId()
                const target =
                    tmuxActiveId !== null && this.windowPaneTabs.has(tmuxActiveId)
                        ? tmuxActiveId
                        : remainingWindows[0]
                await this.switchToWindow(target)
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
    private async syncLayout(
        layoutStr: string,
        zoomed?: boolean,
        visibleLayout?: string,
    ): Promise<void> {
        // tmux %layout-change semantics:
        //   layout  = real multi-pane layout (all panes, their actual sizes)
        //   visibleLayout = layout that tmux actually displays on screen
        // When zoomed: visibleLayout is the single zoomed pane filling the window.
        //
        // For display, use visibleLayout when zoomed (what's on screen), layout otherwise.
        // For pane discovery, always use layout (has all pane IDs).

        // Display layout: what's actually shown on screen
        const displayLayoutStr = zoomed && visibleLayout ? visibleLayout : layoutStr
        const displayTree = parseTmuxLayout(displayLayoutStr)
        if (!displayTree) {
            this.logger.warn('Failed to parse display layout:', displayLayoutStr)
            return
        }
        const displayPanes = flattenLayout(displayTree)
        const displayPaneIds = new Set(displayPanes.map((p) => p.paneId))

        // Full pane list from layout (always the real multi-pane layout)
        const fullTree = parseTmuxLayout(layoutStr)
        const allPanes = fullTree ? flattenLayout(fullTree) : displayPanes

        this.logger.info(
            `Syncing layout for window @${this.activeWindowId}: ` +
                `${displayPanes.length} display pane(s), ${allPanes.length} total` +
                (zoomed ? ' (zoomed)' : ''),
        )

        // Ensure pane tabs exist and have attached views
        if (this.activeWindowId !== null) {
            let paneMap = this.windowPaneTabs.get(this.activeWindowId)
            if (!paneMap) {
                paneMap = new Map()
                this.windowPaneTabs.set(this.activeWindowId, paneMap)
            }

            // Create pane tabs for ALL panes (including hidden ones when zoomed)
            for (const pane of allPanes) {
                if (!paneMap.has(pane.paneId)) {
                    this.logger.info(`Creating pane tab for %${pane.paneId} during layout sync`)
                    const paneTab = this.createPaneTab(pane.paneId)
                    paneTab.controller = this.controller!
                    paneTab.paneId = pane.paneId
                    paneMap.set(pane.paneId, paneTab)
                }
            }

            // Ensure root exists for addTab to register ViewContainerRefs.
            if (!(this.root instanceof SplitContainer)) {
                this.root = new SplitContainer()
                this.root.orientation = 'h'
            }

            // Attach views for panes that should be displayed
            for (const pane of displayPanes) {
                const paneTab = paneMap.get(pane.paneId)!
                if (!(this as any).viewRefs?.has(paneTab)) {
                    this.logger.info(`Attaching view for pane %${pane.paneId}`)
                    await this.addTab(paneTab as any, null, 'r')
                }
                ;(paneTab as any).emitVisibility(true)
                ;(paneTab as any).emitFocused()
            }

            // The emitFocused() loop above gives the xterm DOM focus to the
            // LAST pane (frontend.focus() on every focused$ event). Restore
            // tmux's window-level active pane so DOM focus, hotkey routing
            // and the focused pane all agree with tmux.
            this.restoreActivePaneFocus(
                this.activeWindowId,
                Array.from(paneMap.values()),
                displayPanes,
            )

            // Hide panes not in the display set (e.g. non-zoomed panes)
            for (const [paneId, paneTab] of paneMap) {
                if (!displayPaneIds.has(paneId)) {
                    ;(paneTab as any).emitVisibility(false)
                    if ((this as any).viewRefs?.has(paneTab)) {
                        this.detachPaneView(paneTab as any)
                    }
                }
            }

            // Clean up stale pane tabs no longer in the full layout.
            // When zoomed, only clean up panes absent from visibleLayout;
            // panes hidden by zoom are still alive in tmux.
            if (!zoomed) {
                const fullPaneIds = new Set(allPanes.map((p) => p.paneId))
                for (const [paneId, paneTab] of paneMap) {
                    if (!fullPaneIds.has(paneId)) {
                        this.logger.info(`Pane %${paneId} no longer in layout, cleaning up`)
                        paneMap.delete(paneId)
                        ;(paneTab as any).emitVisibility(false)
                        this.detachPaneView(paneTab as any)
                        ;(paneTab as any).destroy()
                    }
                }
            }
        }

        // Position panes using pixel-absolute layout + set character grids
        this.applyPixelLayout(displayTree)

        // Update divider elements
        this.updateDividers(displayTree)

        this.cdr.detectChanges()

        // Refresh the zoom indicator chips after any layout change — zoom
        // state (zoomedPaneId) only changes via %layout-change.
        this.updateZoomIndicators()
    }

    /**
     * Refresh the "Exit zoom" indicator on every pane tab. The zoomed pane
     * shows the chip in its top-right corner; all others hide it.
     */
    private updateZoomIndicators(): void {
        for (const paneMap of this.windowPaneTabs.values()) {
            for (const paneTab of paneMap.values()) {
                paneTab.updateZoomIndicator()
            }
        }
    }

    /**
     * Handle a pane being closed (from %pane-close event or manual cleanup).
     *
     * Note: we do NOT activate a neighboring pane here. tmux sends
     * %window-pane-changed after closing a pane, which triggers
     * handleActivePaneChanged() to focus the correct pane.
     *
     * When zoomed, closing a hidden pane just removes it from the map.
     * Closing the zoomed pane triggers tmux to auto-unzoom + kill,
     * which sends %layout-change to restore the real layout.
     */
    private handlePaneClose(paneId: number, windowId: number): void {
        const paneMap = this.windowPaneTabs.get(windowId)
        if (!paneMap) return

        const paneTab = paneMap.get(paneId)
        if (!paneTab) return

        this.logger.info(`Cleaning up closed pane %${paneId} in window @${windowId}`)
        paneMap.delete(paneId)

        // Only detach view if it's actually attached (visible panes).
        // Hidden panes (e.g. non-zoomed panes when zoomed) are already detached.
        if (windowId === this.activeWindowId && (this as any).viewRefs?.has(paneTab)) {
            ;(paneTab as any).emitVisibility(false)
            this.detachPaneView(paneTab as any)
            this.cdr.detectChanges()
        }
        ;(paneTab as any).destroy()
    }

    /**
     * Handle tmux telling us the active pane changed (e.g. after pane close).
     * Focuses the pane in the UI, matching tmux default behavior.
     *
     * The controller records this per-window (window-level state, see
     * TmuxController.getActivePaneId), so events for non-active windows are
     * safe to ignore here — switchToWindow() restores that window's active
     * pane from the controller when the user switches to it.
     */
    private handleActivePaneChanged(paneId: number, windowId: number): void {
        if (windowId !== this.activeWindowId) return

        const paneMap = this.windowPaneTabs.get(windowId)
        if (!paneMap) return

        const paneTab = paneMap.get(paneId)
        if (!paneTab) return

        // Pane not mounted yet (view not attached) — skip focusing it.
        // The controller already recorded the window-level active pane, and
        // restoreActivePaneFocus() applies it when the pane gets mounted.
        // Focusing an unmounted pane would set a stale focusedTab and make
        // ensureVisiblePaneFocused fall back to an arbitrary pane, firing a
        // spurious select-pane.
        if (!(this as any).viewRefs?.has(paneTab)) {
            this.logger.info(
                `Pane %${paneId} not mounted yet, deferring focus to restoreActivePaneFocus`,
            )
            return
        }

        this.logger.info(`Activating pane %${paneId} in window @${windowId}`)
        this.focus(paneTab as any)
    }

    /**
     * Position each pane using tmux's absolute character coordinates × cell pixel size.
     * Also sets the xterm character grid for each pane. One pass, zero rounding.
     */
    private applyPixelLayout(layoutTree: TmuxLayoutNode): void {
        const paneMap = this.windowPaneTabs.get(this.activeWindowId!)
        if (!paneMap) return

        const panes = flattenLayout(layoutTree)
        const visiblePaneTabs = panes
            .map((pane) => paneMap.get(pane.paneId))
            .filter((paneTab): paneTab is TmuxPaneTabComponent => paneTab !== undefined)
        this.ensureVisiblePaneFocused(visiblePaneTabs)

        const cell = this.getCellSize()
        if (!cell) return

        // Read pane-area padding so absolute-positioned panes respect it.
        // CSS absolute positioning ignores parent padding, so we offset manually.
        const host = this.hostElement.nativeElement as HTMLElement
        const paneArea = host.querySelector('.pane-area') as HTMLElement
        const padL = paneArea ? parseFloat(getComputedStyle(paneArea).paddingLeft) || 0 : 0
        const padT = paneArea ? parseFloat(getComputedStyle(paneArea).paddingTop) || 0 : 0

        for (const pane of panes) {
            const paneTab = paneMap.get(pane.paneId) as any
            if (!paneTab) continue

            // Set pixel position from tmux char coords
            const viewRef = (this as any).viewRefs?.get(paneTab)
            if (viewRef) {
                const el = viewRef.rootNodes[0] as HTMLElement
                el.classList.add('child')
                el.style.left = `${padL + pane.x * cell.width}px`
                el.style.top = `${padT + pane.y * cell.height}px`
                el.style.width = `${pane.width * cell.width}px`
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
     *
     * NOTE: unlike before, this does NOT bail out when activeWindowId is null.
     * The host terminal's cell size (controller.getHostCellSize()) lets us
     * measure the correct grid even before any pane is mounted, so the very
     * first push happens in ngAfterViewInit Step A — BEFORE refreshPanes()
     * discovers windows. tmux then lays out every window at the correct size
     * from the start, instead of the first layout being based on tmux's stale
     * pre-attach size (which caused a visible relayout flash after attach).
     */
    private refreshClientSize(): void {
        if (!this.controller || !this._initialized) return

        const measured = this.measureClientSize()
        if (!measured) {
            // measureClientSize failed — either the container is too small,
            // or no cell size is available yet (host cell missing AND no pane
            // frontend attached). Retry shortly so the first real size still
            // gets sent once a pane has rendered its character grid — but
            // only if panes are expected.
            const paneMap =
                this.activeWindowId === null
                    ? undefined
                    : this.windowPaneTabs.get(this.activeWindowId)
            if (paneMap && paneMap.size > 0) {
                this.scheduleRefreshClientSize()
            }
            return
        }

        const { cols, rows } = measured
        if (cols > 0 && rows > 0 && (cols !== this._lastSentCols || rows !== this._lastSentRows)) {
            this._lastSentCols = cols
            this._lastSentRows = rows
            this.logger.info(`Setting tmux client size: ${cols}x${rows}`)
            this.controller.resizePane(0, cols, rows)
            // Mark that a client size has been pushed — history capture
            // (capture-pane) must not run before this, or it would snapshot
            // tmux's stale pre-attach window size (see capturePaneSnapshots).
            this.controller.setClientSizePushed()
        }
    }

    /**
     * Measure the whole-window character grid from the .pane-area container.
     *
     * Pure pixel-to-cell conversion. clientWidth/clientHeight INCLUDE the
     * element's padding, so the .pane-area padding (4px per side, purely
     * cosmetic) is subtracted explicitly — see measureClientSize body.
     */
    private measureClientSize(): { cols: number; rows: number } | null {
        const host = this.hostElement.nativeElement as HTMLElement
        const paneArea = host.querySelector('.pane-area') ?? host

        // clientWidth/clientHeight include padding, but the .pane-area padding
        // (4px each side) is cosmetic and must not count toward the tmux grid —
        // otherwise tmux gets ~1 extra column/row and the rightmost/bottommost
        // pane overflows the visible area (misaligned against the bottom
        // window bar / tab bar).
        //
        // The bottom window bar itself is excluded automatically: it is a flex
        // sibling (flex: 0 0 auto) while .pane-area is flex: 1 1 0, so
        // clientHeight already excludes it. tmux-mode scrollbars are overlay
        // (consume no layout space), so clientWidth needs no scrollbar
        // adjustment — unlike the host terminal, whose native scrollbar would
        // otherwise shave columns off the grid.
        const cs = getComputedStyle(paneArea as HTMLElement)
        const padL = parseFloat(cs.paddingLeft) || 0
        const padR = parseFloat(cs.paddingRight) || 0
        const padT = parseFloat(cs.paddingTop) || 0
        const padB = parseFloat(cs.paddingBottom) || 0
        const pw = (paneArea as HTMLElement).clientWidth - padL - padR
        const ph = (paneArea as HTMLElement).clientHeight - padT - padB
        if (pw < 10 || ph < 10) return null

        const cell = this.getCellSize()
        if (!cell) return null

        return {
            cols: Math.max(2, Math.floor(pw / cell.width)),
            rows: Math.max(1, Math.floor(ph / cell.height)),
        }
    }

    /**
     * Read the xterm character cell size (in CSS pixels) used for the tmux grid.
     *
     * Cell source precedence:
     * 1. The host terminal's cell size captured at attach time
     *    (controller.getHostCellSize()). The host xterm is fully rendered when
     *    the user enters tmux mode, so this is the REAL cell size — the pane's
     *    early measurement can't be trusted (fallback font before its first
     *    resize), see the body for details.
     * 2. Any mounted pane's xterm (fallback when the host cell is missing).
     *    All panes share the global font config, and after their first
     *    setTmuxGrid()-driven resize they re-measure to the real font, which
     *    equals the host cell size.
     *
     * Returns null only when neither source is available; callers retry.
     */
    private getCellSize(): { width: number; height: number } | null {
        // Prefer the host terminal's cell size captured at attach time
        // (controller.getHostCellSize()): the host is fully rendered when the
        // user enters tmux mode, so this is measured with the REAL font.
        //
        // A pane's own measurement is NOT preferred, even after its xterm is
        // _frontendReady: xterm only re-measures on resize() (_afterResize),
        // and fitAddon.fit() is neutralized to a no-op — so until the first
        // setTmuxGrid() forces xterm.resize(), a pane's cell may still be a
        // fallback-font value (wider than the real one). Using it would push
        // a wrong client size (attach logs show 135x32 → 128x32 → 135x32).
        // After that first resize the pane re-measures and matches the host
        // cell, so preferring the host value is always consistent.
        const hostCell = this.controller?.getHostCellSize()
        if (hostCell) return hostCell

        // No host cell (attach-time capture failed) — fall back to a ready
        // pane's own measurement.
        for (const paneMap of this.windowPaneTabs.values()) {
            for (const paneTab of paneMap.values()) {
                const pane = paneTab as any
                if (!pane._frontendReady) continue
                const frontend = pane.frontend
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

        this._dividerElements = renderDividers(
            paneArea,
            layoutTree,
            cell,
            (paneIdA, flag, amount) => {
                this.controller?.gateway.sendCommand(`resize-pane ${flag} -t %${paneIdA} ${amount}`)
            },
        )
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
                this.enqueueSwitchToWindow(newWindowId)
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
    override async getRecoveryToken(
        options?: GetRecoveryTokenOptions,
    ): Promise<RecoveryToken | null> {
        const ctx = this.tmuxService.findContextForTab(this)
        if (ctx?.topmostTab) {
            return ctx.topmostTab.getRecoveryToken(options)
        }
        return null
    }
}
