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
        this.controller.registerPane(this.paneId, this)
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

    /**
     * Called by BaseTerminalTabComponent when the user types in the terminal.
     * This is the main input method for user keyboard input.
     */
    feedFromTerminal(data: Buffer): void {
        this.controller.writeToPane(this.paneId, data)
    }

    kill(_signal?: string): void {
        this.destroy()
    }

    async destroy(): Promise<void> {
        await super.destroy()
        this.controller.unregisterPane(this.paneId)
    }

    async gracefullyKillProcess(): Promise<void> {
        this.destroy()
    }

    supportsWorkingDirectory(): boolean {
        return false
    }

    async getWorkingDirectory(): Promise<string | null> {
        return null
    }

    emitOutputToPane(data: Buffer) {
        // emitOutput expects Buffer - it will be processed through middleware
        this.emitOutput(data)
    }
}

export class TmuxControllerSession extends BaseSession {
    private paneSessions = new Map<number, TmuxPaneSession>()
    private buffer = ''
    private sessionReady = false
    private knownPanes = new Set<number>()
    // Buffer for output received before the pane session is registered
    private pendingPaneOutput = new Map<number, Buffer[]>()

    public events = new Subject<{ type: string; paneId?: number; windowId?: string; line?: string }>()

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
        // Wait a bit for tmux to initialize, then request pane list
        setTimeout(() => {
            this.refreshPanes()
        }, 500)
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

    resizePane(_paneId: number, columns: number, rows: number) {
        // In tmux control mode, we use refresh-client -C to set the client size
        // This affects all panes - tmux control mode requires uniform size
        this.write(Buffer.from(`refresh-client -C ${columns}x${rows}\r`))
    }

    writeToPane(paneId: number, data: Buffer) {
        // We cannot just write to stdin because it goes to the active pane.
        // We must target the specific pane using send-keys.
        // Using -H (hex) avoids escaping issues.
        const hex = data.toString('hex')
        if (hex.length > 0) {
            this.write(Buffer.from(`send-keys -t %${paneId} -H ${hex}\r`))
        }
    }

    registerPane(paneId: number, session: TmuxPaneSession) {
        this.paneSessions.set(paneId, session)

        // Flush any buffered output that was received before the pane session was registered
        const pendingOutput = this.pendingPaneOutput.get(paneId)
        if (pendingOutput && pendingOutput.length > 0) {
            for (const data of pendingOutput) {
                session.emitOutputToPane(data)
            }
            this.pendingPaneOutput.delete(paneId)
        }
    }

    unregisterPane(paneId: number) {
        this.paneSessions.delete(paneId)
        this.pendingPaneOutput.delete(paneId)
    }

    getPaneSession(paneId: number): TmuxPaneSession | undefined {
        return this.paneSessions.get(paneId)
    }

    hasPaneSession(paneId: number): boolean {
        return this.paneSessions.has(paneId)
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
        // Strip DCS sequence artifacts
        line = line.replace(/^\x1bP\d+p/, '').replace(/^P\d+p/, '').replace(/\x1b\\$/, '')

        if (!line) return

        if (line.startsWith('%output')) {
            // %output %<pane> <content...>
            const spaceIdx = line.indexOf(' ', 8)
            if (spaceIdx === -1) return

            const paneIdStr = line.substring(8, spaceIdx)
            const contentStr = line.substring(spaceIdx + 1)

            if (paneIdStr.startsWith('%')) {
                const paneId = parseInt(paneIdStr.substring(1))
                const data = this.unescapeTmuxOutput(contentStr)

                if (this.paneSessions.has(paneId)) {
                    // Pane session exists, send output directly
                    this.paneSessions.get(paneId)?.emitOutputToPane(data)
                } else {
                    // Pane session not yet registered, buffer the output
                    if (!this.pendingPaneOutput.has(paneId)) {
                        this.pendingPaneOutput.set(paneId, [])
                    }
                    this.pendingPaneOutput.get(paneId)!.push(data)
                }
            }
        } else if (line.startsWith('%begin')) {
            this.events.next({ type: 'begin' })
        } else if (line.startsWith('%end')) {
            this.events.next({ type: 'end' })
        } else if (line.startsWith('%session-changed')) {
            this.events.next({ type: 'session-changed' })
            this.refreshPanes()
        } else if (line.startsWith('%window-add')) {
            const parts = line.split(' ')
            this.events.next({ type: 'window-add', windowId: parts[1] })
            this.refreshPanes()
        } else if (line.startsWith('%window-close') || line.startsWith('%unlinked-window-close')) {
            // Handle window close if needed
            this.refreshPanes()
        } else {
            // Check if it looks like a pane ID from our list-panes calls
            if (line.startsWith('TABBY_PANE:')) {
                const paneIdStr = line.substring(11).trim() // TABBY_PANE:%0
                if (paneIdStr.startsWith('%')) {
                    const paneId = parseInt(paneIdStr.substring(1), 10)
                    if (!isNaN(paneId) && !this.knownPanes.has(paneId)) {
                        this.knownPanes.add(paneId)
                        this.events.next({ type: 'pane-add', paneId })
                    }
                }
            }
        }

        // Detect session ready state (tmux prompt or begin/end blocks)
        if (!this.sessionReady && (line.startsWith('%begin') || line.startsWith('%session-changed'))) {
            this.sessionReady = true
            this.refreshPanes()
        }
    }

    private unescapeTmuxOutput(str: string): Buffer {
        // Unescape octal sequences \xxx
        // tmux escapes: characters < ASCII 32 and \ character
        // UTF-8 multi-byte characters (like "➜") pass through unescaped

        let result = ''
        for (let i = 0; i < str.length; i++) {
            if (str[i] === '\\' && i + 3 < str.length) {
                // Check for octal sequence (e.g., \033 for ESC, \015 for CR)
                const octal = str.substring(i + 1, i + 4)
                if (/^[0-7]{3}$/.test(octal)) {
                    // Convert octal to character (preserves control chars like ESC)
                    result += String.fromCharCode(parseInt(octal, 8))
                    i += 3
                    continue
                }
            }
            // Keep the character as-is (including UTF-8 characters like "➜")
            result += str[i]
        }

        // Convert the unescaped string to Buffer using UTF-8 encoding
        // This properly handles both ASCII and multi-byte Unicode characters
        return Buffer.from(result, 'utf-8')
    }

    private refreshPanes() {
        this.write(Buffer.from('list-panes -s -F "TABBY_PANE:#{pane_id}"\r'))
    }
}
