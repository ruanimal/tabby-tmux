import { Subject } from 'rxjs'
import { BaseSession } from 'tabby-terminal'
import { Logger } from 'tabby-core'
import { Injector } from '@angular/core'
import { TmuxGateway, TMUX_COMMAND_TOLERATE_ERRORS } from './gateway'

/**
 * TmuxPaneSession - Represents a single tmux pane as a terminal session
 */
export class TmuxPaneSession extends BaseSession {
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

    resize(_columns: number, _rows: number): void {
        // Individual pane tabs must NOT send refresh-client -C directly.
        // Instead, notify the controller that a pane's display dimensions changed.
        // The TmuxSessionTabComponent subscribes to this and recalculates
        // the total client size from ALL panes' actual xterm dimensions.
        this.controller.onPaneDisplayResized()
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
     * Emit output to the pane.
     *
     * Data flows through BaseSession's middleware and buffering mechanism.
     * BaseTerminalTabComponent will automatically call releaseInitialDataBuffer()
     * when the frontend is ready, so we don't need custom buffering here.
     */
    emitOutputToPane(data: Buffer): void {
        // Directly call emitOutput - it will be buffered by BaseSession until released
        this.emitOutput(data)
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
    /** Emitted when any pane's xterm.js display dimensions change (from fitAddon.fit) */
    public paneDisplayResized$ = new Subject<void>()

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
                'list-panes -s -F "#{pane_id} #{window_id}"',
                TMUX_COMMAND_TOLERATE_ERRORS
            )

            this.logger.info('list-panes result:', result)
            // Split by newlines and strip CR characters
            const lines = result.split(/[\r\n]+/).map(l => l.trim()).filter(l => l)
            this.logger.info(`Found ${lines.length} pane(s) from list-panes:`, lines)

            for (const line of lines) {
                // Match "%0 1" format (pane_id window_id)
                const match = line.match(/^%?(\d+)\s+@?(\d+)$/)
                if (match) {
                    const paneId = parseInt(match[1])
                    const windowId = parseInt(match[2])

                    // Update window state
                    let windowState = this.windowStates.get(windowId)
                    if (!windowState) {
                        // If we discovered a pane for an unknown window, create a stub state
                        // The real window-add event might come later or already happened
                        windowState = {
                            id: windowId,
                            name: `Window ${windowId}`,
                            panes: new Set()
                        }
                        this.windowStates.set(windowId, windowState)
                        // Emit window-add so the service knows about this window
                        this.events.next({ type: 'window-add', windowId })
                    }
                    windowState.panes.add(paneId)

                    this.logger.info(`Matched pane ID: ${paneId} window ID: ${windowId}, known=${this.knownPanes.has(paneId)}`)

                    if (!this.knownPanes.has(paneId)) {
                        this.knownPanes.add(paneId)
                        this.logger.info(`Discovered pane %${paneId} from list-panes, emitting event`)
                        this.events.next({ type: 'pane-add', paneId, windowId })
                    } else {
                        // Check if window association changed (unlikely in normal operation but possible)
                        this.events.next({ type: 'pane-update', paneId, windowId })
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

        // Discard pending output — restorePaneHistory (capture-pane -S-)
        // will restore the full scrollback including the visible content.
        // Flushing pending output before capture-pane would duplicate the
        // visible area, inflating total output and pushing the oldest
        // history lines out of the terminal's scrollback buffer.
        this.pendingPaneOutput.delete(paneId)
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

    /**
     * Called by TmuxPaneSession.resize() when xterm.js refits a pane.
     * This signals that the actual display dimensions changed, so the
     * TmuxSessionTabComponent should recalculate and send client size.
     */
    onPaneDisplayResized(): void {
        this.paneDisplayResized$.next()
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
            // capture-pane options:
            // -e: include escape sequences (colors, attributes)
            // -p: output to stdout
            // -S-: start from beginning of history
            //
            // NOTE: We do NOT use -J (join wrapped lines) because it can break
            // ANSI escape sequences, causing highlights to span across lines incorrectly.
            // Instead, we let tmux output lines as-is and only fix the line ending format.
            const output = await this.gateway.sendCommand(
                `capture-pane -ep -S- -t %${paneId}`,
                TMUX_COMMAND_TOLERATE_ERRORS
            )

            if (output && this.paneSessions.has(paneId)) {
                // capture-pane outputs Unix-style line endings (\n)
                // but terminals need \r\n (CR+LF) for proper display:
                // - \r (Carriage Return): move cursor to start of line
                // - \n (Line Feed): move cursor down one line
                // Without \r, lines will start at the column where the previous line ended
                const normalizedOutput = output.replace(/\n/g, '\r\n')
                const buffer = Buffer.from(normalizedOutput, 'utf-8')
                this.paneSessions.get(paneId)?.emitOutputToPane(buffer)
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

    getWindowPanes(windowId: number): number[] {
        const state = this.windowStates.get(windowId)
        return state ? Array.from(state.panes) : []
    }

    getWindowState(windowId: number): WindowState | undefined {
        return this.windowStates.get(windowId)
    }

    getAllWindowStates(): WindowState[] {
        return Array.from(this.windowStates.values())
    }

    getFirstWindowId(): number | undefined {
        const first = this.windowStates.keys().next()
        return first.done ? undefined : first.value
    }
}

// Re-export for backwards compatibility
export { TmuxController as TmuxControllerSession }
