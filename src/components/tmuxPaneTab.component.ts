import { Component, ElementRef, HostListener, Injector, Input, OnInit } from '@angular/core'
import { first } from 'rxjs'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { MenuItemOptions } from 'tabby-core'
import { TmuxController, TmuxPaneSession, SyncScope } from '../session'

@Component({
    selector: 'tmux-pane-tab',
    template: BaseTerminalTabComponent.template,
    styles: [...BaseTerminalTabComponent.styles, require('./tmuxPaneTab.component.scss')],
    animations: BaseTerminalTabComponent.animations,
})
export class TmuxPaneTabComponent extends BaseTerminalTabComponent<any> implements OnInit {
    @Input() controller: TmuxController
    @Input() paneId: number

    /**
     * Whether this pane is the active (keyboard-focused) pane in the tmux session.
     * Controls whether hotkey-triggered input (e.g. Ctrl+C, paste) is forwarded.
     *
     * All tmux pane tabs have `hasFocus = true` simultaneously (needed for
     * xterm frontend initialization), but only one pane should process hotkeys.
     * This flag is managed by TmuxSessionTabComponent.focus().
     */
    _tmuxActive = true

    /**
     * User clicked this pane. Routes to the session tab's
     * focusPaneFromUserClick(), which focuses the pane AND syncs the change
     * to tmux via select-pane (independent of tmux mouse mode).
     *
     * The base class's attachTabView() registers its own click listener that
     * calls focus(tab) without the tmux sync — that one only updates the UI
     * focus state, so no select-pane feedback loop can form.
     */
    @HostListener('click')
    onHostClick(): void {
        const sessionTab = this.parent as any
        sessionTab?.focusPaneFromUserClick?.(this)
    }

    /** Desired tmux grid size (chars). tmux is authoritative over the cell grid. */
    private _tmuxCols = 0
    private _tmuxRows = 0
    /** Whether the xterm frontend has been attached and is ready. */
    private _frontendReady = false

    // --- Custom overlay scrollbar (xterm 5.4 native-viewport scroll model) ---
    /** Pane host element — the pixel-positioned container (applyPixelLayout). */
    private _paneHost: HTMLElement
    private _scrollbarTrack: HTMLElement | null = null
    private _scrollbarThumb: HTMLElement | null = null
    /** The native scroll container (.xterm-viewport); null when not applicable. */
    private _scrollbarViewport: HTMLElement | null = null
    private _scrollbarResizeObserver: ResizeObserver | null = null
    private _scrollbarHideTimer: ReturnType<typeof setTimeout> | null = null
    private _scrollbarDragging = false
    /** "Exit zoom" chip shown in the pane's top-right corner while zoomed. */
    private _zoomIndicator: HTMLElement | null = null

    constructor(injector: Injector) {
        super(injector)
        // The host element is the pane container positioned by
        // TmuxSessionTabComponent.applyPixelLayout().
        this._paneHost = injector.get(ElementRef<HTMLElement>).nativeElement
    }

