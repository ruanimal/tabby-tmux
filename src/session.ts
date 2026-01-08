import { Subject } from 'rxjs'
import { BaseSession } from 'tabby-terminal'
import { Logger } from 'tabby-core'
import { Injector } from '@angular/core'
import { TmuxGateway, TMUX_COMMAND_TOLERATE_ERRORS } from './gateway'

/**
 * TmuxPaneSession - Represents a single tmux pane as a terminal session
 */
export class TmuxPaneSession extends BaseSession {
    private pendingDataBuffer: Buffer[] = []
    private bufferReleased = false

    constructor(
        logger: Logger,
        private controller: TmuxController,
        public paneId: number
    ) {
        super(logger)
        this.open = true
        this.controller.registerPane(this.paneId, this)
    }

    async start(): Promise<void> {
        this.open = true
        // Restore history when session starts
        await this.controller.restorePaneHistory(this.paneId)
    }

    resize(columns: number, rows: number): void {
        this.controller.resizePane(this.paneId, columns, rows)
    }

    write(data: Buffer): void {
        this.controller.writeToPane(this.paneId, data)
    }

    /**
     * Called by BaseTerminalTabComponent when the user types in the terminal.
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

    /**
     * Buffer output until explicitly released
     * This prevents output from being lost before the terminal is ready
     */
    emitOutputToPane(data: Buffer): void {
        console.log(`[TmuxPaneSession] pane ${this.paneId} emitOutputToPane: ${data.length} bytes, released=${this.bufferReleased}`)
        if (!this.bufferReleased) {
            this.logger.info(`Buffering ${data.length} bytes for pane %${this.paneId}`)
            console.log(`[CONSOLE] Buffering ${data.length} bytes for pane %${this.paneId}`)
            this.pendingDataBuffer.push(data)
        } else {
            this.logger.info(`Emitting ${data.length} bytes to pane %${this.paneId}`)
            console.log(`[CONSOLE] Emitting ${data.length} bytes to pane %${this.paneId}`)
            this.emitOutput(data)
        }
    }

    /**
     * Release buffered output to the terminal
     */
    releaseInitialDataBuffer(): void {
        this.logger.info(`Releasing initial data buffer for pane %${this.paneId} (${this.pendingDataBuffer.length} chunks)`)
        // console.log(`[CONSOLE] Releasing buffer for pane ${this.paneId}, ${this.pendingDataBuffer.length} chunks`)
        this.bufferReleased = true
        for (const data of this.pendingDataBuffer) {
            this.emitOutput(data)
        }
        this.pendingDataBuffer = []
    }
}

/**
 * Window state tracking
 */
interface WindowState {
    id: number
    name: string
    layout?: string
    panes: Set<number>
}

/**
 * TmuxController - Manages a tmux control mode session
 *
 * Based on iTerm2's TmuxController architecture.
 */
export class TmuxController {
    private paneSessions = new Map<number, TmuxPaneSession>()
    private windowStates = new Map<number, WindowState>()
    private knownPanes = new Set<number>()
    private pendingPaneOutput = new Map<number, Buffer[]>()
    private sessionName = ''
    private sessionId = -1
    private attached = false

    public gateway: TmuxGateway
    public events = new Subject<{ type: string; paneId?: number; windowId?: number; data?: any }>()

    constructor(
        private logger: Logger,
        _injector: Injector,  // eslint-disable-line @typescript-eslint/no-unused-vars
        writer: (data: string) => void,
        private closer: () => void
    ) {
        this.gateway = new TmuxGateway(logger, writer)
        this.setupGatewaySubscriptions()
    }

