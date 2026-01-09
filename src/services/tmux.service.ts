import { Injectable, Injector } from '@angular/core'
import { AppService, LogService, Logger, SelectorService, SelectorOption } from 'tabby-core'
import { PTYInterface, PTYProxy } from 'tabby-local'
import { Subscription } from 'rxjs'
import { TmuxController } from '../session'
import { TmuxPaneTabComponent } from '../components/tmuxPaneTab.component'

/**
 * TmuxService manages the tmux integration and provides a way to show the tmux session selector.
 * It replaces the need for a dedicated TmuxTabComponent tab.
 */
@Injectable({ providedIn: 'root' })
export class TmuxService {
    private logger: Logger
    private pty: PTYProxy | null = null
    private session: TmuxController | null = null
    private eventSubscription: Subscription | null = null
    private panes: number[] = []
    private pendingPanes = new Set<number>()
    private buffer = ''
    private connected = false

    constructor(
        private injector: Injector,
        private appService: AppService,
        private selectorService: SelectorService,
        log: LogService,
    ) {
        this.logger = log.create('tmux-service')
    }

    get isConnected(): boolean {
        return this.connected
    }

    get controller(): TmuxController | null {
        return this.session
    }

    /**
     * Show the tmux session manager - either connect to existing session or show pane list
     */
    async showTmuxManager(): Promise<void> {
        if (!this.connected || !this.session) {
            // Not connected - show session name selector
            await this.showSessionSelector()
        } else {
            // Connected - show pane list
            await this.showPaneSelector()
        }
    }

    /**
     * Show a selector to choose or create a tmux session
     */
    private async showSessionSelector(): Promise<void> {
        const options: SelectorOption<string>[] = [
            {
                name: 'Connect to tmux (default session)',
                description: 'Attach to or create the default tmux session',
                icon: 'fas fa-layer-group',
                result: 'default',
            },
        ]

        try {
            const sessionName = await this.selectorService.show<string>('Select Tmux Session', options)
            if (sessionName) {
                await this.connectToSession(sessionName)
            }
        } catch {
            // User cancelled
        }
    }

    /**
     * Show a selector with current panes
     */
    private async showPaneSelector(): Promise<void> {
        const options: SelectorOption<number | string>[] = this.panes.map(paneId => ({
            name: `Pane %${paneId}`,
            description: 'Open this pane in a new tab',
            icon: 'fas fa-terminal',
            result: paneId,
        }))

        // Add disconnect option
        options.push({
            name: 'Disconnect from tmux',
            description: `Session: ${this.session?.getSessionName() || 'default'}`,
            icon: 'fas fa-sign-out-alt',
            color: '#dc3545',
            result: '__disconnect__',
        })

        try {
            const result = await this.selectorService.show<number | string>('Tmux Panes', options)
            if (result === '__disconnect__') {
                await this.disconnect()
            } else if (typeof result === 'number') {
                await this.openPaneTab(result)
            }
        } catch {
            // User cancelled
        }
    }

    /**
     * Connect to a tmux session
     */
    async connectToSession(sessionName: string = 'default'): Promise<void> {
        if (this.connected) {
            await this.disconnect()
        }

        try {
            const ptyInterface = this.injector.get(PTYInterface)
            const cmd = 'tmux'
            const args = ['-CC', 'new', '-A', '-s', sessionName]

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
                (data: string) => this.pty!.write(Buffer.from(data)),
                () => this.disconnect()
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

                // Parse lines
                this.buffer += str
                const lines = this.buffer.split('\n')
                if (lines.length > 1) {
                    this.buffer = lines.pop()!
                    for (const line of lines) {
                        this.session?.handleLine(line)
                    }
                }
            })

            this.pty.subscribe('exit', () => {
                this.disconnect()
            })

            this.pty.subscribe('close', () => {
                this.disconnect()
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
                            if (!this.panes.includes(event.paneId)) {
                                this.panes = [...this.panes, event.paneId]
                                this.logger.info(`Added pane %${event.paneId}`)
                                // Auto-open pane tab
                                if (!this.session!.hasPaneSession(event.paneId)) {
                                    this.openPaneTab(event.paneId)
                                }
                            }
                        }
                        break

                    case 'exit':
                        this.connected = false
                        break
                }
            })

            this.logger.info(`Connecting to tmux session: ${sessionName}`)

        } catch (e) {
            this.logger.error('Error starting tmux:', e)
            throw e
        }
    }

    /**
     * Open a pane in a new tab
     */
    async openPaneTab(paneId: number): Promise<void> {
        if (this.pendingPanes.has(paneId)) {
            return
        }
        if (!this.session) {
            throw new Error('Not connected to tmux')
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

    /**
     * Disconnect from tmux
     */
    async disconnect(): Promise<void> {
        if (this.eventSubscription) {
            this.eventSubscription.unsubscribe()
            this.eventSubscription = null
        }
        if (this.session) {
            await this.session.destroy()
            this.session = null
        }
        if (this.pty) {
            this.pty.kill()
            this.pty = null
        }
        this.connected = false
        this.panes = []
        this.buffer = ''
        this.pendingPanes.clear()
        this.logger.info('Disconnected from tmux')
    }
}
