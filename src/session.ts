import { Subject } from 'rxjs'
import { BaseSession } from 'tabby-terminal'
import { Logger, ConfigService } from 'tabby-core'
import { createConditionalLogger, ConditionalLogger } from './logHelper'
import { Injector } from '@angular/core'
import { TmuxGateway, TMUX_COMMAND_TOLERATE_ERRORS } from './gateway'
import { PaneState, applyPaneState, buildModeSequences, parsePaneState } from './paneState'

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
    pendingAltRestore: { content: string; cursorY: number; cursorX: number; modes: string } | null =
        null

    /**
     * Incomplete screen-title sequence (ESC k ... ESC \) spanning
     * multiple feedOutput calls.  Buffered until the closing ST arrives.
     */
    private _pendingTitleSeq: Buffer | null = null

    constructor(
        logger: Logger,
        private controller: TmuxController,
        public paneId: number,
    ) {
        super(logger)
        this.open = true
        this.controller.registerPane(this.paneId, this)
    }

    /**
     * Resolved once TmuxPaneTabComponent has applied the tmux grid
     * (first setTmuxGrid → xterm.resize). History restore must wait for it:
     * at xterm init the font is not configured yet (configure() runs after
     * attach()), so the initial fit-based columns are smaller than the tmux
     * layout — writing history then wraps logical lines wrongly ("history
     * shows extra lines" until a manual resize reflows the buffer).
     */
    private _gridAppliedResolve: (() => void) | null = null
    private _gridApplied = new Promise<void>((resolve) => {
        this._gridAppliedResolve = resolve
    })

    /** Called by TmuxPaneTabComponent.applyTmuxGrid() once the grid is in place. */
    gridApplied(): void {
        if (this._gridAppliedResolve) {
            this._gridAppliedResolve()
            this._gridAppliedResolve = null
        }
    }

    /**
     * %output received before the tmux grid is applied (xterm still at its
     * initial columns) is buffered here and flushed once the grid is in
     * place. Writing before the resize would render at the wrong width and
     * the subsequent xterm.resize() reflow can reset the cursor — freshly
     * split panes (slow remote shells) get their prompt via %output exactly
     * in that window, ending up with the cursor at the line start.
     */
    private _pendingOutput: Buffer[] = []
    private _gridDone = false

    async start(): Promise<void> {
        this.open = true
        // Wait for the pane's xterm to apply the tmux layout grid before
        // restoring history, so history lines are written at the correct
        // column width (see _gridApplied docs). 3s timeout as a fallback for
        // panes that never get a grid (e.g. not present in any layout) —
        // degraded (possibly mis-wrapped) history is better than none.
        await Promise.race([
            this._gridApplied,
            new Promise<void>((resolve) => setTimeout(resolve, 3000)),
        ])
        // The xterm is now at the tmux layout columns. Mark the grid done so
        // restorePaneHistory's feedOutput goes straight to the terminal;
        // early %output stays buffered and is flushed AFTER the captured
        // history — the streamed prompt must come after captured content
        // (flushing first lets a non-empty snapshot overwrite the prompt,
        // losing it or leaving its cursor CUP on the wrong line → line start).
        this._gridDone = true
        await this.controller.restorePaneHistory(this.paneId)
        for (const data of this._pendingOutput) {
            this.emitOutput(data)
        }
        this._pendingOutput = []
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
            // Before the tmux grid is applied (see _pendingOutput docs),
            // buffer %output instead of writing at the wrong width.
            if (!this._gridDone) {
                this._pendingOutput.push(data)
                return
            }
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
 * Scope of synchronized input ("Focus all tmux panes").
 *
 * - 'off':    input goes to the active pane only (default)
 * - 'window': input is broadcast to every pane in the SAME window
 *             (matches tmux's native synchronize-panes semantics)
 * - 'all':    input is broadcast to every pane across ALL windows
 */
export type SyncScope = 'off' | 'window' | 'all'

/**
 * Window state tracking
 */
interface WindowState {
    id: number
    name: string
    /**
     * Window index as reported by list-windows #{window_index}. This is the
     * order tmux displays windows in (0, 1, 2, ...), which is INDEPENDENT of
     * the window ID — move-window / swap-window reorder indexes without
     * changing IDs. Undefined until a list-windows has seen this window
     * (e.g. a runtime %window-add notification before the next discover);
     * such windows sort after all indexed ones.
     */
    index?: number
    layout?: string
    /** Saved layout when pane is zoomed (the real multi-pane layout) */
    visibleLayout?: string
    /** Pane ID of the zoomed pane, if any */
    zoomedPaneId?: number
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
    private attached = false
    /** Session-level active window (single value, from #{window_active} / %session-window-changed) */
    private activeWindowId: number | null = null
    /**
     * Window-level active pane: each window has its own active pane.
     * Restored from list-panes #{pane_active} on (re)connect, updated by
     * %window-pane-changed at runtime. This is the authoritative source for
     * which pane UI hotkeys route to after switching windows.
     */
    private windowActivePanes = new Map<number, number>()

    /**
     * Synchronized-input scope for "Focus all tmux panes".
     *
     * Lives on the controller (session-level) so every pane tab — including
     * ones created after the mode was enabled — agrees on the current scope.
     */
    private syncScope: SyncScope = 'off'

    /**
     * The xterm cell size (CSS pixels) of the host terminal tab, captured at
     * attach time (TmuxService.attachToTerminal). The host terminal is fully
     * rendered by the time the user triggers "Enter tmux Mode", so its cell
     * size is measured with the real (loaded) font — unlike a freshly created
     * tmux pane whose xterm may still be initializing.
     *
     * Pane xterms use the same global font config (tabby-terminal reads
     * config.terminal.fontFamily/fontSize), so this value equals the cell
     * size every pane will end up with. SessionTab falls back to it until a
     * pane's own xterm is ready, which makes the FIRST client size push
     * correct instead of being based on a fallback-font measurement.
     *
     * Null when the host cell could not be read (shouldn't happen); the
     * original "wait for a pane's xterm" logic remains as the fallback.
     */
    private hostCellSize: { width: number; height: number } | null = null

    /**
     * Whether a client size has been pushed to tmux (refresh-client -C) at
     * least once. History capture (capture-pane) must not run before this:
     * tmux would capture the grid at its stale pre-attach size, and restoring
     * that into a correctly-sized xterm mis-wraps history (multi-line panes).
     * The flag is set by TmuxSessionTabComponent.refreshClientSize() (Step A)
     * and guards capturePaneSnapshots() against out-of-order discovery.
     */
    private clientSizePushed = false

    /**
     * In-flight discover promise (single-flight guard).
     *
     * discoverWindowsAndPanes is reached from four independent paths that all
     * fire during attach: gateway `initialized$`, `sessionChanged$`,
     * `windowAdd$`, and SessionTab Step B `refreshPanes()`. Without dedup,
     * each path enqueues its own list-windows + list-panes into the gateway
     * commandQueue even when a discover is already running — the extra command
     * round-trips block the serial queue and stall the first real capture (the
     * one that passes the clientSizePushed guard). The single-flight guard
     * makes all four paths share the SAME in-flight Promise so only one batch
     * of list-windows/list-panes is ever in the queue; callers that arrive
     * mid-flight await the running result instead of starting a parallel scan.
     */
    private discoveringPromise: Promise<void> | null = null

    /**
     * Last client size pushed to tmux (refresh-client -C). Rows is needed by
     * restorePaneHistory() to map a history line index to an xterm screen row
     * (lines scroll off when the written content exceeds the screen height).
     */
    private clientRows = 0

    public gateway: TmuxGateway
    public events = new Subject<{ type: string; paneId?: number; windowId?: number; data?: any }>()

    private get log(): ConditionalLogger {
        return createConditionalLogger(this.logger, this.configService)
    }

    constructor(
        private logger: Logger,
        _injector: Injector, // eslint-disable-line @typescript-eslint/no-unused-vars
        writer: (data: string) => void,
        private closer: () => void,
        private configService?: ConfigService,
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

        // Handle session changes - this is our main initialization point.
        // We batch-discover here (like iTerm2) — this is also what makes the
        // gateway's initialized$ fire (it triggers on the first command
        // response, see TmuxGateway.finishCurrentCommand), which the UI
        // depends on to create the SessionTab. Without it, nothing would ever
        // initialize.
        //
        // The capture step is guarded by the clientSizePushed flag: before the
        // first refresh-client (correct size) the history/screen snapshot is
        // skipped and rolled back, so it cannot be based on tmux's stale
        // pre-attach window size. TmuxSessionTabComponent Step B re-discovers
        // and captures after Step A pushes the size.
        this.gateway.sessionChanged$.subscribe(({ sessionName, sessionId }) => {
            this.sessionName = sessionName
            this.attached = true
            this.log.info(`Attached to session: ${sessionName} ($${sessionId})`)
            this.events.next({ type: 'session-changed', data: { sessionName, sessionId } })
            // Immediate batch discovery — no setTimeout delay
            this.discoverWindowsAndPanes()
        })

        // Handle window events
        this.gateway.windowAdd$.subscribe((windowId) => {
            if (!this.windowStates.has(windowId)) {
                this.windowStates.set(windowId, {
                    id: windowId,
                    name: `Window ${windowId}`,
                    panes: new Set(),
                })
            }
            this.events.next({ type: 'window-add', windowId })
            // For new windows created at runtime (after initial attach),
            // tmux may NOT send %layout-change — only %window-add and %output.
            // We must proactively discover the window's layout and panes.
            // The window-add event has already been emitted above, so the UI
            // has registered the window. discoverWindowsAndPanes will update
            // the windowState with layout and emit pane-add + layout-change.
            //
            // Single-flight caveat: if a discover is already running (e.g.
            // another window-add or an attach-phase discover), await its
            // result, then re-check this window's panes — the in-flight
            // discover's list-windows/list-panes may have executed before
            // this window existed, leaving its panes empty. If still empty,
            // kick off a follow-up discover (the guard is now clear).
            this.discoverWindowsAndPanes().then(() => {
                const state = this.windowStates.get(windowId)
                if (state && state.panes.size === 0) {
                    this.discoverWindowsAndPanes()
                }
            })
        })

        this.gateway.windowClose$.subscribe((windowId) => {
            this.windowStates.delete(windowId)
            this.windowActivePanes.delete(windowId)
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
            // If the closed pane was this window's active pane, drop the record.
            // tmux will send %window-pane-changed shortly after to re-point it.
            if (this.windowActivePanes.get(windowId) === paneId) {
                this.windowActivePanes.delete(windowId)
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
                // tmux %layout-change semantics:
                //   layout       = real multi-pane layout (all panes, actual sizes)
                //   visibleLayout = what tmux displays (zoomed single pane when zoomed)
                state.layout = layout
                if (zoomed && visibleLayout) {
                    // Extract zoomed pane ID from visibleLayout (the single pane filling window)
                    const m = /\d+x\d+,\d+,\d+,(\d+)/.exec(visibleLayout)
                    state.zoomedPaneId = m ? parseInt(m[1]) : undefined
                    state.visibleLayout = visibleLayout
                } else {
                    state.zoomedPaneId = undefined
                    state.visibleLayout = undefined
                }
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

        // Handle pane focus changes (e.g. after pane close, tmux auto-focuses
        // the next pane and sends %window-pane-changed).
        // Record per-window active pane — this is window-level state, distinct
        // from the session-level activeWindowId.
        this.gateway.paneChanged$.subscribe(({ windowId, paneId }) => {
            this.log.info(`Active pane changed to %${paneId} in window @${windowId}`)
            this.windowActivePanes.set(windowId, paneId)
            this.events.next({ type: 'active-pane-changed', paneId, windowId })
        })

        this.gateway.exit$.subscribe((reason) => {
            this.attached = false
            this.events.next({ type: 'exit', data: { reason } })
            this.closer()
        })

        // Handle initialization
        this.gateway.initialized$.subscribe(() => {
            this.events.next({ type: 'initialized' })
            // Re-discover here too (idempotent; capture guarded by
            // clientSizePushed — see sessionChanged$ note). Fires on the
            // first command response, before the SessionTab's Step A size
            // push, so any history capture is skipped/rolled back until Step B.
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
        // Single-flight: if a discover is already running, await its result
        // instead of starting a second parallel scan. See discoveringPromise.
        if (this.discoveringPromise) {
            return this.discoveringPromise
        }
        this.discoveringPromise = this.runDiscoverWindowsAndPanes().finally(() => {
            this.discoveringPromise = null
        })
        return this.discoveringPromise
    }

    private async runDiscoverWindowsAndPanes(): Promise<void> {
        this.log.info('Batch discovering windows and panes...')
        try {
            // Step 1: Discover all windows with names, layout and active flag
            // NOTE: #{window_index} is captured explicitly — tmux's list-windows
            // output order happens to be index order, but windowStates is a
            // Map whose insertion order is ALSO fed by %window-add notifications
            // (runtime windows, and attach on older tmux versions). Relying on
            // insertion order made the window order unstable (move-window /
            // swap-window reorder indexes without changing IDs). Sorting by
            // index below (getAllWindowStates) makes the order deterministic.
            //
            // #{q:window_name} escapes shell-special characters with backslash
            // (a space in a name becomes `\ `). Parsing the raw name with a
            // plain space-split would misparse names containing "space+digit"
            // (e.g. "foo 1"): the lazy name group would stop at the first
            // space and the digit would be read as #{window_index} / #{window_active},
            // corrupting the index order. The regex below treats `\X` as one
            // name character and unescapes afterwards.
            const winResult = await this.gateway.sendCommand(
                'list-windows -F "#{window_id} #{q:window_name} #{window_index} #{window_active} #{window_layout}"',
                TMUX_COMMAND_TOLERATE_ERRORS,
            )
            const winLines = winResult
                .split(/[\r\n]+/)
                .map((l) => l.trim())
                .filter((l) => l)
            this.log.info(`Found ${winLines.length} window(s) from list-windows`)

            for (const line of winLines) {
                // Format: "@0 'my window' 0 1 1234,0x0,0,0{60x24,0,0,1}"
                // Window name is #{q:}-escaped: a literal space inside the name
                // is `\ `, so `(?:[^\\ ]|\\.)+` treats `\X` as a single name
                // character and only stops at an UNescaped space.
                const match = line.match(/^@?(\d+)\s+((?:[^\\ ]|\\.)+)\s+(\d+)\s+([01])\s+(.+)$/)
                if (match) {
                    const windowId = parseInt(match[1])
                    const windowName = match[2].replace(/\\(.)/g, '$1')
                    const windowIndex = parseInt(match[3])
                    const active = match[4] === '1'
                    const layout = match[5]
                    if (active) {
                        this.activeWindowId = windowId
                    }
                    if (!this.windowStates.has(windowId)) {
                        this.windowStates.set(windowId, {
                            id: windowId,
                            name: windowName,
                            index: windowIndex,
                            layout,
                            panes: new Set(),
                        })
                        this.events.next({ type: 'window-add', windowId })
                    } else {
                        const state = this.windowStates.get(windowId)!
                        state.name = windowName
                        state.index = windowIndex
                        state.layout = layout
                    }
                }
            }

            // Step 2: Discover all panes and map to windows.
            // #{pane_active} restores per-window active pane state on
            // (re)connect — this is window-level state, independent of the
            // session-level active window.
            const paneResult = await this.gateway.sendCommand(
                'list-panes -s -F "#{pane_id} #{window_id} #{pane_active}"',
                TMUX_COMMAND_TOLERATE_ERRORS,
            )
            const paneLines = paneResult
                .split(/[\r\n]+/)
                .map((l) => l.trim())
                .filter((l) => l)
            this.log.info(`Found ${paneLines.length} pane(s) from list-panes`)

            const newPaneIds: Array<{ paneId: number; windowId: number }> = []
            for (const line of paneLines) {
                const match = line.match(/^%?(\d+)\s+@?(\d+)\s+([01])$/)
                if (match) {
                    const paneId = parseInt(match[1])
                    const windowId = parseInt(match[2])
                    if (match[3] === '1') {
                        this.windowActivePanes.set(windowId, paneId)
                    }

                    let windowState = this.windowStates.get(windowId)
                    if (!windowState) {
                        windowState = {
                            id: windowId,
                            name: `Window ${windowId}`,
                            panes: new Set(),
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
                const captured = await this.capturePaneSnapshots(newPaneIds)
                if (!captured) {
                    // Client size not pushed yet (out-of-order discovery, e.g.
                    // %window-add arriving before the first refresh-client).
                    // Roll back so a later discover (after the size push) re-
                    // discovers and captures these panes with the correct size;
                    // otherwise Step 4 would emit pane-add without snapshots
                    // and the history would never be restored.
                    this.log.warn('Rolling back discovery: retrying after client size is pushed')
                    for (const { paneId, windowId } of newPaneIds) {
                        this.knownPanes.delete(paneId)
                        this.windowStates.get(windowId)?.panes.delete(paneId)
                        if (this.windowActivePanes.get(windowId) === paneId) {
                            this.windowActivePanes.delete(windowId)
                        }
                    }
                    return
                }
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
        zoomed?: boolean,
    ): Promise<void> {
        // Extract pane IDs from layout strings.
        // When zoomed, the layout only contains the zoomed pane — also scan
        // visibleLayout (the real multi-pane layout) so all panes are discovered.
        const paneIdSet = new Set<number>()
        const leafPattern = /\d+x\d+,\d+,\d+,(\d+)/g
        let m: RegExpExecArray | null
        const layoutsToScan = zoomed && visibleLayout ? [layout, visibleLayout] : [layout]
        for (const ls of layoutsToScan) {
            leafPattern.lastIndex = 0
            while ((m = leafPattern.exec(ls)) !== null) {
                paneIdSet.add(parseInt(m[1]))
            }
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

        // Remove panes no longer in the layout (only when not zoomed).
        // When zoomed, the real layout is in visibleLayout, and pane-close
        // events should handle cleanup of actually closed panes.
        if (!zoomed && windowState) {
            const closedPaneIds: number[] = []
            for (const paneId of windowState.panes) {
                if (!paneIdSet.has(paneId)) {
                    closedPaneIds.push(paneId)
                }
            }
            for (const paneId of closedPaneIds) {
                windowState.panes.delete(paneId)
                this.knownPanes.delete(paneId)
                // Drop stale active-pane record (pane moved/closed)
                if (this.windowActivePanes.get(windowId) === paneId) {
                    this.windowActivePanes.delete(windowId)
                }
                // Clean up pane session
                const session = this.paneSessions.get(paneId)
                if (session) {
                    session.destroy()
                    this.paneSessions.delete(paneId)
                }
                this.pendingPaneOutput.delete(paneId)
                this.log.info(
                    `Removed closed pane %${paneId} from window @${windowId} (not in layout)`,
                )
                this.events.next({ type: 'pane-close', paneId, windowId })
            }
        }

        if (newPaneIds.length > 0) {
            this.log.info(
                `Discovered ${newPaneIds.length} new pane(s) from layout-change for window @${windowId}`,
            )

            // Capture history + state for new panes (same as discoverWindowsAndPanes Step 3)
            const captured = await this.capturePaneSnapshots(newPaneIds)
            if (!captured) {
                // Client size not pushed yet (out-of-order %layout-change before
                // the first refresh-client). Roll back so a later discover
                // (after the size push) re-discovers and captures these panes;
                // otherwise pane-add would be emitted without snapshots and the
                // history would never be restored.
                this.log.warn('Rolling back layout discovery: retrying after client size is pushed')
                for (const { paneId, windowId: wid } of newPaneIds) {
                    this.knownPanes.delete(paneId)
                    this.windowStates.get(wid)?.panes.delete(paneId)
                    if (this.windowActivePanes.get(wid) === paneId) {
                        this.windowActivePanes.delete(wid)
                    }
                }
                // Do NOT emit layout-change here: syncLayout would create pane
                // tabs for panes whose snapshots were rolled back, and their
                // history would never be restored (pane-add from the later
                // re-discovery is swallowed by paneMap.has). A later discover
                // (after the size push) re-adds these panes and emits both
                // pane-add and layout-change.
                return
            } else {
                // Emit pane-add events — history is now pre-loaded
                for (const { paneId, windowId: wid } of newPaneIds) {
                    this.events.next({ type: 'pane-add', paneId, windowId: wid })
                }
            }
        }

        // Emit layout-change AFTER pane-add events, so syncLayout() can
        // create views for newly discovered panes. This ordering is critical:
        // pane-add → handlePaneAdd (creates pane tab) → layout-change →
        // syncLayout (attaches view + builds SplitTree).
        this.events.next({
            type: 'layout-change',
            windowId,
            data: { layout, visibleLayout, zoomed },
        })
    }

    /**
     * Capture history + state for an array of panes.
     * Shared by discoverWindowsAndPanes() and discoverPanesFromLayout().
     */
    private async capturePaneSnapshots(
        paneIds: Array<{ paneId: number; windowId: number }>,
    ): Promise<boolean> {
        // Guard: capturing history/screen before any client size has been
        // pushed (refresh-client -C) uses tmux's stale pre-attach window size,
        // and restoring that into the correctly-sized xterm mis-wraps history
        // (panes showing extra/multi-line content until a manual resize
        // reflows). Initial discovery is triggered by
        // TmuxSessionTabComponent Step B AFTER the Step A size push; this
        // guard only protects against out-of-order discovery (e.g. if the -CC
        // prologue behavior ever changes and %window-add fires early).
        // Returns false so the caller can roll back and let a later discover
        // (after the size push) re-capture these panes.
        if (!this.hasClientSizePushed) {
            this.log.warn(
                `Skipping history capture for ${paneIds.length} pane(s): client size not pushed yet`,
            )
            return false
        }
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
            'pane_height=#{pane_height}',
        ].join('\t')

        const captures = paneIds.map(async ({ paneId }) => {
            try {
                const [history, altHistory, stateResult] = await Promise.all([
                    this.gateway.sendCommand(
                        `capture-pane -peqJN -S- -t %${paneId}`,
                        TMUX_COMMAND_TOLERATE_ERRORS,
                    ),
                    this.gateway.sendCommand(
                        `capture-pane -peqJN -a -S- -t %${paneId}`,
                        TMUX_COMMAND_TOLERATE_ERRORS,
                    ),
                    this.gateway.sendCommand(
                        `list-panes -t %${paneId} -F "${stateFormat}"`,
                        TMUX_COMMAND_TOLERATE_ERRORS,
                    ),
                ])
                const state = parsePaneState(stateResult, paneId)
                this.pendingSnapshots.set(paneId, { history, altHistory, state })
            } catch (e) {
                this.logger.warn(`Failed to capture snapshot for pane %${paneId}:`, e)
            }
        })
        await Promise.all(captures)
        return true
    }

    // --- Pane Management ---

    registerPane(paneId: number, session: TmuxPaneSession): void {
        this.paneSessions.set(paneId, session)
        this.knownPanes.add(paneId)

        // If the snapshot already captured real content, the pending output
        // is redundant — the snapshot contains the same content (and more),
        // and restorePaneHistory will write it. Discard the buffer to avoid
        // writing the prompt/scrollback twice.
        // But if the snapshot is EMPTY (the pane was captured before its
        // shell printed the prompt — e.g. a fresh window on a slow remote
        // box, cursor_x=0), the buffered %output is the ONLY copy of the
        // prompt. Keep and flush it; dropping it would leave the pane
        // without a prompt ("sometimes no prompt at all").
        const snapshot = this.pendingSnapshots.get(paneId)
        if (snapshot && snapshot.history && snapshot.history.trim()) {
            this.pendingPaneOutput.delete(paneId)
            return
        }

        // Snapshot absent or empty — flush buffered output to the session
        // (it will render once the tmux grid is applied).
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

    resizePane(_paneId: number, columns: number, rows: number): void {
        // Use refresh-client -C to set client size
        // This affects all panes uniformly in non-variable-size mode
        // Note: paneId is ignored as tmux control mode uses uniform size
        this.clientRows = rows
        this.gateway
            .sendCommand(`refresh-client -C ${columns},${rows}`, TMUX_COMMAND_TOLERATE_ERRORS)
            .catch((e) => this.logger.warn('Resize failed:', e))
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
        // Normalize the history before writing it:
        // 1. collapseRedundantTailLines — fold zsh SIGWINCH prompt redraws
        //    (N identical prompt lines accumulated in history) down to one.
        // 2. Drop all-whitespace placeholder lines from the HISTORY part
        //    (everything before the last `rows` lines = the tmux screen).
        //    tmux stores history at window width, so these placeholders are
        //    often wider than the pane (or are plain blanks) and are pure
        //    scrollback padding, not real content: feeding them into the
        //    pane-width xterm wraps them (inflating line count / skewing
        //    cursor math) and, with no real history, pushes the restored
        //    screen down one row (prompt ends up on row 2 instead of row 1).
        //    Removing them restores the prompt to the top; the screen part
        //    (the last `rows` lines) is kept as-is, so genuine blank screen
        //    rows are preserved and the prompt position still matches the
        //    tmux screen when real history exists.
        let primary = ''
        if (snapshot.history) {
            primary = this.collapseRedundantTailLines(snapshot.history)
            // capture-pane output ends with a trailing newline, so split()
            // yields one extra empty element; drop it FIRST so the
            // history/screen split below uses the real line count (otherwise
            // screenStart is off by one and the first screen row can be
            // mistaken for history and dropped).
            const lines = primary.split('\n')
            if (lines.length > 1 && lines[lines.length - 1] === '') {
                lines.pop()
            }
            // Drop history-part placeholders (see the normalize notes above).
            const rows = state.rows
            if (rows && rows > 0 && lines.length > rows) {
                const screenStart = lines.length - rows
                primary = lines.filter((l, i) => i >= screenStart || l.trim() !== '').join('\n')
            } else {
                primary = lines.join('\n')
            }
            // Also drop leading all-whitespace rows: after a size change tmux
            // may leave blank padding at the top of the screen (and capture
            // -S- can be exactly `rows` lines, so those rows count as
            // "screen", not "history"). With no real content above the
            // prompt the user expects the prompt at row 0, not under a blank
            // row. When real history exists the leading rows are content
            // (non-blank), so this only ever strips padding (a genuine blank
            // first scrollback row would also be stripped, but in the
            // streaming model that is visually indistinguishable).
            const finalLines = primary.split('\n')
            while (finalLines.length > 0 && finalLines[0].trim() === '') {
                finalLines.shift()
            }
            primary = finalLines.join('\n')
            session.feedOutput(Buffer.from(primary.replace(/\n/g, '\r\n'), 'utf-8'))
        }

        // Step 2: If the pane is on the alternate screen (vim, less, etc.),
        // switch to it and write the alternate content.  We stay on alternate.
        if (state.alternateOn) {
            // ?1047h enters alternate screen and clears it
            session.feedOutput(Buffer.from('\x1b[?1047h', 'utf-8'))

            // Apply terminal state on the alternate screen (scroll region,
            // modes, cursor visibility — NOT the cursor position yet).
            applyPaneState(session, state)

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
            session.feedOutput(
                Buffer.from(csi(`${state.cursorY + 1};${state.cursorX + 1}H`), 'utf-8'),
            )

            // Save alternate screen data for re-apply after xterm.resize()
            // (called by setTmuxGrid).  xterm.resize() clears the alternate
            // screen buffer, so the content must be written again.
            session.pendingAltRestore = {
                content: snapshot.altHistory || '',
                cursorY: state.cursorY,
                cursorX: state.cursorX,
                modes: buildModeSequences(state),
            }
        } else {
            // Normal mode — write alternate history if present (rare)
            if (snapshot.altHistory && snapshot.altHistory.trim()) {
                session.feedOutput(Buffer.from('\x1b[?1047h', 'utf-8'))
                const normalized = snapshot.altHistory.replace(/\n/g, '\r\n')
                session.feedOutput(Buffer.from(normalized, 'utf-8'))
                session.feedOutput(Buffer.from('\x1b[?1047l', 'utf-8'))
            }

            // Apply terminal state (cursor, scroll region, modes).
            // Compute the last non-empty line first: when the pane was
            // captured before the shell printed its prompt (e.g. a freshly
            // split bash login shell still initializing), primary is empty
            // and we must skip the cursor CUP — otherwise the stale initial
            // cursor_x (often 0) places the cursor at the line start instead
            // of after the prompt that %output streams in afterwards.
            const lines = primary.split('\n')
            let lastNonEmpty = -1
            for (let i = lines.length - 1; i >= 0; i--) {
                if (lines[i].trim() !== '') {
                    lastNonEmpty = i
                    break
                }
            }
            applyPaneState(session, state, lastNonEmpty < 0)

            // Cursor correction (zsh compatibility + capture -S- offset).
            // iTerm2's VT100Terminal stores history in a separate scrollback
            // (setTmuxHistory), so cursorY (screen-relative) maps directly to
            // its grid. xterm is streaming: we write "history + screen" via
            // feedOutput, so when the content is shorter than the screen the
            // history lines stay on top and shift the tmux screen content
            // down; additionally zsh's SIGWINCH prompt redraw can leave tmux's
            // reported cursor_y on a blank line (prompt redrawn elsewhere).
            // Instead of trusting cursor_y, put the cursor at the end of the
            // last non-empty content line, keeping tmux's horizontal cursor_x.
            // On the primary screen the cursor normally sits on the prompt /
            // last output line; full-screen apps (vim/less/htop) use the
            // alternate screen and take the branch above.
            if (lastNonEmpty >= 0) {
                // After writing N lines into a `rows` screen, output line i
                // lands at xterm y = i - max(0, N - rows) (excess scrolls off).
                // Use the pane's own captured height (state.rows) — with
                // vertical splits each pane is shorter than the client, and
                // using clientRows would overshoot and make xterm scroll.
                const rows = state.rows ?? Math.max(1, this.clientRows)
                const scrolled = Math.max(0, lines.length - rows)
                const y = Math.max(0, Math.min(rows - 1, lastNonEmpty - scrolled))
                // Visible width (strip SGR color codes) for a sane X clamp.
                const visible = lines[lastNonEmpty].replace(/\x1b\[[0-9;]*m/g, '').length
                // If tmux captured cursor_x = 0 but the last non-empty line
                // (the prompt) has content, the pane was captured before the
                // shell printed its prompt (slow login shells, e.g. bash on a
                // fresh split: cursor still at 0,0) and %output delivered the
                // prompt afterwards — the stale cursor_x would place the
                // cursor at the start of the prompt line. Put it after the
                // prompt instead. If the user was genuinely editing at column
                // 0 the cursor jumps to end-of-line, which is acceptable on
                // restore.
                const x =
                    state.cursorX > 0
                        ? Math.max(0, Math.min(state.cursorX, Math.max(visible, 0)))
                        : Math.max(0, Math.max(visible, 0))
                session.feedOutput(Buffer.from(`\x1b[${y + 1};${x + 1}H`, 'utf-8'))
            }
        }
    }

    /**
     * Collapse redundant trailing lines that are identical to the last
     * non-empty line. This is a zsh compatibility fix:
     *
     * When the tmux window size changes (split, resize, or the attach-time
     * refresh-client), zsh receives SIGWINCH and redraws its prompt. The
     * redraw pushes the current prompt line into the tmux scrollback
     * (once per resize), while the screen itself keeps showing a single
     * prompt. Over multiple resizes/attaches this accumulates N identical
     * prompt lines in history, and capture-pane -S- (history + screen)
     * restores them all — the pane looks like it has N repeated prompts.
     * bash does not redraw on SIGWINCH, so it is unaffected.
     *
     * We fold only the TRAILING run of lines that are byte-identical to the
     * last non-empty line (keeping one). Ordinary multi-line history is
     * untouched unless it happens to end in identical lines.
     */
    private collapseRedundantTailLines(history: string): string {
        const lines = history.split('\n')
        let tail = lines.length - 1
        while (tail >= 0 && lines[tail].trim() === '') {
            tail--
        }
        if (tail <= 0) {
            return history
        }

        // Count how many lines directly above `tail` are identical to it.
        let sameStart = tail - 1
        while (
            sameStart >= 0 &&
            lines[sameStart] === lines[tail] &&
            lines[sameStart].trim() !== ''
        ) {
            sameStart--
        }
        const redundant = tail - sameStart - 1
        if (redundant > 0) {
            lines.splice(sameStart + 1, redundant)
        }
        return lines.join('\n')
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
        session.feedOutput(Buffer.from(csi(`${alt.cursorY + 1};${alt.cursorX + 1}H`), 'utf-8'))
    }

    async killPane(paneId: number): Promise<void> {
        await this.gateway.sendCommand(`kill-pane -t %${paneId}`, TMUX_COMMAND_TOLERATE_ERRORS)
    }

    /**
     * Toggle zoom on a pane (tmux prefix+z equivalent).
     * When zoomed, the pane fills the entire window; other panes are hidden.
     */
    async zoomPane(paneId: number): Promise<void> {
        await this.gateway.sendCommand(`resize-pane -Z -t %${paneId}`, TMUX_COMMAND_TOLERATE_ERRORS)
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

    // --- Session Operations ---

    async detach(): Promise<void> {
        this.gateway.detach()
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

    /**
     * Record the host terminal tab's xterm cell size, captured at attach time
     * (TmuxService.attachToTerminal). See hostCellSize docs for why this makes
     * the first client size push correct.
     */
    setHostCellSize(size: { width: number; height: number } | null): void {
        this.hostCellSize = size
    }

    /**
     * The host terminal's xterm cell size, or null if it could not be read.
     * SessionTab uses this as the cell-size reference until a mounted pane's
     * own xterm reports its (identical) dimensions.
     */
    getHostCellSize(): { width: number; height: number } | null {
        return this.hostCellSize
    }

    /** Mark that a client size has been pushed to tmux (see clientSizePushed). */
    setClientSizePushed(): void {
        this.clientSizePushed = true
    }

    /** Whether refresh-client -C has been sent at least once. */
    get hasClientSizePushed(): boolean {
        return this.clientSizePushed
    }

    get isAttached(): boolean {
        return this.attached
    }

    getSessionName(): string {
        return this.sessionName
    }

    getWindowState(windowId: number): WindowState | undefined {
        return this.windowStates.get(windowId)
    }

    /**
     * All known window states in tmux's display order (window index
     * ascending). The order is derived from #{window_index} (captured from
     * list-windows), NOT from the Map insertion order — insertion order is
     * fed by %window-add notifications and list-panes, neither of which is
     * guaranteed to match the index order (move-window / swap-window reorder
     * indexes without changing window IDs). Windows whose index is not yet
     * known (runtime %window-add before the next list-windows) sort last,
     * keeping the Map insertion order among themselves.
     */
    getAllWindowStates(): WindowState[] {
        return Array.from(this.windowStates.values()).sort(
            (a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER),
        )
    }

    /**
     * Number of panes in the window that owns the given pane (0 when the
     * pane is not tracked). Used to disable zoom toggling on single-pane
     * windows, where tmux's resize-pane -Z is a no-op (command fails).
     */
    getWindowPaneCount(paneId: number): number {
        for (const state of this.windowStates.values()) {
            if (state.panes.has(paneId)) {
                return state.panes.size
            }
        }
        return 0
    }

    getFirstWindowId(): number | undefined {
        return this.getAllWindowStates()[0]?.id
    }

    /**
     * Get the tmux-side active window ID, as reported by list-windows
     * #{window_active} or %session-window-changed. Falls back to null.
     */
    getActiveWindowId(): number | null {
        return this.activeWindowId
    }

    /**
     * Get the tmux-side active pane ID for a window, as reported by
     * list-panes #{pane_active} or %window-pane-changed.
     *
     * Pane activation is window-level state (each window has its own active
     * pane), independent of the session-level active window. Returns null
     * when unknown (e.g. the active pane just closed and tmux has not yet
     * sent %window-pane-changed).
     */
    getActivePaneId(windowId: number): number | null {
        return this.windowActivePanes.get(windowId) ?? null
    }

    /**
     * Get all known pane IDs across all windows.
     */
    getAllPaneIds(): number[] {
        return Array.from(this.knownPanes)
    }

    /**
     * Current synchronized-input scope ("Focus all tmux panes").
     */
    getSyncScope(): SyncScope {
        return this.syncScope
    }

    setSyncScope(scope: SyncScope): void {
        this.syncScope = scope
    }

    /**
     * ID of the window that owns the given pane, or null when the pane is
     * not tracked.
     */
    getWindowIdForPane(paneId: number): number | null {
        for (const state of this.windowStates.values()) {
            if (state.panes.has(paneId)) {
                return state.id
            }
        }
        return null
    }

    /**
     * Pane IDs that synchronized input should be broadcast to for the given
     * source pane, honoring the current sync scope. The source pane itself is
     * excluded.
     *
     * - 'window': only panes in the same window (tmux synchronize-panes)
     * - 'all':    every pane across all windows
     * - 'off':    empty
     *
     * Returns empty when sync is off or the source pane is unknown.
     */
    getSyncTargetPaneIds(sourcePaneId: number): number[] {
        if (this.syncScope === 'off') return []
        // Unknown source pane: no targets (consistent across scopes)
        if (!this.knownPanes.has(sourcePaneId)) return []
        const targets: number[] = []
        if (this.syncScope === 'window') {
            const windowId = this.getWindowIdForPane(sourcePaneId)
            if (windowId === null) return []
            const panes = this.windowStates.get(windowId)?.panes
            if (!panes) return []
            for (const pid of panes) {
                if (pid !== sourcePaneId) targets.push(pid)
            }
        } else {
            for (const pid of this.knownPanes) {
                if (pid !== sourcePaneId) targets.push(pid)
            }
        }
        return targets
    }
}