    private setupGatewaySubscriptions(): void {
        // Handle pane output
        this.gateway.output$.subscribe(({ paneId, data }) => {
            this.logger.info(`Session received output for pane %${paneId}: ${data.length} bytes`)
            // Discover panes from output - this catches panes we didn't know about
            if (!this.knownPanes.has(paneId)) {
                this.knownPanes.add(paneId)
                this.logger.info(`Discovered pane %${paneId} from output (new)`)
                this.events.next({ type: 'pane-add', paneId })
            }

            if (this.paneSessions.has(paneId)) {
                this.logger.info(`Dispatching output to existing session for pane %${paneId}`)
                this.paneSessions.get(paneId)?.emitOutputToPane(data)
            } else {
                this.logger.info(`Buffering output for unknown/pending pane %${paneId}`)
                // Buffer output for panes not yet registered
                if (!this.pendingPaneOutput.has(paneId)) {
                    this.pendingPaneOutput.set(paneId, [])
                }
                this.pendingPaneOutput.get(paneId)!.push(data)
            }
        })

        // Handle session changes - this is our main initialization point
        this.gateway.sessionChanged$.subscribe(({ sessionName, sessionId }) => {
            this.sessionName = sessionName
            this.sessionId = sessionId
            this.attached = true
            this.logger.info(`Attached to session: ${sessionName} ($${sessionId})`)
            this.events.next({ type: 'session-changed', data: { sessionName, sessionId } })
            // Refresh panes after session change - this is when we discover existing panes
            setTimeout(() => this.refreshPanes(), 100)
        })

        // Handle window events
        this.gateway.windowAdd$.subscribe(windowId => {
            this.windowStates.set(windowId, {
                id: windowId,
                name: `Window ${windowId}`,
                panes: new Set()
            })
            this.events.next({ type: 'window-add', windowId })
            this.refreshPanes()
        })

        this.gateway.windowClose$.subscribe(windowId => {
            this.windowStates.delete(windowId)
            this.events.next({ type: 'window-close', windowId })
        })

        this.gateway.windowRenamed$.subscribe(({ windowId, name }) => {
            const state = this.windowStates.get(windowId)
            if (state) {
                state.name = name
            }
            this.events.next({ type: 'window-renamed', windowId, data: { name } })
        })

        // Handle layout changes
        this.gateway.layoutChange$.subscribe(({ windowId, layout, visibleLayout, zoomed }) => {
            const state = this.windowStates.get(windowId)
            if (state) {
                state.layout = layout
            }
            this.events.next({ type: 'layout-change', windowId, data: { layout, visibleLayout, zoomed } })
        })

        // Handle exit
        this.gateway.exit$.subscribe(reason => {
            this.attached = false
            this.events.next({ type: 'exit', data: { reason } })
            this.closer()
        })

        // Handle initialization
        this.gateway.initialized$.subscribe(() => {
            this.events.next({ type: 'initialized' })
            this.refreshPanes()
        })
    }

    /**
     * Process a line from the underlying session
     */
    handleLine(line: string): void {
        this.gateway.executeLine(line)
    }

    /**
     * Refresh the list of panes
     */
    async refreshPanes(): Promise<void> {
        this.logger.info('Refreshing panes list...')
        try {
            const result = await this.gateway.sendCommand(
                'list-panes -s -F "#{pane_id}"',
                TMUX_COMMAND_TOLERATE_ERRORS
            )

            this.logger.info('list-panes result:', result)
            // Split by newlines and strip CR characters
            const lines = result.split(/[\r\n]+/).map(l => l.trim()).filter(l => l)
            this.logger.info(`Found ${lines.length} pane(s) from list-panes:`, lines)

            for (const line of lines) {
                this.logger.info(`Processing line: "${line}"`)
                // Match both "%0" and "0" formats
                const match = line.match(/^%?(\d+)$/)
                if (match) {
                    const paneId = parseInt(match[1])
                    this.logger.info(`Matched pane ID: ${paneId}, known=${this.knownPanes.has(paneId)}`)
                    if (!this.knownPanes.has(paneId)) {
                        this.knownPanes.add(paneId)
                        this.logger.info(`Discovered pane %${paneId} from list-panes, emitting event`)
                        this.events.next({ type: 'pane-add', paneId })
                    } else {
                        this.logger.info(`Pane %${paneId} already known, skipping`)
                    }
                } else {
                    this.logger.info(`Unmatched pane line: "${line}"`)
                }
            }
        } catch (e) {
            this.logger.warn('Failed to refresh panes:', e)
        }
    }

    /**
     * Get information about all panes
     */
    async getPaneInfo(): Promise<Array<{ paneId: number; windowId: number; width: number; height: number }>> {
        try {
            const result = await this.gateway.sendCommand(
                'list-panes -a -F "#{pane_id} #{window_id} #{pane_width} #{pane_height}"',
                TMUX_COMMAND_TOLERATE_ERRORS
            )

            const panes: Array<{ paneId: number; windowId: number; width: number; height: number }> = []
            for (const line of result.split('\n')) {
                const match = line.match(/^%(\d+) @(\d+) (\d+) (\d+)$/)
                if (match) {
                    panes.push({
                        paneId: parseInt(match[1]),
                        windowId: parseInt(match[2]),
                        width: parseInt(match[3]),
                        height: parseInt(match[4])
                    })
                }
            }
            return panes
        } catch (e) {
            this.logger.warn('Failed to get pane info:', e)
            return []
        }
    }

    // --- Pane Management ---

