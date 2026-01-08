import { Component, Injector, OnInit, OnDestroy } from '@angular/core'
import { Subject, Subscription } from 'rxjs'
import { AppService, BaseTabComponent, LogService, Logger } from 'tabby-core'
import { PTYInterface, PTYProxy } from 'tabby-local'
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

    private pty: PTYProxy
    private logger: Logger
    private outputSubscription: Subscription

    constructor(
        protected injector: Injector,
        private appService: AppService,
        log: LogService,
    ) {
        super(injector)
        this.logger = log.create('tmux')
        this.profile = {} as TmuxProfile
    }

    ngOnInit(): void {
        this.initializeSession()
    }

    async initializeSession(): Promise<void> {
        try {
            const ptyInterface = this.injector.get(PTYInterface)
            const cmd = 'tmux'
            const args = ['-CC', 'new', '-A', '-s', this.profile.sessionName || 'default']

            this.pty = await ptyInterface.spawn(cmd, args, {
                env: { ...process.env }, // Ensure plain object
                cwd: process.env.HOME,
                name: 'xterm-256color',
                cols: 80,
                rows: 30, // Or get from host
            })

            const output$ = new Subject<string>()
            const binaryOutput$ = new Subject<Buffer>()
            const closed$ = new Subject<void>()

            this.pty.subscribe('data', (data: any) => {
                // data might be Uint8Array or Buffer
                let str: string
                if (Buffer.isBuffer(data)) {
                    str = data.toString('utf-8')
                } else if (data instanceof Uint8Array) {
                    str = new TextDecoder().decode(data)
                } else {
                    str = data.toString()
                }
                output$.next(str)
                // binaryOutput$.next(data) // Optional
                this.lastOutput = str
            })

            this.pty.subscribe('exit', () => {
                closed$.next()
                this.destroy()
            })

            this.pty.subscribe('close', () => {
                closed$.next()
                this.destroy()
            })

            const underlyingSession = {
                output$,
                binaryOutput$,
                closed$,
                resize: (w: number, h: number) => this.pty.resize(w, h),
                write: (data: Buffer) => this.pty.write(data),
                kill: () => this.pty.kill(),
                gracefullyKillProcess: async () => this.pty.kill(),
                supportsWorkingDirectory: () => false,
                getWorkingDirectory: async () => null
            } as any

            this.session = new TmuxControllerSession(this.logger, this.injector, underlyingSession)

            this.outputSubscription = this.session.events.subscribe(event => {
                if (event.type === 'pane-add' && event.paneId !== undefined) {
                    const paneId = event.paneId
                    // Check if we already have a tab for this pane
                    if (!this.session.hasPaneSession(paneId)) {
                        this.openPaneTab(paneId)
                    }
                }
            })

            await this.session.start()
        } catch (e) {
            this.lastOutput = `Error starting tmux: ${e.message}`
            throw e
        }
    }

    private pendingPanes = new Set<number>()

    async openPaneTab(paneId: number): Promise<void> {
        if (this.pendingPanes.has(paneId)) {
            return
        }
        this.pendingPanes.add(paneId)
        try {
            await this.appService.openNewTab(
                {
                    type: TmuxPaneTabComponent as any,
                    inputs: {
                        controller: this.session,
                        paneId,
                    }
                }
            )
        } finally {
            this.pendingPanes.delete(paneId)
        }
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
