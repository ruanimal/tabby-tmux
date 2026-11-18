import { Subject } from 'rxjs'
import { BaseSession, SessionMiddleware } from 'tabby-terminal'
import { Logger, ConfigService } from 'tabby-core'
import { createConditionalLogger, ConditionalLogger } from './logHelper'
import { Injector } from '@angular/core'
import { TmuxCommand, TmuxGateway, TMUX_COMMAND_TOLERATE_ERRORS } from './gateway'
import { parsePaneState } from './paneState'
import { buildSnapshotRestore, PaneSnapshot } from './paneSnapshot'
import { normalizeHistoryRestoreLimit } from './historyRestore'
import {
    ResizeDirection,
    SplitDirection,
    resizePaneFlag,
    selectPaneFlag,
    splitWindowFlags,
} from './tmuxKeymap'
import { quoteTmuxArgument, normalizeRename, unescapeTmuxValue } from './tmuxRename'

interface PaneOutputChunk {
    data: Buffer
    sequence?: number
}

/** Align terminal text chunks after binary-aware session middleware. */
class PaneUTF8Splitter extends SessionMiddleware {
    private pending = Buffer.alloc(0)

    override feedFromSession(data: Buffer): void {
        const complete = this.split(data)
        if (complete.length) super.feedFromSession(complete)
    }

    /** Advance across bytes represented by a restored snapshot. */
    discard(data: Buffer): void {
        this.split(data)
    }

    override close(): void {
        if (this.pending.length) super.feedFromSession(this.pending)
        this.pending = Buffer.alloc(0)
        super.close()
    }

    private split(data: Buffer): Buffer {
        if (this.pending.length) data = Buffer.concat([this.pending, data])
        this.pending = Buffer.alloc(0)

        // A UTF-8 sequence can have at most three trailing continuation bytes.
        let start = data.length - 1
        while (start >= 0 && data[start] >= 0x80 && data[start] <= 0xbf) {
            if (data.length - start > 3) return data
            start--
        }
        if (start < 0) return data
        const lead = data[start]
        const width =
            lead >= 0xc2 && lead <= 0xdf
                ? 2
                : lead >= 0xe0 && lead <= 0xef
                  ? 3
                  : lead >= 0xf0 && lead <= 0xf4
                    ? 4
                    : 0
        if (width && data.length - start < width) {
            // Retain only the incomplete sequence, not the entire input chunk.
            this.pending = Buffer.from(data.subarray(start))
            return data.subarray(0, start)
        }
        return data
    }
}

/**
 * TmuxPaneSession - Represents a single tmux pane as a terminal session
 */
export class TmuxPaneSession extends BaseSession {
    /**
     * Incomplete screen-title sequence (ESC k ... ESC \) spanning
     * multiple feedOutput calls.  Buffered until the closing ST arrives.
     */
    private _pendingTitleSeq: Buffer | null = null
    private readonly _utf8Splitter = new PaneUTF8Splitter()