    ngOnInit(): void {
        // Profile must be set BEFORE calling super.ngOnInit() because
        // the parent class configures the terminal frontend using profile settings
        this.profile = {
            name: `Tmux Pane %${this.paneId}`,
            type: 'tmux',
            options: {},
            // Required properties for BaseTerminalTabComponent
            behaviorOnSessionEnd: 'close',
            terminalColorScheme: null, // Use default
        }
        this.setTitle(`Pane %${this.paneId}`)

        // Now call parent's ngOnInit to set up the frontend.
        // NOTE: super.ngOnInit() schedules a setImmediate that checks
        // this.hasFocus to decide whether to attach the xterm frontend.
        // BaseTabComponent sets hasFocus=true on focused$.next().
        // We emit focus synchronously right after super.ngOnInit() so that
        // when setImmediate fires, hasFocus is already true.
        super.ngOnInit()

        // Mark this tab as focused so the setImmediate in super.ngOnInit
        // will attach the frontend to the DOM element.
        // This is safe because our overridden focus() doesn't blur siblings.
        this.emitFocused()

        // Initialize our session AFTER emitting focus, so that:
        // 1. frontend.attach() runs via setImmediate (because hasFocus=true)
        // 2. frontend.resize$ fires, which triggers releaseInitialDataBuffer()
        // 3. Then session.start() populates the buffer and it gets released
        //
        // The key insight: setImmediate fires before our async session.start(),
        // so the frontend is attached before history restore begins. This means
        // history output goes directly to the terminal, not into a buffer that
        // gets flushed in a bulk dump.
        this.initializeSession()

        // tmux owns the cell grid. Once the frontend is ready, neutralize
        // xterm's automatic fit-to-container so the pane never overrides the
        // tmux-dictated grid with its own (pixel-rounded) size — that mismatch
        // is what causes off-by-one wrapping / cursor errors. The grid is set
        // explicitly via setTmuxGrid() from applyPixelLayout() instead.
        this.frontendReady$.pipe(first()).subscribe(() => {
            this._frontendReady = true
            const frontend = this.frontend as any
            if (frontend) {
                frontend.enableResizing = false
                // The frontend's resizeHandler (window resize + ResizeObserver)
                // calls fitAddon.fit() unconditionally and ignores enableResizing.
                // Replace fit() with a no-op so the grid stays exactly what tmux
                // tells us. Keep a reference in case we ever need to restore it.
                if (frontend.fitAddon && typeof frontend.fitAddon.fit === 'function') {
                    frontend.fitAddon.fit = () => {
                        /* tmux-authoritative: no auto-fit */
                    }
                }
            }
            // Apply any grid size that arrived before the frontend was ready.
            //
            // IMPORTANT: Defer with setTimeout(0) to avoid re-entrant xterm.resize().
            // frontendReady$ fires inside the onResize callback of fitAddon.fit()'s
            // xterm.resize(N, M). Calling xterm.resize(tmuxCols, tmuxRows) from
            // within that callback is re-entrant — the outer resize continues its
            // internal bookkeeping after onResize returns and overwrites our changes.
            // Deferring ensures applyTmuxGrid() runs after fitAddon.fit() and the
            // outer resize have fully completed.
            if (this._tmuxCols > 0 && this._tmuxRows > 0) {
                setTimeout(() => this.applyTmuxGrid(), 0)
            }
            // Set up the custom overlay scrollbar once the xterm DOM is
            // attached (frontendReady$ fires after frontend.attach()). On
            // xterm 6+ hosts setupScrollbar() detects the virtual-scroll
            // model and skips the custom bar, leaving the built-in overlay
            // scrollbar in charge.
            setTimeout(() => this.setupScrollbar(), 0)
        })
    }

    /**
     * Set the authoritative cell grid for this pane, as dictated by the tmux
     * layout string. tmux decides each pane's exact character width/height, so
     * we resize the xterm grid to match instead of letting xterm fit to pixels.
     * This keeps wrapping aligned with tmux and removes the resize feedback loop.
     */
    setTmuxGrid(cols: number, rows: number): void {
        if (cols <= 0 || rows <= 0) return
        if (cols === this._tmuxCols && rows === this._tmuxRows) return
        this._tmuxCols = cols
        this._tmuxRows = rows
        if (this._frontendReady) {
            this.applyTmuxGrid()
        }
    }

    private applyTmuxGrid(): void {
        const xterm = (this.frontend as any)?.xterm
        if (!xterm) return
        if (xterm.cols !== this._tmuxCols || xterm.rows !== this._tmuxRows) {
            try {
                xterm.resize(this._tmuxCols, this._tmuxRows)
            } catch (e) {
                this.logger.warn(`Failed to resize pane %${this.paneId} grid`, e)
            }
        }

        // xterm.resize() clears the alternate screen buffer.
        // Re-apply saved alternate content if this pane was on it.
        const session = this.session as any
        if (session?.pendingAltRestore && this.controller) {
            this.controller.reapplyAltContent(session)
        }

        // Grid change alters the scroll metrics — refresh the scrollbar thumb.
        this.updateScrollbarThumb()

        // The pane's xterm now renders at the tmux layout column width —
        // release the pending history restore. TmuxPaneSession.start() waits
        // for this so history lines are written at the correct width instead
        // of xterm's initial fit-based (fallback-font) columns, which would
        // wrap logical lines wrongly until a manual resize reflows them.
        session?.gridApplied?.()
    }

