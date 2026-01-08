import { Component, Injector, Input, OnInit } from '@angular/core'
import { first } from 'rxjs'
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
        // console.log(`[PaneTab] initializeSession for pane ${this.paneId}`)

        // Create the pane session
        const paneSession = new TmuxPaneSession(this.logger, this.controller, this.paneId)
        await paneSession.start()

        // Use the parent class's setSession method - this properly binds:
        // - session.output$ -> this.write() (display output)
        // - frontend.input$ -> session.feedFromTerminal() (user input)
        // - session.closed$ -> tab close handling
        // - resize events
        this.setSession(paneSession, true)

        // Function to sync size and release initial buffer
        const syncAndRelease = () => {
            if (this.size) {
                // Send terminal size to tmux for proper cursor positioning
                paneSession.resize(this.size.columns, this.size.rows)
            }
            // Release buffered initial output (shell prompt, etc.)
            console.log(`[PaneTab] syncAndRelease pane ${this.paneId}`)
            paneSession.releaseInitialDataBuffer()
        }

        // Handle race condition: frontendReady$ might have already completed
        if (this.frontendIsReady) {
            console.log(`[PaneTab] frontendIsReady=true, calling syncAndRelease immediately`)
            // Frontend already ready, execute immediately
            syncAndRelease()
        } else {
            console.log(`[PaneTab] frontendIsReady=false, waiting for event`)
            // Wait for frontend to be ready
            this.frontendReady$.pipe(first()).subscribe(() => {
                console.log(`[PaneTab] frontendReady$ event received`)
                syncAndRelease()
            })

            // Fallback: if subscription missed the event, try after a delay
            setTimeout(() => {
                if (this.frontendIsReady && this.size) {
                    syncAndRelease()
                }
            }, 500)
        }
    }

    // Override generic title behavior
    getCustomTitle(): string {
        return `Tmux Pane %${this.paneId}`
    }
}
