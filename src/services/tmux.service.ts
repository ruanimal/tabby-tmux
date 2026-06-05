import { Injectable, Injector } from '@angular/core'
import { AppService, LogService, Logger, SelectorService, SelectorOption } from 'tabby-core'
import { PTYInterface, PTYProxy } from 'tabby-local'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { Subscription } from 'rxjs'
import { TmuxController } from '../session'

import { TmuxSessionTabComponent } from '../components/tmuxSessionTab.component'

/**
 * TmuxService manages the tmux integration and provides a way to show the tmux session selector.
 * Each connected tmux session is represented by a single TmuxSessionTabComponent.
 */
interface SessionContext {
    controller: TmuxController
    pty?: PTYProxy
    terminalTab?: BaseTerminalTabComponent<any>
    sessionTab?: TmuxSessionTabComponent
    subscriptions: Subscription[]
}

@Injectable({ providedIn: 'root' })
export class TmuxService {
    private logger: Logger
    private sessions = new Set<SessionContext>()

    constructor(
        private injector: Injector,
        private appService: AppService,
        private selectorService: SelectorService,
        log: LogService,
    ) {
        this.logger = log.create('tmux-service')
    }

    // Simplified getters/status for backward compatibility or UI
    get isConnected(): boolean {
        return this.sessions.size > 0
    }

    get controller(): TmuxController | null {
        // Return the first controller if any
        return this.sessions.values().next().value?.controller || null
    }

    /**
     * Show the tmux session manager
     */
    async showTmuxManager(): Promise<void> {
        // Simple selector for now
        await this.showSessionSelector()
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

    // showPaneSelector removed as it's not relevant with tab-based window management


    /**
     * Connect to a tmux session (spawn local PTY)
     */
    async connectToSession(sessionName: string = 'default'): Promise<void> {
        try {
            const ptyInterface = this.injector.get(PTYInterface)
            const cmd = 'tmux'
            const args = ['-CC', 'new', '-A', '-s', sessionName]

            const pty = await ptyInterface.spawn(cmd, args, {
                env: { ...process.env },
                cwd: process.env.HOME,
                name: 'xterm-256color',
                cols: 80,
                rows: 30,
            })

            const context: SessionContext = {
                controller: null!, // Set below
                pty,
                subscriptions: []
            }

            let buffer = ''

            // Create controller
            context.controller = new TmuxController(
                this.logger,
                this.injector,
                (data: string) => pty.write(Buffer.from(data)),
                () => this.disconnectContext(context)
            )

            // Parse output
            pty.subscribe('data', (data: any) => {
                let str: string
                if (Buffer.isBuffer(data)) {
                    str = data.toString('utf-8')
                } else if (data instanceof Uint8Array) {
                    str = new TextDecoder().decode(data)
                } else {
                    str = data.toString()
                }

                buffer += str
                const lines = buffer.split('\n')
                if (lines.length > 1) {
                    buffer = lines.pop()!
                    for (const line of lines) {
                        context.controller.handleLine(line)
                    }
                }
            })

            pty.subscribe('exit', () => {
                this.disconnectContext(context)
            })

            pty.subscribe('close', () => {
                this.disconnectContext(context)
            })

            this.sessions.add(context)
            this.setupControllerEvents(context)

            this.logger.info(`Connecting to local tmux session: ${sessionName}`)

        } catch (e) {
            this.logger.error('Error starting tmux:', e)
            throw e
        }
    }

    private setupControllerEvents(context: SessionContext): void {
        context.subscriptions.push(context.controller.events.subscribe(event => {
            // On initialized, open the session tab if not already open
            if (event.type === 'initialized' && !context.sessionTab) {
                this.openSessionTab(context)
            }
        }))
    }

    private async openSessionTab(context: SessionContext): Promise<void> {
        if (context.sessionTab) return

        const tab = this.appService.openNewTab({
            type: TmuxSessionTabComponent as any,
            inputs: {
                existingController: context.controller,
                profile: {
                    sessionName: context.controller.getSessionName(),
                },
            }
        }) as any as TmuxSessionTabComponent

        context.sessionTab = tab

        // Handle tab closure by user
        context.subscriptions.push(tab.destroyed$.subscribe(() => {
            context.sessionTab = undefined
        }))
    }

    async disconnectContext(context: SessionContext): Promise<void> {
        this.sessions.delete(context)

        context.subscriptions.forEach(s => s.unsubscribe())

        await context.controller.destroy()

        if (context.pty) {
            context.pty.kill()
        }

        // Close session tab if open
        if (context.sessionTab) {
            context.sessionTab.destroy()
            context.sessionTab = undefined
        }

        this.logger.info('Disconnected tmux context')
    }

    /**
     * Disconnect from all sessions
     */
    async disconnect(): Promise<void> {
        for (const context of this.sessions) {
            await this.disconnectContext(context)
        }
    }


    /**
     * Attach to tmux from an existing terminal tab.
     * This sends `tmux -CC` to the terminal's session and parses the control mode output.
     */
    /**
     * Attach to tmux from an existing terminal tab.
     */
    async attachToTerminal(terminalTab: BaseTerminalTabComponent<any>): Promise<void> {
        const session = terminalTab.session
        if (!session) {
            this.logger.error('Terminal tab has no session')
            return
        }

        this.logger.info('Attaching tmux to existing terminal session')

        const context: SessionContext = {
            controller: null!, // Set below
            terminalTab,
            subscriptions: []
        }

        let buffer = ''

        // Create a controller that uses the terminal's session for I/O
        context.controller = new TmuxController(
            this.logger,
            this.injector,
            (data: string) => session.write(Buffer.from(data)),
            () => this.disconnectContext(context)
        )

        // Subscribe to the terminal's output to parse tmux control mode
        context.subscriptions.push(session.output$.subscribe((data: string) => {
            buffer += data
            const lines = buffer.split('\n')
            if (lines.length > 1) {
                buffer = lines.pop()!
                for (const line of lines) {
                    context.controller.handleLine(line)
                }
            }
        }))

        // Handle terminal tab closure
        context.subscriptions.push(terminalTab.destroyed$.subscribe(() => {
            this.logger.info('Attached terminal tab closed, disconnecting session')
            this.disconnectContext(context)
        }))

        this.sessions.add(context)
        this.setupControllerEvents(context)

        // Send the tmux -CC command to the terminal
        session.write(Buffer.from('tmux -CC new -A -s default\n'))
    }

    // replaceTabWithTmuxWindow removed as we open new tabs for windows instead

}

