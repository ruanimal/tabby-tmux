import { Subject } from 'rxjs'
import { BaseSession } from 'tabby-terminal'
import { Logger, ConfigService } from 'tabby-core'
import { createConditionalLogger, ConditionalLogger } from './logHelper'
import { Injector } from '@angular/core'
import { TmuxGateway, TMUX_COMMAND_TOLERATE_ERRORS } from './gateway'

/**
 * Pane state captured via `list-panes -F` (mirrors iTerm2 TmuxStateParser).
 * Only fields we can meaningfully apply to an xterm.js terminal are included.
 */
export interface PaneState {
    paneId: number
    cursorX: number
    cursorY: number
    alternateOn: boolean
    alternateSavedX: number
    alternateSavedY: number
    scrollRegionUpper: number
    scrollRegionLower: number
    wrapFlag: boolean
    cursorFlag: boolean
    insertFlag: boolean
    bracketPasteFlag: boolean
    keypadCursorFlag: boolean
    keypadFlag: boolean
    paneTabs: number[]
    mouseStandardMode: boolean
    mouseButtonMode: boolean
    mouseAnyMode: boolean
}

/** Pre-loaded pane data from batch discovery (iTerm2-style). */
interface PaneSnapshot {
    history: string
    altHistory: string
    state: PaneState
}

/**
 * TmuxPaneSession - Represents a single tmux pane as a terminal session
 */
export class TmuxPaneSession extends BaseSession {
    /**
     * Saved alternate screen content + cursor position, persisted after
     * restorePaneHistory so that xterm.resize() (from setTmuxGrid after
     * %layout-change) can re-apply it.  xterm.resize() clears the
     * alternate screen buffer, so the content must be written again.
     */
    pendingAltRestore: { content: string; cursorY: number; cursorX: number; modes: string } | null = null

    /**
     * Incomplete screen-title sequence (ESC k ... ESC \) spanning
     * multiple feedOutput calls.  Buffered until the closing ST arrives.
     */
    private _pendingTitleSeq: Buffer | null = null

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
        // Restore history — for initial attach this is instant (pre-loaded
        // during batch discovery); for runtime panes it falls back to
        // capture-pane.
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
        this.pendingAltRestore = null
        this._pendingTitleSeq = null
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
     * Public wrapper for the protected emitOutput().
     * Used by TmuxController to deliver history and buffered output.
     *
     * Filters out screen/tmux "set window title" sequences (ESC k ... ESC \)
     * which xterm.js does not recognize. Without filtering, zsh precmd/preexec
     * hooks that set the terminal title via `print -Pn "\ek%s\e\\"` would leak
     * the title text as visible output (e.g. `echo111` instead of `111`).
     */
    feedOutput(data: Buffer): void {
        data = this.filterScreenTitleSequences(data)
        if (data.length > 0) {
            this.emitOutput(data)
        }
    }