    constructor(
        logger: Logger,
        private controller: TmuxController,
        public paneId: number,
    ) {
        super(logger)
        this.middleware.push(this._utf8Splitter)
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
    private _pendingOutput: PaneOutputChunk[] = []
    private _gridDone = false
    /**
     * Successful snapshots cover only output before their active-frame
     * response. Preserve later notifications, including those in the same
     * PTY packet as the response terminator.
     */
    private _snapshotCovers: number | undefined
    private _restoring: Promise<void> | null = null
    // On attach, tmux's saved normal grid may already have a different size
    // from the active alternate screen. Refresh on its first return as well.
    private _normalScreenNeedsRefresh = true
    private _destroyed = false

    /** A hidden normal buffer can resize differently in tmux and xterm. */
    gridResized(bufferType: string): void {
        if (bufferType === 'alternate') this._normalScreenNeedsRefresh = true
    }

    screenBufferChanged(bufferType: string): Promise<void> {
        if (bufferType !== 'normal' || !this._normalScreenNeedsRefresh || this._destroyed) {
            return Promise.resolve()
        }
        this._normalScreenNeedsRefresh = false
        // Ask tmux for the now-visible normal screen rather than guessing how
        // its saved grid was resized. No keyboard input/redraw is injected.
        return this.restoreSnapshot(true)
    }

    async start(): Promise<void> {
        this.open = true
        try {
            // Wait for the pane's xterm to apply the tmux layout grid before
            // restoring history, so history lines are written at the correct
            // column width (see _gridApplied docs). 3s timeout as a fallback for
            // panes that never get a grid (e.g. not present in any layout) —
            // degraded (possibly mis-wrapped) history is better than none.
            await Promise.race([
                this._gridApplied,
                new Promise<void>((resolve) => setTimeout(resolve, 3000)),
            ])

            await this.restoreSnapshot(false)
        } catch (e) {
            this.logger.warn(`Pane %${this.paneId}: failed to restore tmux history`, e)
        }
    }

    private restoreSnapshot(force: boolean): Promise<void> {
        if (this._destroyed) return Promise.resolve()
        if (this._restoring) {
            return force ? this._restoring.then(() => this.restoreSnapshot(true)) : this._restoring
        }
        const run = async () => {
            this._gridDone = false
            try {
                if (force || !this.controller.hasPendingSnapshot(this.paneId)) {
                    await this.controller.ensurePaneSnapshot(this.paneId, force)
                }
                if (this._destroyed) return
                this._snapshotCovers = await this.controller.restorePaneHistory(this.paneId)
            } catch (error) {
                this.logger.warn(`Pane %${this.paneId}: failed to restore snapshot`, error)
            } finally {
                this._gridDone = true
                for (const { data, sequence } of this._pendingOutput) {
                    if (
                        !this._destroyed &&
                        (this._snapshotCovers === undefined ||
                            sequence === undefined ||
                            sequence > this._snapshotCovers)
                    ) {
                        this.emitOutput(data)
                    } else if (!this._destroyed) {
                        this._utf8Splitter.discard(data)
                    }
                }
                this._pendingOutput = []
                this._snapshotCovers = undefined
            }
        }
        this._restoring = run().finally(() => {
            this._restoring = null
        })
        return this._restoring
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
        this._destroyed = true
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

    /** Restore captured terminal cells independently of live output processing. */
    feedSnapshot(data: Buffer): void {
        if (this._destroyed) return
        // Snapshots can contain protocol markers from completed file transfers.
        // Deliver them after the middleware chain so plugins such as trzsz do
        // not interpret captured history as a new live transfer.
        this.output.next(data.toString('utf-8'))
        this.binaryOutput.next(data)
    }

    /**
     * Deliver live pane output, buffering it while a snapshot is restored.
     *
     * Filters out screen/tmux "set window title" sequences (ESC k ... ESC \)
     * which xterm.js does not recognize. Without filtering, zsh precmd/preexec
     * hooks that set the terminal title via `print -Pn "\ek%s\e\\"` would leak
     * the title text as visible output (e.g. `echo111` instead of `111`).
     */
    feedOutput(data: Buffer, sequence?: number): void {
        data = this.filterScreenTitleSequences(data)
        if (data.length > 0) {
            // Before the tmux grid is applied (see _pendingOutput docs),
            // buffer %output instead of writing at the wrong width.
            if (!this._gridDone) {
                this._pendingOutput.push({ data, sequence })
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
    private paneTitles = new Map<number, string>()
    private pendingPaneOutput = new Map<number, PaneOutputChunk[]>()
    private paneOutputSequences = new Map<number, number>()
    /** Pre-loaded history from batch discovery (iTerm2-style). */
    private pendingSnapshots = new Map<number, PaneSnapshot>()
    /** A failed discovery capture is consumed once by start(), not retried immediately. */
    private failedSnapshots = new Set<number>()
    private snapshotQueue: Promise<void> = Promise.resolve()
    private snapshotCaptures = new Map<number, Promise<PaneSnapshot | null>>()
    private destroyed = false
    private sessionName = ''
    /** Hostname of the machine running the tmux server. */
    private hostName = ''
    private hostRefreshPromise: Promise<void> | null = null
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
            const sequence = (this.paneOutputSequences.get(paneId) ?? 0) + 1
            this.paneOutputSequences.set(paneId, sequence)

            if (this.paneSessions.has(paneId)) {
                this.paneSessions.get(paneId)!.feedOutput(data, sequence)
            } else {
                // Buffer output for panes not yet registered
                if (!this.pendingPaneOutput.has(paneId)) {
                    this.pendingPaneOutput.set(paneId, [])
                }
                this.pendingPaneOutput.get(paneId)!.push({ data, sequence })
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
                    name: '',
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
            const windowState = this.windowStates.get(windowId)
            for (const paneId of windowState?.panes ?? []) {
                this.knownPanes.delete(paneId)
                this.paneTitles.delete(paneId)
            }
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
            this.paneTitles.delete(paneId)
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
            // Fetch window_flags + window_visible_layout so zoom state can be
            // restored on reattach. tmux does NOT emit %layout-change on attach
            // (verified on tmux 3.5a — attach only sends %begin/%end/
            // %session-changed/%output/%window-pane-changed), so live zoom state
            // must be captured here from the initial list-windows batch. The Z
            // window flag marks a zoomed window; #{window_visible_layout} is the
            // single-pane layout when zoomed (== window_layout when not).
            const winResult = await this.gateway.sendCommand(
                'list-windows -F "#{window_id} #{q:window_name} #{window_index} #{window_active} #{window_layout} #{window_flags} #{window_visible_layout}"',
                TMUX_COMMAND_TOLERATE_ERRORS,
            )
            const winLines = winResult
                .split(/[\r\n]+/)
                .map((l) => l.trim())
                .filter((l) => l)
            this.log.info(`Found ${winLines.length} window(s) from list-windows`)

            for (const line of winLines) {
                // Format: "@0 'my window' 0 1 1234,0x0,0,0{60x24,0,0,1} *Z ac9d,80x24,0,0,0"
                // Window name is #{q:}-escaped: a literal space inside the name
                // is `\ `, so `(?:[^\\ ]|\\.)+` treats `\X` as a single name
                // character and only stops at an UNescaped space.
                // window_visible_layout is absent on tmux < 2.2, so it is an
                // optional trailing group.
                const match = line.match(
                    /^@?(\d+)\s+((?:[^\\ ]|\\.)+)\s+(\d+)\s+([01])\s+(\S+)\s+(\S+)(?:\s+(\S+))?$/,
                )
                if (match) {
                    const windowId = parseInt(match[1])
                    const windowName = match[2].replace(/\\(.)/g, '$1')
                    const windowIndex = parseInt(match[3])
                    const active = match[4] === '1'
                    const layout = match[5]
                    const windowFlags = match[6]
                    const visibleLayout = match[7]
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
                        this.events.next({
                            type: 'window-add',
                            windowId,
                            data: { deferSwitch: true },
                        })
                    } else {
                        const state = this.windowStates.get(windowId)!
                        state.name = windowName
                        state.index = windowIndex
                        state.layout = layout
                    }

                    // Seed zoom state captured at discovery time. Mirrors the
                    // %layout-change handler: layout is always the real multi-pane
                    // layout, visibleLayout is the single-pane layout when the
                    // window is zoomed (Z flag present). On reattach this is the
                    // ONLY source of zoom state (tmux sends no %layout-change).
                    const state = this.windowStates.get(windowId)
                    if (state) {
                        const isZoomed = windowFlags?.includes('Z')
                        if (isZoomed && visibleLayout) {
                            const z = /\d+x\d+,\d+,\d+,(\d+)/.exec(visibleLayout)
                            state.zoomedPaneId = z ? parseInt(z[1]) : undefined
                            state.visibleLayout = visibleLayout
                        } else {
                            state.zoomedPaneId = undefined
                            state.visibleLayout = undefined
                        }
                    }
                }
            }

            // #{pane_active} restores per-window active pane state on
            // (re)connect — this is window-level state, independent of the
            // session-level active window. #{q:pane_title} is retained so the
            // pane context menu can edit and display the tmux pane title.
            const paneResult = await this.gateway.sendCommand(
                'list-panes -s -F "#{pane_id} #{window_id} #{pane_active} #{q:pane_title}"',
                TMUX_COMMAND_TOLERATE_ERRORS,
            )
            const paneLines = paneResult
                .split(/[\r\n]+/)
                .map((l) => l.trim())
                .filter((l) => l)
            this.log.info(`Found ${paneLines.length} pane(s) from list-panes`)

            const newPaneIds: Array<{ paneId: number; windowId: number }> = []
            for (const line of paneLines) {
                const match = line.match(/^%?(\d+)\s+@?(\d+)\s+([01])(?:\s+((?:[^\\ ]|\\.)+))?$/)
                if (match) {
                    const paneId = parseInt(match[1])
                    const windowId = parseInt(match[2])
                    const paneTitle = match[4] ? unescapeTmuxValue(match[4]) : ''
                    this.updatePaneTitle(paneId, windowId, paneTitle)
                    if (match[3] === '1') {
                        this.windowActivePanes.set(windowId, paneId)
                    }

                    let windowState = this.windowStates.get(windowId)
                    if (!windowState) {
                        windowState = {
                            id: windowId,
                            name: '',
                            panes: new Set(),
                        }
                        this.windowStates.set(windowId, windowState)
                        this.events.next({
                            type: 'window-add',
                            windowId,
                            data: { deferSwitch: true },
                        })
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
                        this.paneTitles.delete(paneId)
                        this.windowStates.get(windowId)?.panes.delete(paneId)
                        if (this.windowActivePanes.get(windowId) === paneId) {
                            this.windowActivePanes.delete(windowId)
                        }
                    }
                    return
                }
            }

            // Captured windows were published progressively. Refresh layouts
            // of existing windows too, without duplicating the capture events.
            // Emit layout-change for all discovered windows so the UI
            // can build the SplitContainer tree. Without this, syncLayout()
            // never runs and panes remain registered but unmounted.
            for (const windowState of this.windowStates.values()) {
                if (
                    windowState.layout &&
                    !newPaneIds.some((pane) => pane.windowId === windowState.id)
                ) {
                    this.events.next({
                        type: 'layout-change',
                        windowId: windowState.id,
                        data: { layout: windowState.layout },
                    })
                }
            }

            // Hostname is server-level metadata. Query it after window/pane
            // discovery so the session tab can render its dynamic title as
            // soon as both parts of the title are available.
            await this.refreshHostName()
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
                this.paneTitles.delete(paneId)
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
            if (this.hasClientSizePushed) {
                await this.discoverPaneTitles(
                    windowId,
                    new Set(newPaneIds.map(({ paneId }) => paneId)),
                )
            }
            const captured = await this.capturePaneSnapshots(newPaneIds, false)
            if (!captured) {
                // Client size not pushed yet (out-of-order %layout-change before
                // the first refresh-client). Roll back so a later discover
                // (after the size push) re-discovers and captures these panes;
                // otherwise pane-add would be emitted without snapshots and the
                // history would never be restored.
                this.log.warn('Rolling back layout discovery: retrying after client size is pushed')
                for (const { paneId, windowId: wid } of newPaneIds) {
                    this.knownPanes.delete(paneId)
                    this.paneTitles.delete(paneId)
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

    private updatePaneTitle(
        paneId: number,
        windowId: number | undefined,
        paneTitle: string,
        emitWhenUnknown = false,
    ): void {
        const previousPaneTitle = this.paneTitles.get(paneId)
        this.paneTitles.set(paneId, paneTitle)
        if (
            (previousPaneTitle !== undefined && previousPaneTitle !== paneTitle) ||
            (emitWhenUnknown && previousPaneTitle === undefined)
        ) {
            this.events.next({
                type: 'pane-renamed',
                paneId,
                windowId,
                data: { name: paneTitle },
            })
        }
    }

    /**
     * Load titles for panes discovered from a layout change.
     *
     * Batch discovery already gets pane titles from list-panes -s. Runtime
     * layout discovery only has pane IDs, so query the affected window before
     * emitting pane-add; this keeps window-bar metadata complete for splits.
     */
    private async discoverPaneTitles(windowId: number, paneIds: Set<number>): Promise<void> {
        if (paneIds.size === 0) return

        try {
            const result = await this.gateway.sendCommand(
                `list-panes -t @${windowId} -F "#{pane_id} #{q:pane_title}"`,
                TMUX_COMMAND_TOLERATE_ERRORS,
            )
            const lines = result
                .split(/[\r\n]+/)
                .map((line) => line.trim())
                .filter((line) => line)

            for (const line of lines) {
                const match = line.match(/^%?(\d+)(?:\s+((?:[^\\ ]|\\.)+))?$/)
                if (!match) continue

                const paneId = parseInt(match[1])
                const paneTitle = match[2] ? unescapeTmuxValue(match[2]) : ''
                if (paneIds.has(paneId)) {
                    this.updatePaneTitle(paneId, windowId, paneTitle)
                }
            }
        } catch (e) {
            this.log.warn(`Failed to discover pane titles for window @${windowId}:`, e)
        }
    }

    /**
     * Capture history + state for an array of panes.
     * Shared by discoverWindowsAndPanes() and discoverPanesFromLayout().
     */
    private async capturePaneSnapshots(
        paneIds: Array<{ paneId: number; windowId: number }>,
        publishLayouts = true,
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

        // One history transfer at a time bounds queued bytes and command timers.
        // Recover the visible window first, and publish it before background windows.
        const windows = new Map<number, number[]>()
        for (const { paneId, windowId } of paneIds) {
            if (!windows.has(windowId)) windows.set(windowId, [])
            windows.get(windowId).push(paneId)
        }
        const ordered = [...windows].sort(
            ([a], [b]) => Number(b === this.activeWindowId) - Number(a === this.activeWindowId),
        )
        for (const [windowId, panes] of ordered) {
            for (const paneId of panes) {
                if (this.destroyed) return false
                const snapshot = await this.captureSnapshotForPane(paneId)
                if (this.destroyed) return false
                if (snapshot) this.pendingSnapshots.set(paneId, snapshot)
                else this.failedSnapshots.add(paneId)
            }
            // Do not expose a partial split layout: syncLayout would create the
            // remaining tabs before their snapshots were captured.
            for (const paneId of panes) {
                this.events.next({ type: 'pane-add', paneId, windowId })
            }
            const window = this.windowStates.get(windowId)
            if (publishLayouts && window?.layout) {
                this.events.next({
                    type: 'layout-change',
                    windowId,
                    data: {
                        layout: window.layout,
                        visibleLayout: window.visibleLayout,
                        zoomed: window.zoomedPaneId !== undefined,
                    },
                })
            }
        }
        return true
    }

    /** Capture scrollback and both screens, rejecting mixed-mode/size snapshots. */
    private async captureSnapshotForPane(paneId: number): Promise<PaneSnapshot | null> {
        const existing = this.snapshotCaptures.get(paneId)
        if (existing) return existing
        const capturing = this.snapshotQueue
            .then(() => (this.destroyed ? null : this.runCaptureSnapshotForPane(paneId)))
            .finally(() => this.snapshotCaptures.delete(paneId))
        this.snapshotCaptures.set(paneId, capturing)
        this.snapshotQueue = capturing.then(
            () => undefined,
            () => undefined,
        )
        return capturing
    }

    private async runCaptureSnapshotForPane(paneId: number): Promise<PaneSnapshot | null> {
        const historyLimit = normalizeHistoryRestoreLimit(
            this.configService?.store.tmuxPlugin?.historyRestoreLimit,
        )
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
            'mouse_sgr_flag=#{mouse_sgr_flag}',
            'origin_flag=#{origin_flag}',
            'pane_width=#{pane_width}',
            'pane_height=#{pane_height}',
            'history_size=#{history_size}',
        ].join('\t')
        const stateCommand = `list-panes -t %${paneId} -F "${stateFormat}"`
        const parseState = (response: string) => {
            const state = parsePaneState(response, paneId)
            if (
                state.paneId !== paneId ||
                !Number.isInteger(state.columns) ||
                state.columns <= 0 ||
                !Number.isInteger(state.rows) ||
                state.rows <= 0 ||
                !Number.isInteger(state.historySize) ||
                state.historySize < 0
            ) {
                throw new Error(`Invalid snapshot state for pane %${paneId}`)
            }
            return state
        }

        let failure: unknown
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const state = parseState(await this.gateway.sendCommand(stateCommand))
                if (this.destroyed) return null
                let outputSequence = this.paneOutputSequences.get(paneId) ?? 0
                const markFrameBoundary = () => {
                    outputSequence = this.paneOutputSequences.get(paneId) ?? 0
                }
                // -E-1 with no history clamps to visible row 0. Skip it when
                // history_size is zero or the first screen row is duplicated.
                const commands: TmuxCommand[] = []
                const captureHistory = state.historySize > 0 && historyLimit > 0
                if (captureHistory) {
                    commands.push(
                        { command: `capture-pane -peJN -S-${historyLimit} -E-1 -t %${paneId}` },
                        // Only the two physical rows around the boundary are
                        // needed to detect a soft wrap; never read all history twice.
                        { command: `capture-pane -peJN -S-1 -E0 -t %${paneId}` },
                    )
                }
                commands.push({
                    command: `capture-pane -peJN ${state.alternateOn ? '-a ' : ''}-S0 -t %${paneId}`,
                    onSuccess: state.alternateOn ? undefined : markFrameBoundary,
                })
                if (state.alternateOn)
                    commands.push({
                        command: `capture-pane -peN -S0 -t %${paneId}`,
                        onSuccess: markFrameBoundary,
                    })
                commands.push({ command: stateCommand })
                const responses = await this.gateway.sendCommands(commands)
                const scrollback = captureHistory ? responses.shift() : null
                const boundary = captureHistory ? responses.shift() : ''
                const normalScreen = responses.shift()
                const alternateScreen = state.alternateOn ? responses.shift() : null
                const after = parseState(responses.shift())
                if (
                    state.columns !== after.columns ||
                    state.rows !== after.rows ||
                    state.alternateOn !== after.alternateOn ||
                    (historyLimit > 0 && (state.historySize === 0) !== (after.historySize === 0))
                ) {
                    failure = new Error(`Pane %${paneId} changed size or screen while capturing`)
                    continue
                }
                return {
                    scrollback,
                    normalScreen,
                    alternateScreen,
                    historyJoinsScreen: captureHistory && !boundary.includes('\n'),
                    state: after,
                    outputSequence,
                }
            } catch (error) {
                if (this.destroyed) return null
                failure = error
                // A timeout does not cancel tmux's queued work. Retrying the
                // same large captures only adds more data behind that backlog.
                break
            }
        }
        this.logger.warn(`Failed to capture snapshot for pane %${paneId}:`, failure)
        return null
    }

    /**
     * Whether a pre-loaded snapshot is waiting to be restored.
     * False once restorePaneHistory consumed it, or when the capture failed.
     */
    hasPendingSnapshot(paneId: number): boolean {
        return this.pendingSnapshots.has(paneId)
    }

    /**
     * Capture a snapshot for a pane whose pre-loaded one is no longer
     * available (already consumed by an earlier mount of the same pane tab,
     * dropped with a destroyed session, or a failed capture).
     *
     * Without this, restorePaneHistory() has nothing to write and the pane
     * stays blank until its next output. Called from TmuxPaneSession.start()
     * BEFORE the tmux grid is marked applied, so live output received during
     * the capture stays queued and is flushed after the history (see
     * TmuxPaneSession.start).
     *
     * Returns whether a snapshot is now pending for the pane — false when the
     * capture failed (the pane is probably gone), in which case the buffered
     * output must NOT be treated as snapshot-covered.
     */
    async ensurePaneSnapshot(paneId: number, force = false): Promise<boolean> {
        if (this.destroyed) return false
        if (!force && this.failedSnapshots.delete(paneId)) return false
        if (!force && this.pendingSnapshots.has(paneId)) {
            return true
        }
        if (force) this.pendingSnapshots.delete(paneId)
        const session = this.paneSessions.get(paneId)

        const snapshot = await this.captureSnapshotForPane(paneId)
        if (this.destroyed) return false
        if (session && this.paneSessions.get(paneId) !== session) return false
        if (!snapshot) {
            this.log.warn(`No snapshot available for pane %${paneId} at restore time`)
            return false
        }
        this.pendingSnapshots.set(paneId, snapshot)
        this.log.info(`Captured a fresh snapshot for pane %${paneId} at restore time`)
        return true
    }

    // --- Pane Management ---

    registerPane(paneId: number, session: TmuxPaneSession): void {
        this.paneSessions.set(paneId, session)
        this.knownPanes.add(paneId)

        const buffered = this.pendingPaneOutput.get(paneId)
        if (!buffered) {
            return
        }
        this.pendingPaneOutput.delete(paneId)

        // Defer filtering until start() knows the active-frame boundary.
        // Empty frames also cover earlier output (for example a cleared TUI).
        for (const { data, sequence } of buffered) {
            session.feedOutput(data, sequence)
        }
    }

    /**
     * Drop all controller-side state for a pane.
     *
     * The snapshot is deliberately dropped too: it describes the pane as of
     * its capture, and reusing it for a later mount would render a stale screen
     * (the whole point of PaneSnapshot.outputSequence). TmuxPaneSession.start()
     * captures a fresh snapshot through ensurePaneSnapshot() when the pane is
     * mounted again, so the re-mounted pane shows its CURRENT content.
     */
    unregisterPane(paneId: number): void {
        this.paneSessions.delete(paneId)
        this.pendingPaneOutput.delete(paneId)
        this.pendingSnapshots.delete(paneId)
        this.failedSnapshots.delete(paneId)
    }

    /**
     * Whether the pane still has a live session in this controller.
     * False once unregisterPane ran (e.g. after a %pane-close notification or
     * controller.destroy).
     */
    isPaneTracked(paneId: number): boolean {
        return this.paneSessions.has(paneId)
    }

    /** Return the tmux pane title, or an empty string when it is unset/unknown. */
    getPaneTitle(paneId: number): string {
        return this.paneTitles.get(paneId) ?? ''
    }

    /** Rename a pane using tmux's pane title. */
    async renamePane(paneId: number, name: string): Promise<void> {
        const normalized = normalizeRename(name)
        if (!normalized) return

        await this.gateway.sendCommand(
            `select-pane -t %${paneId} -T ${quoteTmuxArgument(normalized)}`,
            TMUX_COMMAND_TOLERATE_ERRORS,
        )
        this.updatePaneTitle(paneId, undefined, normalized, true)
    }

    resizePane(_paneId: number, columns: number, rows: number): void {
        // Use refresh-client -C to set client size
        // This affects all panes uniformly in non-variable-size mode
        // Note: paneId is ignored as tmux control mode uses uniform size
        this.gateway
            .sendCommand(`refresh-client -C ${columns},${rows}`, TMUX_COMMAND_TOLERATE_ERRORS)
            .catch((e) => this.logger.warn('Resize failed:', e))
    }

    writeToPane(paneId: number, data: Buffer): void {
        this.log.info(`Writing ${data.length} bytes to pane %${paneId}: <${data.toString('hex')}>`)
        this.gateway.sendKeys(data, paneId)
    }

    /** Restore both buffers before replaying output newer than the frame. */
    async restorePaneHistory(paneId: number): Promise<number | undefined> {
        const snapshot = this.pendingSnapshots.get(paneId)
        if (!snapshot) {
            this.logger.warn(`No pre-loaded snapshot for pane %${paneId}, skipping`)
            return undefined
        }
        this.pendingSnapshots.delete(paneId)
        const session = this.paneSessions.get(paneId)
        if (!session) return undefined
        session.feedSnapshot(Buffer.from(buildSnapshotRestore(snapshot), 'utf-8'))
        return snapshot.outputSequence
    }

    /** Kill a pane for an explicit user close action. Never call from destroy(). */
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

    /**
     * Split the window at `paneId` in the given direction (re-routed from the
     * Tabby native split-* hotkeys). tmux broadcasts %layout-change, which the
     * controller turns into pane-add + layout-change events.
     */
    async splitWindow(paneId: number, dir: SplitDirection): Promise<void> {
        await this.gateway.sendCommand(
            `split-window ${splitWindowFlags(dir)} -t %${paneId}`,
            TMUX_COMMAND_TOLERATE_ERRORS,
        )
    }

    /**
     * Select the nearest pane in the given direction (re-routed from the Tabby
     * native pane-nav-* hotkeys). tmux replies with %window-pane-changed, which
     * drives the UI focus — tmux stays the authority.
     */
    async selectPaneByDirection(paneId: number, dir: SplitDirection): Promise<void> {
        await this.gateway.sendCommand(
            `select-pane ${selectPaneFlag(dir)} -t %${paneId}`,
            TMUX_COMMAND_TOLERATE_ERRORS,
        )
    }

    /** Select a specific pane by ID (used by linear / numbered pane navigation). */
    async selectPaneById(paneId: number): Promise<void> {
        await this.gateway.sendCommand(`select-pane -t %${paneId}`, TMUX_COMMAND_TOLERATE_ERRORS)
    }

    /**
     * Resize the pane at `paneId` by `amount` cells in the direction implied by
     * the Tabby resizePane action (re-routed from pane-increase/decrease-*).
     * The step defaults to Tabby's terminal.paneResizeStep so the resize
     * granularity matches the user's native pane resize setting.
     */
    async resizePaneByDirection(
        paneId: number,
        action: ResizeDirection,
        amount?: number,
    ): Promise<void> {
        const step = amount ?? this.configService?.store?.terminal?.paneResizeStep ?? 1
        await this.gateway.sendCommand(
            `resize-pane ${resizePaneFlag(action)} ${step} -t %${paneId}`,
            TMUX_COMMAND_TOLERATE_ERRORS,
        )
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

    /** Rename a window through tmux; the %window-renamed notification updates state. */
    async renameWindow(windowId: number, name: string): Promise<void> {
        const normalized = normalizeRename(name)
        if (!normalized) return

        await this.gateway.sendCommand(
            `rename-window -t @${windowId} ${quoteTmuxArgument(normalized)}`,
            TMUX_COMMAND_TOLERATE_ERRORS,
        )
    }

    /** Kill a window for an explicit user close action. Never call from destroy(). */
    async killWindow(windowId: number): Promise<void> {
        await this.gateway.sendCommand(`kill-window -t @${windowId}`, TMUX_COMMAND_TOLERATE_ERRORS)
    }

    // --- Session Operations ---

    async detach(): Promise<void> {
        this.gateway.detach()
    }

    // --- Lifecycle ---

    async destroy(): Promise<void> {
        this.destroyed = true
        this.gateway.dispose()
        this.pendingSnapshots.clear()
        this.failedSnapshots.clear()
        // Close all pane sessions locally. Pane destruction must never issue
        // kill-pane; only an explicit user close action may do that.
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

    /**
     * Query and cache the hostname of the machine running the tmux server.
     *
     * The value is server-level, so it is queried once per controller rather
     * than once per window or pane change. Failed or empty responses keep the
     * previous value so the UI can continue using its fallback title.
     */
    async refreshHostName(): Promise<void> {
        if (this.hostName) return
        if (this.hostRefreshPromise) return this.hostRefreshPromise

        const refresh = (async () => {
            try {
                const result = await this.gateway.sendCommand('display-message -p "#{host}"')
                const hostName = result
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .find((line) => line.length > 0)

                if (!hostName || hostName === this.hostName) return

                this.hostName = hostName
                this.events.next({ type: 'host-changed', data: { hostName } })
            } catch (e) {
                this.logger.warn('Failed to discover tmux server hostname:', e)
            }
        })()

        this.hostRefreshPromise = refresh
        try {
            await refresh
        } finally {
            if (this.hostRefreshPromise === refresh) {
                this.hostRefreshPromise = null
            }
        }
    }

    getHostName(): string {
        return this.hostName
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

    /**
     * Whether the given pane is currently zoomed (fills its entire window).
     * Looks up the window owning the pane and compares its zoomedPaneId;
     * unknown panes report false.
     */
    isPaneZoomed(paneId: number): boolean {
        for (const state of this.windowStates.values()) {
            if (state.panes.has(paneId)) {
                return state.zoomedPaneId === paneId
            }
        }
        return false
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
