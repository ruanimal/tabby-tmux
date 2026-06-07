import { Component, Injector, Input, OnInit } from '@angular/core'
import { first } from 'rxjs'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { MenuItemOptions } from 'tabby-core'
import { TmuxController, TmuxPaneSession } from '../session'

@Component({
    selector: 'tmux-pane-tab',
    template: BaseTerminalTabComponent.template,
    styles: [
        ...BaseTerminalTabComponent.styles,
        require('./tmuxPaneTab.component.scss'),
    ],
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
     * When true, input is broadcast to all panes in the tmux session
     * ("Focus all tmux panes" / synchronize-panes mode).
     * Toggled via the right-click context menu.
     */
    _tmuxSyncInput = false

    /** Desired tmux grid size (chars). tmux is authoritative over the cell grid. */
    private _tmuxCols = 0
    private _tmuxRows = 0
    /** Whether the xterm frontend has been attached and is ready. */
    private _frontendReady = false

    constructor(injector: Injector) {
        super(injector)
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
            terminalColorScheme: null,  // Use default
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
        // explicitly via setTmuxGrid() from the layout sync instead.
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
                    frontend.fitAddon.fit = () => { /* tmux-authoritative: no auto-fit */ }
                }
            }
            // Apply any grid size that arrived before the frontend was ready.
            if (this._tmuxCols > 0 && this._tmuxRows > 0) {
                this.applyTmuxGrid()
            }
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
        if (xterm.cols === this._tmuxCols && xterm.rows === this._tmuxRows) return
        try {
            xterm.resize(this._tmuxCols, this._tmuxRows)
        } catch (e) {
            this.logger.warn(`Failed to resize pane %${this.paneId} grid`, e)
        }
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
     * When _tmuxSyncInput is enabled ("Focus all tmux panes"), input is also
     * broadcast to all other panes in the session.
     */
    override sendInput(data: string | Buffer): void {
        if (!this._tmuxActive) {
            return
        }
        super.sendInput(data)

        // Broadcast to all other panes when sync mode is active
        if (this._tmuxSyncInput && this.controller) {
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
            for (const pid of this.controller.getAllPaneIds()) {
                if (pid !== this.paneId) {
                    this.controller.writeToPane(pid, buf)
                }
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
     * Adds: Exit Tmux Mode, Split submenu, Focus all tmux panes.
     */
    async buildContextMenu (): Promise<MenuItemOptions[]> {
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
                    { label: this.translate.instant('Right'), click: () => this.splitPane('right') },
                    { label: this.translate.instant('Down'), click: () => this.splitPane('down') },
                    { label: this.translate.instant('Left'), click: () => this.splitPane('left') },
                    { label: this.translate.instant('Up'), click: () => this.splitPane('up') },
                ] as MenuItemOptions[],
            },
            {
                label: this.translate.instant('Focus all tmux panes'),
                type: 'checkbox',
                checked: this._tmuxSyncInput,
                click: () => this.toggleSyncInput(),
            },
            { type: 'separator' },
            {
                label: this.translate.instant('Close'),
                click: () => this.closePane(),
            },
        ]
        return items
    }

    protected override async handleRightMouseDown (event: MouseEvent): Promise<void> {
        event.preventDefault()
        event.stopPropagation()
        this.platform.popupContextMenu(await this.buildContextMenu(), event)
    }

    private async splitPane (direction: 'right' | 'down' | 'left' | 'up'): Promise<void> {
        if (!this.controller) return
        const flagMap: Record<string, string> = {
            'right': '-h',
            'down': '-v',
            'left': '-h -b',
            'up': '-v -b',
        }
        await this.controller.gateway.sendCommand(
            `split-window ${flagMap[direction]} -t %${this.paneId}`
        )
        // No explicit refresh needed — the %layout-change notification
        // from tmux will trigger discoverPanesFromLayout() in TmuxController,
        // which discovers the new pane and emits pane-add with pre-loaded
        // history (iTerm2-style).
    }

    private async closePane (): Promise<void> {
        if (!this.controller) return
        await this.controller.killPane(this.paneId)
    }

    /**
     * Toggle "Focus all tmux panes" (synchronize input) across all panes
     * in the current tmux session.
     */
    private toggleSyncInput (): void {
        if (!this.controller) return
        const newValue = !this._tmuxSyncInput
        for (const pid of this.controller.getAllPaneIds()) {
            const tab = this.findPaneTab(pid)
            if (tab) {
                tab._tmuxSyncInput = newValue
            }
        }
    }

    private findPaneTab (paneId: number): TmuxPaneTabComponent | null {
        // Walk the session tab's window pane map to find the tab
        const parent = this.parent as any
        if (parent?.windowPaneTabs) {
            for (const paneMap of parent.windowPaneTabs.values()) {
                const tab = paneMap.get(paneId)
                if (tab) return tab
            }
        }
        return null
    }
}
