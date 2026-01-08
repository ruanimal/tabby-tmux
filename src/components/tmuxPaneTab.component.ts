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

        // Now call parent's ngOnInit to set up the frontend
        super.ngOnInit()

        // Initialize our session after the frontend is ready
        this.initializeSession()
    }

    async initializeSession(): Promise<void> {
        if (!this.controller) {
            throw new Error('Tmux controller not provided to pane tab')
        }

        // Create the pane session
        const paneSession = new TmuxPaneSession(this.logger, this.controller, this.paneId)
        await paneSession.start()

        // Use the parent class's setSession method - this properly binds:
        // - session.output$ -> this.write() (display output)
        // - frontend.input$ -> session.feedFromTerminal() (user input)
        // - session.closed$ -> tab close handling
        // - resize events
        //
        // IMPORTANT: BaseTerminalTabComponent will automatically call
        // session.releaseInitialDataBuffer() when the frontend is ready
        // (see BaseTerminalTabComponent.ngOnInit, line 398 in tabby-terminal),
        // so we DON'T need to do it manually here.
        this.setSession(paneSession, true)

        // If the frontend is already ready and we have a size, send an initial resize
        if (this.frontendIsReady && this.size) {
            paneSession.resize(this.size.columns, this.size.rows)
        }
    }

    // Override generic title behavior
    getCustomTitle(): string {
        return `Tmux Pane %${this.paneId}`
    }
}