    /**
     * Create the custom overlay scrollbar for this pane.
     *
     * Only applies to the xterm 5.4 native-viewport scroll model, where
     * `.xterm-viewport` is the scroll container and its native scrollbar was
     * hidden by CSS. On xterm 6+ hosts the scrollbar is a separate DOM element
     * (`.xterm-scrollable-element > .scrollbar`) that is already overlay and
     * layout-neutral — that structure is detected and the custom bar is
     * skipped so it never duplicates the built-in one.
     */
    private setupScrollbar(): void {
        if (this._scrollbarTrack) return

        // xterm 6+ virtual-scroll model: the built-in overlay scrollbar
        // exists, no custom bar needed.
        if (this._paneHost.querySelector('.xterm-scrollable-element')) {
            this.logger.info(
                `Pane %${this.paneId}: xterm 6+ scroll model, using built-in scrollbar`,
            )
            return
        }

        // NOTE: no isConnected check here — this runs right after
        // frontendReady$, which may fire before the pane's view is mounted
        // into the DOM. Appending to a detached host is fine; the scrollbar
        // becomes visible once the host is attached, and scroll /
        // ResizeObserver events keep the thumb in sync afterwards.
        const viewport = this._paneHost.querySelector<HTMLElement>('.xterm-viewport')
        if (!viewport) {
            this.logger.info(
                `Pane %${this.paneId}: no .xterm-viewport found, skipping custom scrollbar`,
            )
            return
        }
        this._scrollbarViewport = viewport

        // Build track + thumb; the thumb position/size is driven in JS.
        const track = document.createElement('div')
        track.className = 'tmux-pane-scrollbar'
        const thumb = document.createElement('div')
        thumb.className = 'tmux-pane-scrollbar-thumb'
        track.appendChild(thumb)
        this._paneHost.appendChild(track)
        this._scrollbarTrack = track
        this._scrollbarThumb = thumb

        // Keep the thumb in sync with viewport scrolling (wheel, keyboard,
        // drag, programmatic scrollTop changes).
        this.addEventListenerUntilDestroyed(viewport, 'scroll', () => {
            this.updateScrollbarThumb()
            this.showScrollbarTemporarily()
        })

        // History growth / grid resize change the content height → re-measure.
        // Observe both the screen (content height) and the viewport (its own
        // height affects the thumb ratio).
        const screen = viewport.querySelector<HTMLElement>('.xterm-screen') ?? viewport
        this._scrollbarResizeObserver = new ResizeObserver(() => this.updateScrollbarThumb())
        this._scrollbarResizeObserver.observe(screen)
        this._scrollbarResizeObserver.observe(viewport)

        // Interactions: click on the track jumps; drag on the thumb scrolls.
        this.addEventListenerUntilDestroyed(track, 'mousedown', (e: MouseEvent) =>
            this.onScrollbarTrackMouseDown(e),
        )
        this.addEventListenerUntilDestroyed(thumb, 'mousedown', (e: MouseEvent) =>
            this.startScrollbarDrag(e),
        )
        this.addEventListenerUntilDestroyed(track, 'mouseenter', () => {
            this.clearScrollbarHideTimer()
            track.classList.add('visible')
        })
        this.addEventListenerUntilDestroyed(track, 'mouseleave', () => {
            if (!this._scrollbarDragging) {
                this.scheduleScrollbarHide()
            }
        })

        this.logger.info(`Pane %${this.paneId}: custom overlay scrollbar created`)
        this.updateScrollbarThumb()
    }

