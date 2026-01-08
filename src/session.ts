import { Subject } from 'rxjs'
import { BaseSession } from 'tabby-terminal'
import { Logger } from 'tabby-core'
import { Injector } from '@angular/core'

export class TmuxPaneSession extends BaseSession {
    constructor(
        logger: Logger,
        private controller: TmuxControllerSession,
        public paneId: number
    ) {
        super(logger)
        this.open = true
    }

    async start(): Promise<void> {
        this.open = true
    }

    resize(columns: number, rows: number): void {
        this.controller.resizePane(this.paneId, columns, rows)
    }

    write(data: Buffer): void {
        this.controller.writeToPane(this.paneId, data)
    }

    kill(_signal?: string): void {
        // TODO: kill pane
    }

    async gracefullyKillProcess(): Promise<void> {
        // TODO: kill pane gracefully
    }

    supportsWorkingDirectory(): boolean {
        return false
    }

    async getWorkingDirectory(): Promise<string | null> {
        return null
    }

    emitOutputToPane(data: Buffer) {
        this.emitOutput(data)
    }
}

export class TmuxControllerSession extends BaseSession {
    private paneSessions = new Map<number, TmuxPaneSession>()
    private buffer = ''

    public events = new Subject<any>()

    constructor(
        logger: Logger,
        _injector: Injector,
        public underlyingSession: BaseSession // The session running tmux -CC (e.g. SSH)
    ) {
        super(logger)
        this.underlyingSession.output$.subscribe(data => this.handleOutput(data))
        this.underlyingSession.binaryOutput$.subscribe(_data => {
            // We mainly use string output for protocol, but binary might be needed for efficient output handling
        })
        this.underlyingSession.closed$.subscribe(() => this.destroy())
    }

    async start(): Promise<void> {
        this.open = true
    }

    resize(columns: number, rows: number): void {
        this.underlyingSession.resize(columns, rows)
    }

    write(data: Buffer): void {
        this.underlyingSession.write(data)
    }

    kill(signal?: string): void {
        this.underlyingSession.kill(signal)
    }

    async gracefullyKillProcess(): Promise<void> {
        await this.underlyingSession.gracefullyKillProcess()
    }

    supportsWorkingDirectory(): boolean {
        return this.underlyingSession.supportsWorkingDirectory()
    }

    async getWorkingDirectory(): Promise<string | null> {
        return this.underlyingSession.getWorkingDirectory()
    }

    resizePane(_paneId: number, _columns: number, _rows: number) {
        // tmux command to resize pane?
        // Actually tmux handles resizing based on layout changes usually or we send client resize.
        // In control mode, we might trust tmux or send commands.
    }

    writeToPane(_paneId: number, data: Buffer) {
        // We probably don't need to wrap input in control mode?
        // Or do we?
        // In -CC mode, stdin is sent to tmux client, which forwards to active pane?
        // No, we need to target specific pane.
        // Tmux -CC input: simply write to stdin?
        // If we simply write to stdin, it goes to the currently active pane in tmux?
        // We might not be able to send to background panes easily without switching?
        // Actually, normal input goes to active pane.
        this.write(data)
    }

    private handleOutput(data: string) {
        // Simple parser
        this.buffer += data
        const lines = this.buffer.split('\n')
        if (lines.length > 1) {
            this.buffer = lines.pop()!
            for (const line of lines) {
                this.parseLine(line)
            }
        }
    }

    private parseLine(line: string) {
        if (line.startsWith('%output')) {
            // %output %<pane> <content...>
            const parts = line.split(' ')
            const paneIdStr = parts[1]
            if (paneIdStr && paneIdStr.startsWith('%')) {
                const paneId = parseInt(paneIdStr.substring(1))
                // const _content = parts.slice(2).join(' ')
                if (this.paneSessions.has(paneId)) {
                    // this.paneSessions.get(paneId)!.emitOutputToPane(Buffer.from(content))
                }
            }
        } else if (line.startsWith('%begin')) {
            this.events.next({ type: 'begin' })
        } else if (line.startsWith('%end')) {
            this.events.next({ type: 'end' })
        } else if (line.startsWith('@session-changed')) {
            this.events.next({ type: 'session-changed' })
        } else if (line.startsWith('@window-add')) {
            // @window-add <window-id>
            const parts = line.split(' ')
            this.events.next({ type: 'window-add', windowId: parts[1] })
        } else if (line.startsWith('@pane-add')) {
            // @pane-add <window-id> <pane-id>
            this.events.next({ type: 'pane-add', line })
        } else {
            // Protocol message
            this.emitOutput(Buffer.from(line + '\r\n'))
        }
    }
}
