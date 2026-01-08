import { Component, Injector, OnInit, OnDestroy } from '@angular/core'
import { spawn, ChildProcess } from 'child_process'
import { Subject, Subscription } from 'rxjs'
import { AppService, BaseTabComponent, LogService, Logger } from 'tabby-core'
import { TmuxProfile } from '../profiles'
import { TmuxControllerSession } from '../session'
import { TmuxPaneTabComponent } from './tmuxPaneTab.component'

@Component({
    selector: 'tmux-tab',
    template: `
        <div class="content-box">
            <div class="row">
                <div class="col-md-12">
                    <h3>Tmux Session: {{profile.sessionName || 'default'}}</h3>
                    <p>Status: Running</p>
                    <pre class="terminal-log" *ngIf="lastOutput">{{lastOutput}}</pre>
                </div>
            </div>
        </div>
    `,
    styles: [`
        .content-box { padding: 20px; }
        .terminal-log { background: #000; color: #aaa; padding: 10px; max-height: 200px; overflow-y: auto; font-size: 0.8em; }
    `]
})
export class TmuxTabComponent extends BaseTabComponent implements OnInit, OnDestroy {
    public session: TmuxControllerSession
    public profile: TmuxProfile
    public lastOutput: string = ''

    private tmuxProcess: ChildProcess
    private logger: Logger
    private outputSubscription: Subscription

    constructor(
        protected injector: Injector,
        private appService: AppService,
        log: LogService,
    ) {
        super(injector)
        this.logger = log.create('tmux')
        this.profile = {} as TmuxProfile // Profile should be passed via inputs in Tabby, but typically appService.openNewTab sets it.
        // BaseTabComponent doesn't handle input injection automatically.
        // We might need to manually handle this if we expect inputs in constructor.
        // But usually, inputs are set on the component instance after creation.
        // Actually BaseTabComponent usually doesn't inject inputs automatically in constructor like this?
        // Tab inputs are assigned to properties.
    }

    ngOnInit(): void {
        this.initializeSession()
    }

    async initializeSession(): Promise<void> {

        try {
            this.tmuxProcess = spawn('tmux', ['-CC', 'new', '-A', '-s', this.profile.sessionName || 'default'])

            const output$ = new Subject<string>()
            const binaryOutput$ = new Subject<Buffer>()
            const closed$ = new Subject<void>()

            this.tmuxProcess.stdout.on('data', (data) => {
                const str = data.toString()
                output$.next(str)
                this.lastOutput = str // For debug view
            })

            this.tmuxProcess.stderr.on('data', (data) => {
                const str = data.toString()
                console.error('Tmux stderr:', str)
                this.lastOutput = `ERR: ${str}`
            })

            this.tmuxProcess.on('close', () => {
                closed$.next()
                this.destroy()
            })

            const underlyingSession = {
                output$,
                binaryOutput$,
                closed$,
                resize: (_w: number, _h: number) => { },
                write: (data: Buffer) => {
                    this.tmuxProcess.stdin.write(data)
                },
                kill: () => this.tmuxProcess.kill(),
                gracefullyKillProcess: async () => this.tmuxProcess.kill(),
                supportsWorkingDirectory: () => false,
                getWorkingDirectory: async () => null
            } as any

            this.session = new TmuxControllerSession(this.logger, this.injector, underlyingSession)

            this.outputSubscription = this.session.events.subscribe(event => {
                if (event.type === 'pane-add') {
                    const parts = event.line.split(' ')
                    const paneId = parseInt(parts[2].replace('%', ''))
                    this.openPaneTab(paneId)
                }
            })

            await this.session.start()
        } catch (e) {
            throw e
        }
    }

    async openPaneTab(paneId: number): Promise<void> {
        this.appService.openNewTab(
            {
                type: TmuxPaneTabComponent as any,
                inputs: {
                    controller: this.session,
                    paneId,
                }
            }
        )
    }

    async destroy(): Promise<void> {
        super.destroy()
        if (this.outputSubscription) {
            this.outputSubscription.unsubscribe()
        }
        if (this.session) {
            await this.session.destroy()
        }
    }
}