    /**
     * Strip screen/tmux "set window title" sequences (ESC k ... ESC \)
     * from the output stream.
     *
     * In screen/tmux, `ESC k <title> ESC \` sets the window/tab title.
     * tmux processes these internally but also forwards them verbatim to
     * control-mode clients. xterm.js does NOT handle this sequence — it
     * only recognizes `ESC ] ... BEL/ST` (OSC) — so the title text leaks
     * as visible content (e.g. the command name appears before output).
     *
     * Handles sequences that span multiple feedOutput calls by buffering
     * the incomplete portion until the closing ST (ESC \) arrives.
     */
    private filterScreenTitleSequences(data: Buffer): Buffer {
        // Prepend leftover from previous call
        if (this._pendingTitleSeq) {
            data = Buffer.concat([this._pendingTitleSeq, data])
            this._pendingTitleSeq = null
        }

        const ESC = 0x1b
        const parts: Buffer[] = []
        let pos = 0

        while (pos < data.length) {
            // Find next ESC k (0x1b 0x6b)
            let startIdx = -1
            for (let i = pos; i < data.length - 1; i++) {
                if (data[i] === ESC && data[i + 1] === 0x6b) {
                    startIdx = i
                    break
                }
            }

            if (startIdx < 0) {
                // No more title sequences — emit the rest.
                // Buffer a trailing ESC (0x1b) in case the next call
                // starts with 0x6b ('k'), forming a split ESC k pair.
                const tail = data[data.length - 1]
                if (tail === ESC) {
                    parts.push(data.subarray(pos, data.length - 1))
                    this._pendingTitleSeq = data.subarray(data.length - 1)
                } else {
                    parts.push(data.subarray(pos))
                }
                break
            }

            // Emit data before the title sequence
            if (startIdx > pos) {
                parts.push(data.subarray(pos, startIdx))
            }

            // Search for ESC \ (ST: 0x1b 0x5c) after ESC k
            let stIdx = -1
            for (let i = startIdx + 2; i < data.length - 1; i++) {
                if (data[i] === ESC && data[i + 1] === 0x5c) {
                    stIdx = i
                    break
                }
            }

            if (stIdx >= 0) {
                // Complete sequence found — skip it entirely
                pos = stIdx + 2
            } else {
                // Incomplete sequence — buffer from ESC k onwards
                this._pendingTitleSeq = data.subarray(startIdx)
                break
            }
        }

        if (parts.length === 0) return Buffer.alloc(0)
        if (parts.length === 1) return parts[0]
        return Buffer.concat(parts)
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
    /** Pre-loaded history from batch discovery (iTerm2-style). */
    private pendingSnapshots = new Map<number, PaneSnapshot>()
    private sessionName = ''
    private sessionId = -1
    private attached = false
    private activeWindowId: number | null = null

    public gateway: TmuxGateway
    public events = new Subject<{ type: string; paneId?: number; windowId?: number; data?: any }>()

    private get log (): ConditionalLogger {
        return createConditionalLogger(this.logger, this.configService)
    }

    constructor(
        private logger: Logger,
        _injector: Injector,  // eslint-disable-line @typescript-eslint/no-unused-vars
        writer: (data: string) => void,
        private closer: () => void,
        private configService?: ConfigService
    ) {
        this.gateway = new TmuxGateway(logger, writer, configService)
        this.setupGatewaySubscriptions()
    }

    private setupGatewaySubscriptions(): void {
        // Handle pane output
        this.gateway.output$.subscribe(({ paneId, data }) => {
            this.log.info(`Session received output for pane %${paneId}: ${data.length} bytes`)

            if (this.paneSessions.has(paneId)) {
                this.paneSessions.get(paneId)!.feedOutput(data)
            } else {
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
            this.log.info(`Attached to session: ${sessionName} ($${sessionId})`)
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
            // For new windows created at runtime (after initial attach),
            // tmux may NOT send %layout-change — only %window-add and %output.
            // We must proactively discover the window's layout and panes.
            // The window-add event has already been emitted above, so the UI
            // has registered the window. discoverWindowsAndPanes will update
            // the windowState with layout and emit pane-add + layout-change.
            this.discoverWindowsAndPanes()
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
            this.log.info(`Pane %${paneId} closed in window @${windowId}`)
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

        // Handle layout changes — primary pane discovery trigger (iTerm2-style).
        // Layout strings contain pane IDs. We extract new panes, capture their
        // history/state, then emit pane-add events so the UI can create tabs
        // with pre-loaded data. This replaces the old refreshPanes()-based
        // discovery for runtime pane creation (split-window etc.).
        //
        // IMPORTANT: We do NOT emit 'layout-change' here. discoverPanesFromLayout
        // emits it after pane-add events, ensuring syncLayout() always runs
        // after pane tabs have been created.
        this.gateway.layoutChange$.subscribe(({ windowId, layout, visibleLayout, zoomed }) => {
            const state = this.windowStates.get(windowId)
            if (state) {
                state.layout = layout
            }

            // Discover new panes from the layout string, then emit layout-change
            this.discoverPanesFromLayout(windowId, layout, visibleLayout, zoomed)
        })

        // Handle exit
        // Handle session-window-changed — the current window changed
        this.gateway.sessionWindowChanged$.subscribe(({ windowId }) => {
            this.log.info(`Active window changed to @${windowId}`)
            this.activeWindowId = windowId
            this.events.next({ type: 'active-window-changed', windowId })
        })

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
     * Feed raw PTY data to the gateway for byte-level DCS buffering.
     * Preferred over handleLine for proper handling of TCP fragments.
     */
    handleData(data: Buffer): void {
        this.gateway.executeData(data)
    }

    /**
     * Batch-discover all windows, panes, and history (iTerm2-style).
     *
     * Sequence (mirrors TmuxWindowOpener):
     * 1. list-windows → discover windows with names + layout
     * 2. list-panes → discover pane IDs
     * 3. capture-pane for each new pane → pre-load history
     * 4. emit pane-add events (history already in pendingHistory)
     *
     * By the time the UI creates a TmuxPaneTabComponent for a pane,
     * its history is already captured — no async restore or buffering
     * is needed at the session level.
     */
    private async discoverWindowsAndPanes(): Promise<void> {
        this.log.info('Batch discovering windows and panes...')
        try {
            // Step 1: Discover all windows with names, layout and active flag
            const winResult = await this.gateway.sendCommand(
                'list-windows -F "#{window_id} #{window_name} #{window_active} #{window_layout}"',
                TMUX_COMMAND_TOLERATE_ERRORS
            )
            const winLines = winResult.split(/[\r\n]+/).map(l => l.trim()).filter(l => l)
            this.log.info(`Found ${winLines.length} window(s) from list-windows`)

            for (const line of winLines) {
                // Format: "@0 mywindow 1 1234,0x0,0,0{60x24,0,0,1}"
                const match = line.match(/^@?(\d+)\s+(.+?)\s+([01])\s+(.+)$/)
                if (match) {
                    const windowId = parseInt(match[1])
                    const windowName = match[2]
                    const active = match[3] === '1'
                    const layout = match[4]
                    if (active) {
                        this.activeWindowId = windowId
                    }
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
            this.log.info(`Found ${paneLines.length} pane(s) from list-panes`)

            const newPaneIds: Array<{ paneId: number; windowId: number }> = []
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
                        newPaneIds.push({ paneId, windowId })
                    }
                }
            }

            // Step 3: Batch-capture history + state for all new panes
            // (mirrors iTerm2 TmuxWindowOpener)
            if (newPaneIds.length > 0) {
                this.log.info(`Capturing history/state for ${newPaneIds.length} new pane(s)...`)
                await this.capturePaneSnapshots(newPaneIds)
            }

            // Step 4: Emit pane-add events — history is now pre-loaded
            for (const { paneId, windowId } of newPaneIds) {
                this.log.info(`Discovered pane %${paneId} in window @${windowId}`)
                this.events.next({ type: 'pane-add', paneId, windowId })
            }

            // Step 5: Emit layout-change for all discovered windows so the UI
            // can build the SplitContainer tree. Without this, syncLayout()
            // never runs and panes remain registered but unmounted.
            for (const windowState of this.windowStates.values()) {
                if (windowState.layout) {
                    this.events.next({
                        type: 'layout-change',
                        windowId: windowState.id,
                        data: { layout: windowState.layout },
                    })
                }
            }
        } catch (e) {
            this.logger.warn('Failed to batch discover windows/panes:', e)
        }
    }

    /**
     * Public alias for discoverWindowsAndPanes.
     * Used by external callers (context menu, session tab ngAfterViewInit)
     * to trigger a full re-scan. For runtime pane creation (split-window),
     * discoverPanesFromLayout() handles it via %layout-change instead.
     */
    async refreshPanes(): Promise<void> {
        return this.discoverWindowsAndPanes()
    }

    /**
     * Discover new panes from a %layout-change notification (iTerm2-style).
     *
     * When tmux sends a layout change, the layout string contains all pane
     * IDs for that window. We compare against known panes, capture
     * history/state for any new ones, emit pane-add events, then emit
     * layout-change so syncLayout() runs after pane tabs exist.
     */
    private async discoverPanesFromLayout(
        windowId: number,
        layout: string,
        visibleLayout?: string,
        zoomed?: boolean
    ): Promise<void> {
        // Extract pane IDs from the layout string
        // Pane IDs appear as trailing numbers in layout leaf nodes like "80x24,0,0,3"
        // Match pattern: dimension,position,paneId  (paneId is the last number after the last comma)
        const paneIdSet = new Set<number>()
        // Match all occurrences of ,\d+ at the end of leaf node specs
        const leafPattern = /\d+x\d+,\d+,\d+,(\d+)/g
        let m: RegExpExecArray | null
        while ((m = leafPattern.exec(layout)) !== null) {
            paneIdSet.add(parseInt(m[1]))
        }

        if (paneIdSet.size === 0) return

        const windowState = this.windowStates.get(windowId)

        const newPaneIds: Array<{ paneId: number; windowId: number }> = []
        for (const paneId of paneIdSet) {
            if (windowState) {
                windowState.panes.add(paneId)
            }
            if (!this.knownPanes.has(paneId)) {
                this.knownPanes.add(paneId)
                newPaneIds.push({ paneId, windowId })
            }
        }

        if (newPaneIds.length > 0) {
            this.log.info(`Discovered ${newPaneIds.length} new pane(s) from layout-change for window @${windowId}`)

            // Capture history + state for new panes (same as discoverWindowsAndPanes Step 3)
            await this.capturePaneSnapshots(newPaneIds)

            // Emit pane-add events — history is now pre-loaded
            for (const { paneId, windowId: wid } of newPaneIds) {
                this.events.next({ type: 'pane-add', paneId, windowId: wid })
            }
        }

        // Emit layout-change AFTER pane-add events, so syncLayout() can
        // create views for newly discovered panes. This ordering is critical:
        // pane-add → handlePaneAdd (creates pane tab) → layout-change →
        // syncLayout (attaches view + builds SplitTree).
        this.events.next({ type: 'layout-change', windowId, data: { layout, visibleLayout, zoomed } })
    }

    /**
     * Capture history + state for an array of panes.
     * Shared by discoverWindowsAndPanes() and discoverPanesFromLayout().
     */
    private async capturePaneSnapshots(paneIds: Array<{ paneId: number; windowId: number }>): Promise<void> {
        const stateFormat = [
            'pane_id=#{pane_id}',
            'alternate_on=#{alternate_on}',
            'alternate_saved_x=#{alternate_saved_x}',
            'alternate_saved_y=#{alternate_saved_y}',
            'cursor_x=#{cursor_x}',
            'cursor_y=#{cursor_y}',
            'scroll_region_upper=#{scroll_region_upper}',
            'scroll_region_lower=#{scroll_region_lower}',
            'pane_tabs=#{pane_tabs}',
            'cursor_flag=#{cursor_flag}',
            'insert_flag=#{insert_flag}',
            'keypad_cursor_flag=#{keypad_cursor_flag}',
            'keypad_flag=#{keypad_flag}',
            'wrap_flag=#{wrap_flag}',
            'bracket_paste_flag=#{bracket_paste_flag}',
            'mouse_standard_flag=#{mouse_standard_flag}',
            'mouse_button_flag=#{mouse_button_flag}',
            'mouse_any_flag=#{mouse_any_flag}',
        ].join('\t')

        const captures = paneIds.map(async ({ paneId }) => {
            try {
                const [history, altHistory, stateResult] = await Promise.all([
                    this.gateway.sendCommand(
                        `capture-pane -peqJN -S- -t %${paneId}`,
                        TMUX_COMMAND_TOLERATE_ERRORS
                    ),
                    this.gateway.sendCommand(
                        `capture-pane -peqJN -a -S- -t %${paneId}`,
                        TMUX_COMMAND_TOLERATE_ERRORS
                    ),
                    this.gateway.sendCommand(
                        `list-panes -t %${paneId} -F "${stateFormat}"`,
                        TMUX_COMMAND_TOLERATE_ERRORS
                    ),
                ])
                const state = this.parsePaneState(stateResult, paneId)
                this.pendingSnapshots.set(paneId, { history, altHistory, state })
            } catch (e) {
                this.logger.warn(`Failed to capture snapshot for pane %${paneId}:`, e)
            }
        })
        await Promise.all(captures)
    }



    // --- Pane Management ---

    registerPane(paneId: number, session: TmuxPaneSession): void {
        this.paneSessions.set(paneId, session)
        this.knownPanes.add(paneId)

        // Flush any buffered output that arrived before registration
        const buffered = this.pendingPaneOutput.get(paneId)
        if (buffered) {
            for (const data of buffered) {
                session.feedOutput(data)
            }
            this.pendingPaneOutput.delete(paneId)
        }
    }

    unregisterPane(paneId: number): void {
        this.paneSessions.delete(paneId)
        this.pendingPaneOutput.delete(paneId)
        this.pendingSnapshots.delete(paneId)
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
        this.log.info(`Writing ${data.length} bytes to pane %${paneId}: <${data.toString('hex')}>`)
        this.gateway.sendKeys(data, paneId)
    }

    /**
     * Restore pane history.
     *
     * History + state are pre-loaded during discoverWindowsAndPanes()
     * (stored in pendingSnapshots) — this is instant, no capture-pane needed.
     * Both initial attach and runtime panes (split-window etc.) go through
     * discoverWindowsAndPanes() before pane-add events are emitted, so
     * pendingSnapshots is always populated by the time this runs.
     *
     * Restores (like iTerm2 setTmuxHistory:altHistory:state:):
     * 1. Primary screen history
     * 2. Alternate screen history (via CSI ?1047h / escape sequences)
     * 3. Terminal state (cursor, scroll region, modes)
     */
    async restorePaneHistory(paneId: number): Promise<void> {
        const snapshot = this.pendingSnapshots.get(paneId)
        if (!snapshot) {
            this.logger.warn(`No pre-loaded snapshot for pane %${paneId}, skipping`)
            return
        }
        this.pendingSnapshots.delete(paneId)

        const session = this.paneSessions.get(paneId)
        if (!session) return

        const state = snapshot.state

        // Step 1: Write primary screen history to the primary screen.
        // This sets up the scrollback so it's available if the user leaves
        // the program running on the alternate screen.
        if (snapshot.history) {
            const normalized = snapshot.history.replace(/\n/g, '\r\n')
            session.feedOutput(Buffer.from(normalized, 'utf-8'))
        }

        // Step 2: If the pane is on the alternate screen (vim, less, etc.),
        // switch to it and write the alternate content.  We stay on alternate.
        if (state.alternateOn) {
            // ?1047h enters alternate screen and clears it
            session.feedOutput(Buffer.from('\x1b[?1047h', 'utf-8'))

            // Apply terminal state on the alternate screen (scroll region,
            // modes, cursor visibility — NOT the cursor position yet).
            this.applyPaneState(session, state)

            // Write the alternate screen content at the top-left corner.
            // capture-pane with -a gives us exactly what was on the alternate
            // screen, starting from row 0.
            if (snapshot.altHistory && snapshot.altHistory.trim()) {
                session.feedOutput(Buffer.from('\x1b[H', 'utf-8'))
                const normalized = snapshot.altHistory.replace(/\n/g, '\r\n')
                session.feedOutput(Buffer.from(normalized, 'utf-8'))
            }

            // Re-apply cursor position after content write (content may
            // have moved the cursor via embedded CUP sequences).
            const csi = (s: string) => `\x1b[${s}`
            session.feedOutput(Buffer.from(
                csi(`${state.cursorY + 1};${state.cursorX + 1}H`),
                'utf-8'
            ))

            // Save alternate screen data for re-apply after xterm.resize()
            // (called by setTmuxGrid).  xterm.resize() clears the alternate
            // screen buffer, so the content must be written again.
            session.pendingAltRestore = {
                content: snapshot.altHistory || '',
                cursorY: state.cursorY,
                cursorX: state.cursorX,
                modes: this.buildModeSequences(state),
            }
        } else {
            // Normal mode — write alternate history if present (rare)
            if (snapshot.altHistory && snapshot.altHistory.trim()) {
                session.feedOutput(Buffer.from('\x1b[?1047h', 'utf-8'))
                const normalized = snapshot.altHistory.replace(/\n/g, '\r\n')
                session.feedOutput(Buffer.from(normalized, 'utf-8'))
                session.feedOutput(Buffer.from('\x1b[?1047l', 'utf-8'))
            }

            // Apply terminal state (cursor, scroll region, modes)
            this.applyPaneState(session, state)
        }
    }

    /**
     * Parse pane state from `list-panes -F` response.
     * Mirrors iTerm2 TmuxStateParser.
     */
    private parsePaneState(response: string, expectedPaneId: number): PaneState {
        const state: PaneState = {
            paneId: expectedPaneId,
            cursorX: 0, cursorY: 0,
            alternateOn: false,
            alternateSavedX: 0, alternateSavedY: 0,
            scrollRegionUpper: 0, scrollRegionLower: 0,
            wrapFlag: true, cursorFlag: true,
            insertFlag: false, bracketPasteFlag: false,
            keypadCursorFlag: false, keypadFlag: false,
            paneTabs: [],
            mouseStandardMode: false,
            mouseButtonMode: false,
            mouseAnyMode: false,
        }

        // `list-panes -t %paneId -F ...` may return multiple lines (one per pane
        // in the window) or a single tab-separated line.  We must find the
        // segment whose pane_id matches expectedPaneId — the first match is NOT
        // necessarily the one we asked for.
        const lines = response.split(/[\r\n]+/)
        let targetLine = ''
        for (const line of lines) {
            if (!line.includes('pane_id=')) continue
            // Check if this line's pane_id matches our expected pane
            const idMatch = line.match(/pane_id=%?(\d+)/)
            if (idMatch && parseInt(idMatch[1]) === expectedPaneId) {
                targetLine = line
                break
            }
        }
        // Fallback: if no exact match found, use the first line with pane_id
        // (happens when list-panes returns only the target pane)
        if (!targetLine) {
            targetLine = lines.find(l => l.includes('pane_id=')) || ''
        }
        if (!targetLine) return state

        for (const part of targetLine.split('\t')) {
            const eqIdx = part.indexOf('=')
            if (eqIdx < 0) continue
            const key = part.substring(0, eqIdx)
            const value = part.substring(eqIdx + 1)
            const n = parseInt(value)
            switch (key) {
                case 'pane_id': state.paneId = n; break
                case 'cursor_x': state.cursorX = n; break
                case 'cursor_y': state.cursorY = n; break
                case 'alternate_on': state.alternateOn = n === 1; break
                case 'alternate_saved_x': state.alternateSavedX = n; break
                case 'alternate_saved_y': state.alternateSavedY = n; break
                case 'scroll_region_upper': state.scrollRegionUpper = n; break
                case 'scroll_region_lower': state.scrollRegionLower = n; break
                case 'pane_tabs': state.paneTabs = value.split(',').map(Number).filter(x => !isNaN(x)); break
                case 'cursor_flag': state.cursorFlag = n === 1; break
                case 'insert_flag': state.insertFlag = n === 1; break
                case 'keypad_cursor_flag': state.keypadCursorFlag = n === 1; break
                case 'keypad_flag': state.keypadFlag = n === 1; break
                case 'wrap_flag': state.wrapFlag = n === 1; break
                case 'bracket_paste_flag': state.bracketPasteFlag = n === 1; break
                case 'mouse_standard_flag': state.mouseStandardMode = n === 1; break
                case 'mouse_button_flag': state.mouseButtonMode = n === 1; break
                case 'mouse_any_flag': state.mouseAnyMode = n === 1; break
            }
        }
        return state
    }

    /**
     * Apply parsed pane state to the terminal via ANSI escape sequences.
     * Mirrors iTerm2 VT100ScreenMutableState.setTmuxState:.
     */
    private applyPaneState(session: TmuxPaneSession, state: PaneState): void {
        // Build a sequence of escape codes to restore terminal state.
        const seq = this.buildModeSequences(state)
        session.feedOutput(Buffer.from(seq, 'utf-8'))
    }

    /**
     * Build ANSI escape sequences for terminal mode state (without alternate
     * screen entry).  Used by both applyPaneState and pendingAltRestore.
     */
    private buildModeSequences(state: PaneState): string {
        const csi = (s: string) => `\x1b[${s}`
        const esc = (s: string) => `\x1b${s}`
        let seq = ''

        // Set scroll region (DECSTBM)
        if (state.scrollRegionUpper > 0 || state.scrollRegionLower > 0) {
            seq += csi(`${state.scrollRegionUpper + 1};${state.scrollRegionLower + 1}r`)
        }

        // Restore cursor position (CUP)
        seq += csi(`${state.cursorY + 1};${state.cursorX + 1}H`)

        // Cursor visibility (DECTCEM)
        seq += state.cursorFlag ? csi('?25h') : csi('?25l')

        // Insert mode (IRM)
        seq += state.insertFlag ? csi('4h') : csi('4l')

        // Application cursor keys (DECCKM)
        seq += state.keypadCursorFlag ? csi('?1h') : csi('?1l')

        // Application keypad mode (DECKPAM / DECKPNM)
        seq += state.keypadFlag ? esc('=') : esc('>')

        // Bracketed paste mode
        seq += state.bracketPasteFlag ? csi('?2004h') : csi('?2004l')

        // Wrap mode (DECAWM)
        seq += state.wrapFlag ? csi('?7h') : csi('?7l')

        // Mouse tracking modes (?1000=normal, ?1002=button, ?1003=any)
        seq += state.mouseStandardMode ? csi('?1000h') : csi('?1000l')
        seq += state.mouseButtonMode ? csi('?1002h') : csi('?1002l')
        seq += state.mouseAnyMode ? csi('?1003h') : csi('?1003l')

        // Tab stops (HTS / TBC)
        // TBC 3 = clear all tab stops, then HTS at each position
        seq += csi('3g')
        for (const col of state.paneTabs) {
            seq += csi(`${col + 1}G`) // CUP to column
            seq += esc('H')           // HTS
        }

        // Reset cursor back to final position (tab stop setup moves it)
        seq += csi(`${state.cursorY + 1};${state.cursorX + 1}H`)

        return seq
    }

    /**
     * Re-apply alternate screen content after xterm.resize() clears it.
     * Called by TmuxPaneTabComponent.applyTmuxGrid() after resize.
     */
    reapplyAltContent(session: TmuxPaneSession): void {
        const alt = session.pendingAltRestore
        if (!alt) return

        // Clear immediately — this is a one-shot re-apply after the initial
        // resize.  After this, live tmux output maintains the alternate screen.
        session.pendingAltRestore = null

        // Enter alternate screen (clears it)
        session.feedOutput(Buffer.from('\x1b[?1047h', 'utf-8'))

        // Apply modes
        session.feedOutput(Buffer.from(alt.modes, 'utf-8'))

        // Write content at top-left
        if (alt.content && alt.content.trim()) {
            session.feedOutput(Buffer.from('\x1b[H', 'utf-8'))
            const normalized = alt.content.replace(/\n/g, '\r\n')
            session.feedOutput(Buffer.from(normalized, 'utf-8'))
        }

        // Re-apply cursor position
        const csi = (s: string) => `\x1b[${s}`
        session.feedOutput(Buffer.from(
            csi(`${alt.cursorY + 1};${alt.cursorX + 1}H`),
            'utf-8'
        ))
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
     * Get the tmux-side active window ID, as reported by list-windows
     * #{window_active} or %session-window-changed. Falls back to null.
     */
    getActiveWindowId(): number | null {
        return this.activeWindowId
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