    registerPane(paneId: number, session: TmuxPaneSession): void {
        this.paneSessions.set(paneId, session)
        this.knownPanes.add(paneId)

        // Flush any buffered output
        const pendingOutput = this.pendingPaneOutput.get(paneId)
        if (pendingOutput && pendingOutput.length > 0) {
            for (const data of pendingOutput) {
                session.emitOutputToPane(data)
            }
            this.pendingPaneOutput.delete(paneId)
        }
    }

    unregisterPane(paneId: number): void {
        this.paneSessions.delete(paneId)
        this.pendingPaneOutput.delete(paneId)
    }

    getPaneSession(paneId: number): TmuxPaneSession | undefined {
        return this.paneSessions.get(paneId)
    }

    hasPaneSession(paneId: number): boolean {
        return this.paneSessions.has(paneId)
    }

    // --- Pane Operations ---

    resizePane(_paneId: number, columns: number, rows: number): void {
        // Use refresh-client -C to set client size
        // This affects all panes uniformly in non-variable-size mode
        // Note: paneId is ignored as tmux control mode uses uniform size
        this.gateway.sendCommand(
            `refresh-client -C ${columns},${rows}`,
            TMUX_COMMAND_TOLERATE_ERRORS
        ).catch(e => this.logger.warn('Resize failed:', e))
    }

    writeToPane(paneId: number, data: Buffer): void {
        this.logger.info(`Writing ${data.length} bytes to pane %${paneId}: <${data.toString('hex')}>`)
        this.gateway.sendKeys(data, paneId)
    }

    async restorePaneHistory(paneId: number): Promise<void> {
        this.logger.info(`Restoring history for pane %${paneId}`)
        try {
            // capture-pane -e (escape sequences) -p (stdout) -t pane
            const output = await this.gateway.sendCommand(
                `capture-pane -e -p -t %${paneId}`,
                TMUX_COMMAND_TOLERATE_ERRORS
            )

            if (output && this.paneSessions.has(paneId)) {
                // The output from capture-pane comes with newlines
                // We convert it to buffer and emit it
                const buffer = Buffer.from(output, 'utf-8')
                // Add a newline as capture-pane might strip the last one or we want to ensure cursor is on new line
                // actually capture-pane usually dumps the screen.
                this.paneSessions.get(paneId)?.emitOutputToPane(buffer)
                // Force a redraw
                this.paneSessions.get(paneId)?.emitOutputToPane(Buffer.from('\r'))
            }
        } catch (e) {
            this.logger.warn(`Failed to restore history for pane %${paneId}:`, e)
        }
    }

    async killPane(paneId: number): Promise<void> {
        await this.gateway.sendCommand(`kill-pane -t %${paneId}`, TMUX_COMMAND_TOLERATE_ERRORS)
    }

    // --- Window Operations ---

    async createWindow(): Promise<number | null> {
        try {
            const result = await this.gateway.sendCommand('new-window -P -F "#{window_id}"')
            const match = result.match(/@(\d+)/)
            return match ? parseInt(match[1]) : null
        } catch (e) {
            this.logger.warn('Failed to create window:', e)
            return null
        }
    }

    async killWindow(windowId: number): Promise<void> {
        await this.gateway.sendCommand(`kill-window -t @${windowId}`, TMUX_COMMAND_TOLERATE_ERRORS)
    }

    async renameWindow(windowId: number, name: string): Promise<void> {
        await this.gateway.sendCommand(
            `rename-window -t @${windowId} "${name.replace(/"/g, '\\"')}"`,
            TMUX_COMMAND_TOLERATE_ERRORS
        )
    }

    // --- Session Operations ---

    async detach(): Promise<void> {
        this.gateway.detach()
    }

    async listSessions(): Promise<Array<{ id: number; name: string }>> {
        try {
            const result = await this.gateway.sendCommand('list-sessions -F "#{session_id} #{session_name}"')
            const sessions: Array<{ id: number; name: string }> = []
            for (const line of result.split('\n')) {
                const match = line.match(/^\$(\d+) (.+)$/)
                if (match) {
                    sessions.push({
                        id: parseInt(match[1]),
                        name: match[2]
                    })
                }
            }
            return sessions
        } catch (e) {
            this.logger.warn('Failed to list sessions:', e)
            return []
        }
    }

    // --- Lifecycle ---

    async destroy(): Promise<void> {
        // Close all pane sessions
        for (const [_paneId, session] of this.paneSessions) {
            await session.destroy()
        }
        this.paneSessions.clear()
        this.attached = false
    }

    // --- Getters ---

    get isAttached(): boolean {
        return this.attached
    }

    getSessionName(): string {
        return this.sessionName
    }

    getSessionId(): number {
        return this.sessionId
    }
}

// Re-export for backwards compatibility
export { TmuxController as TmuxControllerSession }