    /**
     * Recompute the thumb position/size from the viewport's scroll metrics.
     * Hides the bar entirely when there is nothing to scroll.
     */
    private updateScrollbarThumb(): void {
        const viewport = this._scrollbarViewport
        const track = this._scrollbarTrack
        const thumb = this._scrollbarThumb
        if (!viewport || !track || !thumb) return

        const { scrollTop, scrollHeight, clientHeight } = viewport
        if (scrollHeight <= clientHeight) {
            // Nothing to scroll — keep the bar hidden.
            thumb.style.display = 'none'
            track.classList.remove('visible')
            return
        }
        thumb.style.display = 'block'

        const trackHeight = track.clientHeight
        if (trackHeight <= 0) return
        const thumbHeight = Math.max(24, trackHeight * (clientHeight / scrollHeight))
        thumb.style.height = `${thumbHeight}px`

        const maxScroll = scrollHeight - clientHeight
        const maxTrack = trackHeight - thumbHeight
        const thumbTop = maxScroll > 0 ? (scrollTop / maxScroll) * maxTrack : 0
        thumb.style.top = `${thumbTop}px`
    }

    /** Show the scrollbar and auto-hide it shortly after scrolling stops. */
    private showScrollbarTemporarily(): void {
        this._scrollbarTrack?.classList.add('visible')
        this.scheduleScrollbarHide()
    }

    private scheduleScrollbarHide(): void {
        this.clearScrollbarHideTimer()
        this._scrollbarHideTimer = setTimeout(() => this.hideScrollbar(), 600)
    }

    private clearScrollbarHideTimer(): void {
        if (this._scrollbarHideTimer !== null) {
            clearTimeout(this._scrollbarHideTimer)
            this._scrollbarHideTimer = null
        }
    }

    private hideScrollbar(): void {
        if (this._scrollbarDragging) return
        this._scrollbarTrack?.classList.remove('visible')
    }

    /**
     * Click on the scrollbar track (outside the thumb) jumps to that position.
     */
    private onScrollbarTrackMouseDown(event: MouseEvent): void {
        if (event.button !== 0) return
        const viewport = this._scrollbarViewport
        const track = this._scrollbarTrack
        if (!viewport || !track) return
        event.preventDefault()
        const rect = track.getBoundingClientRect()
        if (rect.height <= 0) return
        const ratio = (event.clientY - rect.top) / rect.height
        viewport.scrollTop = ratio * (viewport.scrollHeight - viewport.clientHeight)
        this.showScrollbarTemporarily()
    }

    /**
     * Drag the thumb to scroll the viewport.
     *
     * Document-level listeners are registered manually and removed in onUp.
     * If the pane is destroyed mid-drag the closures only touch detached DOM
     * elements (no-ops), so no leak or crash; a mouseup always follows.
     */
    private startScrollbarDrag(event: MouseEvent): void {
        if (event.button !== 0) return
        const viewport = this._scrollbarViewport
        const track = this._scrollbarTrack
        const thumb = this._scrollbarThumb
        if (!viewport || !track || !thumb) return
        event.preventDefault()
        event.stopPropagation()
        this._scrollbarDragging = true
        track.classList.add('visible')

        const startY = event.clientY
        const startScrollTop = viewport.scrollTop
        const maxScroll = viewport.scrollHeight - viewport.clientHeight

        const onMove = (ev: MouseEvent): void => {
            const trackHeight = track.clientHeight
            const thumbHeight = thumb.clientHeight
            const usable = trackHeight - thumbHeight
            if (usable <= 0) return
            const ratio = (ev.clientY - startY) / usable
            viewport.scrollTop = Math.max(
                0,
                Math.min(maxScroll, startScrollTop + ratio * maxScroll),
            )
            this.showScrollbarTemporarily()
        }
        const onUp = (): void => {
            this._scrollbarDragging = false
            document.removeEventListener('mousemove', onMove)
            document.removeEventListener('mouseup', onUp)
            this.scheduleScrollbarHide()
        }

        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
    }

    override ngOnDestroy(): void {
        this.clearScrollbarHideTimer()
        this._scrollbarResizeObserver?.disconnect()
        this._scrollbarResizeObserver = null
        this._scrollbarTrack?.remove()
        this._scrollbarTrack = null
        this._scrollbarThumb = null
        this._scrollbarViewport = null
        this._zoomIndicator?.remove()
        this._zoomIndicator = null
        super.ngOnDestroy()
    }

