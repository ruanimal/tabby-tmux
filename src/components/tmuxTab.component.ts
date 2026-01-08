import { Component, Injector, OnInit, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'
import { AppService, BaseTabComponent, LogService, Logger } from 'tabby-core'
import { PTYInterface, PTYProxy } from 'tabby-local'
import { TmuxProfile } from '../profiles'
import { TmuxController } from '../session'
import { TmuxPaneTabComponent } from './tmuxPaneTab.component'

@Component({
    selector: 'tmux-tab',
    template: `
        <div class="content-box">
            <div class="tmux-header">
                <h3>
                    <i class="fas fa-layer-group"></i>
                    Tmux Session: {{session?.getSessionName() || profile.sessionName || 'default'}}
                </h3>
                <span class="status-badge" [class.connected]="connected">
                    {{connected ? 'Connected' : 'Connecting...'}}
                </span>
            </div>

            <div class="info-section" *ngIf="connected">
                <div class="pane-list">
                    <div class="pane-header">Active Panes</div>
                    <div *ngFor="let pane of panes" class="pane-item">
                        <span class="pane-id">%{{pane}}</span>
                        <button class="btn btn-sm" (click)="focusPane(pane)">
                            <i class="fas fa-external-link-alt"></i>
                        </button>
                    </div>
                    <div *ngIf="panes.length === 0" class="no-panes">
                        Waiting for panes...
                    </div>
                </div>
            </div>

            <div class="control-section">
                <button class="btn btn-secondary" (click)="toggleLog()">
                    <i class="fas fa-terminal"></i>
                    {{showLog ? 'Hide' : 'Show'}} Protocol Log
                </button>
                <button class="btn btn-danger" (click)="detach()">
                    <i class="fas fa-sign-out-alt"></i>
                    Detach
                </button>
            </div>

            <pre class="protocol-log" *ngIf="showLog">{{protocolLog}}</pre>
        </div>
    `,
    styles: [`
        .content-box {
            padding: 20px;
            height: 100%;
            display: flex;
            flex-direction: column;
        }
        .tmux-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }
        .tmux-header h3 {
            margin: 0;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .status-badge {
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 0.85em;
            background: #dc3545;
            color: white;
        }
        .status-badge.connected {
            background: #28a745;
        }
        .info-section {
            flex: 1;
            overflow-y: auto;
        }
        .pane-list {
            background: rgba(0,0,0,0.2);
            border-radius: 8px;
            padding: 15px;
        }
        .pane-header {
            font-weight: bold;
            margin-bottom: 10px;
            color: #aaa;
        }
        .pane-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 12px;
            background: rgba(255,255,255,0.05);
            border-radius: 4px;
            margin-bottom: 5px;
        }
        .pane-id {
            font-family: monospace;
            color: #6cf;
        }
        .no-panes {
            color: #888;
            font-style: italic;
        }
        .control-section {
            display: flex;
            gap: 10px;
            margin-top: 20px;
            padding-top: 15px;
            border-top: 1px solid rgba(255,255,255,0.1);
        }
        .protocol-log {
            background: #000;
            color: #0f0;
            padding: 10px;
            max-height: 200px;
            overflow-y: auto;
            font-size: 0.75em;
            font-family: monospace;
            margin-top: 15px;
            border-radius: 4px;
        }
    `]
})
export class TmuxTabComponent extends BaseTabComponent implements OnInit, OnDestroy {
    public session: TmuxController
    public profile: TmuxProfile
    public connected = false
    public panes: number[] = []
    public showLog = true
    public protocolLog = ''

    private pty: PTYProxy
    private logger: Logger
    private eventSubscription: Subscription
    private pendingPanes = new Set<number>()
    private buffer = ''

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
                env: { ...process.env },
                cwd: process.env.HOME,
                name: 'xterm-256color',
                cols: 80,
                rows: 30,
            })

            // Create controller with writer and closer
            this.session = new TmuxController(
                this.logger,
                this.injector,
                (data: string) => this.pty.write(Buffer.from(data)),
                () => this.destroy()
            )

            // Subscribe to PTY output and parse lines
            this.pty.subscribe('data', (data: any) => {
                let str: string
                if (Buffer.isBuffer(data)) {
                    str = data.toString('utf-8')
                } else if (data instanceof Uint8Array) {
                    str = new TextDecoder().decode(data)
                } else {
                    str = data.toString()
                }

                // Log for debugging
                this.protocolLog += str
                // Keep log size manageable
                if (this.protocolLog.length > 20000) {
                    this.protocolLog = this.protocolLog.substring(this.protocolLog.length - 10000)
                }

                // Parse lines
                this.buffer += str
                const lines = this.buffer.split('\n')
                if (lines.length > 1) {
                    this.buffer = lines.pop()!
                    for (const line of lines) {
                        this.session.handleLine(line)
                    }
                }
            })

            this.pty.subscribe('exit', () => {
                this.destroy()
            })

            this.pty.subscribe('close', () => {
                this.destroy()
            })

            // Subscribe to controller events
            this.eventSubscription = this.session.events.subscribe(event => {
                this.logger.info('Event received:', event.type, event)

                switch (event.type) {
                    case 'initialized':
                    case 'session-changed':
                        this.connected = true
                        this.logger.info('Connected to tmux session')
                        break

                    case 'pane-add':
                        if (event.paneId !== undefined) {
                            this.logger.info(`Pane-add event for pane %${event.paneId}`)
                            if (!this.panes.includes(event.paneId)) {
                                this.panes = [...this.panes, event.paneId] // Create new array for change detection
                                this.logger.info(`Added pane %${event.paneId}, panes now:`, this.panes)
                                // Auto-open pane tab
                                if (!this.session.hasPaneSession(event.paneId)) {
                                    this.openPaneTab(event.paneId)
                                }
                            } else {
                                this.logger.debug(`Pane %${event.paneId} already in list`)
                            }
                        }
                        break

                    case 'exit':
                        this.connected = false
                        break
                }
            })

        } catch (e) {
            this.logger.error('Error starting tmux:', e)
            this.protocolLog = `Error starting tmux: ${e.message}`
            throw e
        }
    }

    async openPaneTab(paneId: number): Promise<void> {
        if (this.pendingPanes.has(paneId)) {
            return
        }
        this.pendingPanes.add(paneId)
        try {
            await this.appService.openNewTab({
                type: TmuxPaneTabComponent as any,
                inputs: {
                    controller: this.session,
                    paneId,
                }
            })
        } finally {
            this.pendingPanes.delete(paneId)
        }
    }

    focusPane(paneId: number): void {
        // Find the tab for this pane and focus it
        // For now, just open a new tab if not already open
        if (!this.session.hasPaneSession(paneId)) {
            this.openPaneTab(paneId)
        }
    }

    toggleLog(): void {
        this.showLog = !this.showLog
    }

    detach(): void {
        this.session?.detach()
    }

    async destroy(): Promise<void> {
        super.destroy()
        if (this.eventSubscription) {
            this.eventSubscription.unsubscribe()
        }
        if (this.session) {
            await this.session.destroy()
        }
        if (this.pty) {
            this.pty.kill()
        }
    }
}
