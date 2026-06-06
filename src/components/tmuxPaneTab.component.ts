import { Component, Injector, Input, OnInit } from '@angular/core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { TmuxController, TmuxPaneSession } from '../session'

@Component({
    selector: 'tmux-pane-tab',
    template: BaseTerminalTabComponent.template,
    styles: BaseTerminalTabComponent.styles,
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

    constructor(injector: Injector) {
        super(injector)
        // Don't initialize profile here - paneId is not yet available
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
        // paneSession.start() will wait for the controller to have a
        // valid client size before calling capture-pane, ensuring the
        // output width matches the xterm display width.
        paneSession.start()
    }

    /**
     * Guard sendInput so that only the active pane forwards hotkey-triggered
     * input (Ctrl+C, Home, End, etc.) to its tmux session.
     *
     * Normal terminal input from xterm (frontend.input$) also goes through
     * sendInput(), but only the pane with actual DOM focus generates xterm
     * input events, so this guard is safe.
     */
    override sendInput(data: string | Buffer): void {
        if (!this._tmuxActive) {
            return
        }
        super.sendInput(data)
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

    // Override generic title behavior
    getCustomTitle(): string {
        return `Tmux Pane %${this.paneId}`
    }
}
