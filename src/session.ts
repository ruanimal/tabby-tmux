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
        // No-op by design. In tmux integration, tmux is authoritative over the
        // cell grid: each pane's character size comes from the %layout-change
        // string and is applied via TmuxPaneTabComponent.setTmuxGrid().
        //
        // The xterm frontend's automatic fit-to-container resizing is disabled
        // for tmux panes (frontend.enableResizing = false), so this method
        // should normally never be called. Sending refresh-client -C from here
        // would re-introduce the resize feedback loop (pane refit → client
        // size → tmux relayout → pane refit → ...), so we deliberately do
        // nothing. Overall client size is driven only by the container size
        // in TmuxSessionTabComponent.refreshClientSize().
    }

    write(data: Buffer): void {
        this.controller.writeToPane(this.paneId, data)
    }

    // NOTE: feedFromTerminal is NOT overridden — it goes through the
    // middleware chain (BaseSession.feedFromTerminal → middleware →
    // outputToSession$ → write()) so that SessionMiddleware plugins
    // such as trzsz can intercept terminal input.

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
     * If the controller is currently restoring history for this pane
     * (capture-pane), the output is buffered and later discarded instead
     * of being sent to the terminal.  capture-pane already includes all
     * visible content, so real-time output arriving during the restore
     * would be shown twice if we forwarded it.
     */
    emitOutputToPane(data: Buffer): void {
        if (this.controller.isRestoringHistory(this.paneId)) {
            this.controller.bufferRestoreOutput(this.paneId, data)
            return
        }
        this.emitOutput(data)
    }

    /**
     * Write captured history directly to the terminal, bypassing the
     * restore-buffer guard.  Used by restorePaneHistory() to write the
     * capture-pane response without triggering the duplication-prevention
     * buffering.
     */
    writeCapturedHistory(data: Buffer): void {
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
    /** Panes currently restoring history via capture-pane */
    private restoringHistoryPanes = new Set<number>()
    /** Buffer for output arriving during history restore */
    private restoreBuffer = new Map<number, Buffer[]>()
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
        // Like iTerm2, we immediately batch-discover all windows and panes
        // instead of relying on delayed list-panes or passive %output discovery.
        this.gateway.sessionChanged$.subscribe(({ sessionName, sessionId }) => {
            this.sessionName = sessionName
            this.sessionId = sessionId
            this.attached = true
            this.logger.info(`Attached to session: ${sessionName} ($${sessionId})`)
            this.events.next({ type: 'session-changed', data: { sessionName, sessionId } })
            // Immediate batch discovery — no setTimeout delay
            this.discoverWindowsAndPanes()
        })

        // Handle window events
        this.gateway.windowAdd$.subscribe(windowId => {
            if (!this.windowStates.has(windowId)) {
                this.windowStates.set(windowId, {
                    id: windowId,
                    name: `Window ${windowId}`,
                    panes: new Set()
                })
            }
            this.events.next({ type: 'window-add', windowId })
            // Pane discovery is handled by %layout-change and %output;
            // no need to re-scan all panes on every window-add.
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

        // Handle pane close events (tmux 3.2+)
        this.gateway.paneClose$.subscribe(({ windowId, paneId }) => {
            this.logger.info(`Pane %${paneId} closed in window @${windowId}`)
            // Remove from known panes
            this.knownPanes.delete(paneId)
            // Remove from window state
            const windowState = this.windowStates.get(windowId)
            if (windowState) {
                windowState.panes.delete(paneId)
            }
            // Clean up pane session if exists
            const session = this.paneSessions.get(paneId)
            if (session) {
                session.destroy()
                this.paneSessions.delete(paneId)
            }
            this.pendingPaneOutput.delete(paneId)
            this.events.next({ type: 'pane-close', paneId, windowId })
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
            this.discoverWindowsAndPanes()
        })
    }

    /**
     * Process a line from the underlying session
     */
    handleLine(line: string): void {
        this.gateway.executeLine(line)
    }

    /**
     * Batch-discover all windows and panes (iTerm2-style).
     *
     * Called once on %session-changed. Uses `list-windows` to discover
     * windows with names and layout, then `list-panes` to discover pane
     * IDs. This replaces the old delayed `refreshPanes()` + passive
     * `%output` discovery approach.
     */
    private async discoverWindowsAndPanes(): Promise<void> {
        this.logger.info('Batch discovering windows and panes...')
        try {
            // Step 1: Discover all windows with names and layout
            const winResult = await this.gateway.sendCommand(
                'list-windows -F "#{window_id} #{window_name} #{window_layout}"',
                TMUX_COMMAND_TOLERATE_ERRORS
            )
            const winLines = winResult.split(/[\r\n]+/).map(l => l.trim()).filter(l => l)
            this.logger.info(`Found ${winLines.length} window(s) from list-windows`)

            for (const line of winLines) {
                // Format: "@0 mywindow 1234,0x0,0,0{60x24,0,0,1}"
                const match = line.match(/^@?(\d+)\s+(.+?)\s+(.+)$/)
                if (match) {
                    const windowId = parseInt(match[1])
                    const windowName = match[2]
                    const layout = match[3]
                    if (!this.windowStates.has(windowId)) {
                        this.windowStates.set(windowId, {
                            id: windowId,
                            name: windowName,
                            layout,
                            panes: new Set()
                        })
                        this.events.next({ type: 'window-add', windowId })
                    } else {
                        const state = this.windowStates.get(windowId)!
                        state.name = windowName
                        state.layout = layout
                    }
                }
            }

            // Step 2: Discover all panes and map to windows
            const paneResult = await this.gateway.sendCommand(
                'list-panes -s -F "#{pane_id} #{window_id}"',
                TMUX_COMMAND_TOLERATE_ERRORS
            )
            const paneLines = paneResult.split(/[\r\n]+/).map(l => l.trim()).filter(l => l)
            this.logger.info(`Found ${paneLines.length} pane(s) from list-panes`)

            for (const line of paneLines) {
                const match = line.match(/^%?(\d+)\s+@?(\d+)$/)
                if (match) {
                    const paneId = parseInt(match[1])
                    const windowId = parseInt(match[2])

                    let windowState = this.windowStates.get(windowId)
                    if (!windowState) {
                        windowState = {
                            id: windowId,
                            name: `Window ${windowId}`,
                            panes: new Set()
                        }
                        this.windowStates.set(windowId, windowState)
                        this.events.next({ type: 'window-add', windowId })
                    }
                    windowState.panes.add(paneId)

                    if (!this.knownPanes.has(paneId)) {
                        this.knownPanes.add(paneId)
                        this.logger.info(`Discovered pane %${paneId} in window @${windowId}`)
                        this.events.next({ type: 'pane-add', paneId, windowId })
                    }
                }
            }
        } catch (e) {
            this.logger.warn('Failed to batch discover windows/panes:', e)
        }
    }

    /**
     * Public alias for discoverWindowsAndPanes.
     * Used by external callers (context menu, pane tab, session tab)
     * to trigger a full re-scan after manual actions.
     */
    async refreshPanes(): Promise<void> {
        return this.discoverWindowsAndPanes()
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
        this.restoringHistoryPanes.delete(paneId)
        this.restoreBuffer.delete(paneId)
    }

    getPaneSession(paneId: number): TmuxPaneSession | undefined {
        return this.paneSessions.get(paneId)
    }

    hasPaneSession(paneId: number): boolean {
        return this.paneSessions.has(paneId)
    }

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

    /** Check if a pane is currently restoring history */
    isRestoringHistory(paneId: number): boolean {
        return this.restoringHistoryPanes.has(paneId)
    }

    /** Buffer output that arrives during history restore */
    bufferRestoreOutput(paneId: number, data: Buffer): void {
        if (!this.restoreBuffer.has(paneId)) {
            this.restoreBuffer.set(paneId, [])
        }
        this.restoreBuffer.get(paneId)!.push(data)
    }

    async restorePaneHistory(paneId: number): Promise<void> {
        this.logger.info(`Restoring history for pane %${paneId}`)

        // Enable buffering: any %output arriving while we wait for
        // capture-pane will be buffered instead of sent to the terminal.
        // This prevents duplication because capture-pane already includes
        // all visible content at the time it snapshots the pane.
        this.restoringHistoryPanes.add(paneId)
        this.restoreBuffer.set(paneId, [])

        try {
            // capture-pane options:
            // -e: include escape sequences (colors, attributes)
            // -p: output to stdout
            // -J: join wrapped lines (matches iTerm2's capture-pane flags)
            // -S-: start from beginning of history
            const output = await this.gateway.sendCommand(
                `capture-pane -peJS- -t %${paneId}`,
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
                this.paneSessions.get(paneId)?.writeCapturedHistory(buffer)
            }
        } catch (e) {
            this.logger.warn(`Failed to restore history for pane %${paneId}:`, e)
        } finally {
            // Disable buffering and discard any output that arrived during
            // the restore.  We cannot distinguish output that arrived before
            // the capture-pane snapshot (already in the response → would
            // duplicate) from output that arrived after (truly new → would
            // lose).  Since the snapshot→%end window is tiny and the most
            // likely content there is the shell prompt (already captured),
            // discarding is the safe trade-off to avoid visible duplication.
            this.restoringHistoryPanes.delete(paneId)
            const buffered = this.restoreBuffer.get(paneId) || []
            this.restoreBuffer.delete(paneId)
            if (buffered.length > 0) {
                this.logger.info(`Discarding ${buffered.length} buffered output chunk(s) for pane %${paneId} (included in capture-pane)`)
            }
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

    /**
     * Get all known pane IDs across all windows.
     * Used by TmuxPaneTabComponent for "Focus all tmux panes" (sync input).
     */
    getAllPaneIds(): number[] {
        return Array.from(this.knownPanes)
    }
}

// Re-export for backwards compatibility
export { TmuxController as TmuxControllerSession }