    async initializeSession(): Promise<void> {
        if (!this.controller) {
            throw new Error('Tmux controller not provided to pane tab')
        }

        // Create the pane session
        const paneSession = new TmuxPaneSession(this.logger, this.controller, this.paneId)

        // Set up the terminal session first so the frontend is wired.
        // This binds session.output$ → this.write() and frontend → session.
        this.setSession(paneSession, true)

        // Start the session (restores history) non-blocking.
        // History is written to the terminal via emitOutput → write().
        paneSession.start()
    }

    /**
     * Guard sendInput so that only the active pane forwards hotkey-triggered
     * input (Ctrl+C, Home, End, etc.) to its tmux session.
     *
     * When "Focus all tmux panes" is active, input is also broadcast to the
     * sync targets. The scope (current window vs all windows) lives on the
     * controller and is shared by every pane tab.
     */
    override sendInput(data: string | Buffer): void {
        if (!this._tmuxActive) {
            return
        }
        super.sendInput(data)

        // Broadcast to the sync targets when sync mode is active
        if (this.controller && this.controller.getSyncScope() !== 'off') {
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
            for (const pid of this.controller.getSyncTargetPaneIds(this.paneId)) {
                this.controller.writeToPane(pid, buf)
            }
        }
    }

    /**
     * Guard paste so that only the active pane pastes into its tmux session.
     */
    override async paste(): Promise<void> {
        if (!this._tmuxActive) {
            return
        }
        return super.paste()
    }

    /**
     * Always allow closing a tmux pane tab without showing the
     * "command is still running" confirmation dialog.
     * The tmux server process is not a user command — lifetime is
     * managed separately by TmuxService/TmuxController.
     */
    override async canClose(): Promise<boolean> {
        return true
    }

    // Override generic title behavior
    getCustomTitle(): string {
        return `Tmux Pane %${this.paneId}`
    }
    /**
     * Override the native context menu to provide tmux-specific items only.
     * Keeps: Copy, Paste, Close (pane).
     * Adds: Exit Tmux Mode, Split submenu, Zoom pane, Focus all tmux panes
     * submenu (scope: current window or all windows).
     */
    async buildContextMenu(): Promise<MenuItemOptions[]> {
        const items: MenuItemOptions[] = [
            {
                label: this.translate.instant('Copy'),
                click: () => this.frontend?.copySelection(),
            },
            {
                label: this.translate.instant('Paste'),
                click: () => this.paste(),
            },
            { type: 'separator' },
            {
                label: this.translate.instant('Split'),
                submenu: [
                    {
                        label: this.translate.instant('Right'),
                        click: () => this.splitPane('right'),
                    },
                    { label: this.translate.instant('Down'), click: () => this.splitPane('down') },
                    { label: this.translate.instant('Left'), click: () => this.splitPane('left') },
                    { label: this.translate.instant('Up'), click: () => this.splitPane('up') },
                ] as MenuItemOptions[],
            },
            {
                label: this.translate.instant('Zoom pane'),
                type: 'checkbox',
                checked: this._isZoomed,
                // tmux resize-pane -Z on a single-pane window is a no-op
                // (the command fails), so disable the toggle unless there
                // is another pane to zoom to/from.
                enabled: this._isZoomed || this._windowPaneCount !== 1,
                click: () => this.toggleZoom(),
            },
            {
                label: this.translate.instant('Focus all tmux panes'),
                submenu: [
                    {
                        label: this.translate.instant('Current window'),
                        type: 'checkbox',
                        checked: this.controller?.getSyncScope() === 'window',
                        click: () => this.toggleSyncInput('window'),
                    },
                    {
                        label: this.translate.instant('All windows'),
                        type: 'checkbox',
                        checked: this.controller?.getSyncScope() === 'all',
                        click: () => this.toggleSyncInput('all'),
                    },
                ] as MenuItemOptions[],
            },
            { type: 'separator' },
            {
                label: this.translate.instant('Close'),
                click: () => this.closePane(),
            },
        ]
        return items
    }

    protected override async handleRightMouseDown(event: MouseEvent): Promise<void> {
        // Only hijack right-click for the tmux pane menu when the user actually
        // wants a menu. Otherwise defer to the base handler so that the
        // configured `terminal.rightClick` behaviour (paste / clipboard) works.
        // In paste/clipboard mode the base handleRightMouseUp still opens this
        // pane's context menu on a long press, so the tmux menu stays reachable.
        if (this.config.store.terminal.rightClick === 'menu') {
            event.preventDefault()
            event.stopPropagation()
            this.platform.popupContextMenu(await this.buildContextMenu(), event)
        } else {
            await super.handleRightMouseDown(event)
        }
    }

    /** Whether this pane is currently zoomed (fills the entire window). */
    get _isZoomed(): boolean {
        if (!this.controller || !this.paneId) return false
        // Find which window owns this pane
        for (const ws of this.controller.getAllWindowStates()) {
            if (ws.panes.has(this.paneId)) {
                return ws.zoomedPaneId === this.paneId
            }
        }
        return false
    }

    /**
     * Number of panes in the window that owns this pane (0 when the pane is
     * not yet tracked). tmux's resize-pane -Z is a no-op on single-pane
     * windows, so the zoom toggle must be disabled when this is 1.
     */
    get _windowPaneCount(): number {
        if (!this.controller || !this.paneId) return 0
        return this.controller.getWindowPaneCount(this.paneId)
    }

    /** Toggle zoom via tmux resize-pane -Z (same as prefix+z). */
    private async toggleZoom(): Promise<void> {
        if (!this.controller) return
        await this.controller.zoomPane(this.paneId)
    }

    /**
     * Zoom indicator button — an "Exit zoom" chip pinned to the top-right
     * corner of the pane while it is zoomed. Clicking it un-zooms.
     *
     * Zoom state lives in the controller and only changes with
     * %layout-change, so the session tab calls this after every layout
     * sync / window switch to keep the button in sync with tmux.
     */
    updateZoomIndicator(): void {
        const isZoomed = this._isZoomed
        if (isZoomed && !this._zoomIndicator) {
            this.createZoomIndicator()
        } else if (!isZoomed && this._zoomIndicator) {
            this._zoomIndicator.remove()
            this._zoomIndicator = null
        }
    }

    private createZoomIndicator(): void {
        const indicator = document.createElement('div')
        indicator.className = 'tmux-pane-zoom-indicator'
        indicator.title = this.translate.instant('Exit zoom')
        indicator.textContent = this.translate.instant('Exit zoom')

        // Keep the click away from the pane: mousedown would otherwise
        // focus/select inside the xterm, and the click would bubble to the
        // host's focus-pane handler and issue a redundant select-pane.
        indicator.addEventListener('mousedown', (e) => {
            e.preventDefault()
            e.stopPropagation()
        })
        indicator.addEventListener('click', (e) => {
            e.preventDefault()
            e.stopPropagation()
            this.toggleZoom()
        })

        this._paneHost.appendChild(indicator)
        this._zoomIndicator = indicator
    }

    private async splitPane(direction: 'right' | 'down' | 'left' | 'up'): Promise<void> {
        if (!this.controller) return
        const flagMap: Record<string, string> = {
            right: '-h',
            down: '-v',
            left: '-h -b',
            up: '-v -b',
        }
        await this.controller.gateway.sendCommand(
            `split-window ${flagMap[direction]} -t %${this.paneId}`,
        )
        // No explicit refresh needed — the %layout-change notification
        // from tmux will trigger discoverPanesFromLayout() in TmuxController,
        // which discovers the new pane and emits pane-add with pre-loaded
        // history (iTerm2-style).
    }

    private async closePane(): Promise<void> {
        if (!this.controller) return
        await this.controller.killPane(this.paneId)
    }

    /**
     * Toggle "Focus all tmux panes" (synchronized input) for the given scope:
     * 'window' → panes in the current window (tmux synchronize-panes),
     * 'all' → every pane in the session. Clicking the already-active scope
     * turns sync off. The scope is session-level (controller), so every pane
     * tab agrees on the state.
     */
    private toggleSyncInput(scope: SyncScope): void {
        if (!this.controller) return
        this.controller.setSyncScope(this.controller.getSyncScope() === scope ? 'off' : scope)
    }
}
