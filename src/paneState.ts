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
    /** Pane height in rows (from #{pane_height}); used for cursor restore math. */
    rows?: number
}

/**
 * Minimal sink for applying pane state.  Keeps this module free of a
 * dependency on TmuxPaneSession (which lives in session.ts), so the two
 * modules never form a cycle.  TmuxPaneSession satisfies it structurally.
 */
export interface PaneOutputSink {
    feedOutput(data: Buffer): void
}

/**
 * Parse pane state from `list-panes -F` response.
 * Mirrors iTerm2 TmuxStateParser.
 */
export function parsePaneState(response: string, expectedPaneId: number): PaneState {
    const state: PaneState = {
        paneId: expectedPaneId,
        cursorX: 0,
        cursorY: 0,
        alternateOn: false,
        alternateSavedX: 0,
        alternateSavedY: 0,
        scrollRegionUpper: 0,
        scrollRegionLower: 0,
        wrapFlag: true,
        cursorFlag: true,
        insertFlag: false,
        bracketPasteFlag: false,
        keypadCursorFlag: false,
        keypadFlag: false,
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
        targetLine = lines.find((l) => l.includes('pane_id=')) || ''
    }
    if (!targetLine) return state

    for (const part of targetLine.split('\t')) {
        const eqIdx = part.indexOf('=')
        if (eqIdx < 0) continue
        const key = part.substring(0, eqIdx)
        const value = part.substring(eqIdx + 1)
        const n = parseInt(value)
        switch (key) {
            case 'pane_id': {
                // tmux formats pane_id as %<id> (e.g. %19); strip the % so
                // parseInt yields a number instead of NaN.
                const id = parseInt(value.replace(/^%/, ''))
                if (!isNaN(id)) state.paneId = id
                break
            }
            case 'cursor_x':
                state.cursorX = n
                break
            case 'cursor_y':
                state.cursorY = n
                break
            case 'alternate_on':
                state.alternateOn = n === 1
                break
            case 'alternate_saved_x':
                state.alternateSavedX = n
                break
            case 'alternate_saved_y':
                state.alternateSavedY = n
                break
            case 'scroll_region_upper':
                state.scrollRegionUpper = n
                break
            case 'scroll_region_lower':
                state.scrollRegionLower = n
                break
            case 'pane_tabs':
                state.paneTabs = value
                    .split(',')
                    .map(Number)
                    .filter((x) => !isNaN(x))
                break
            case 'cursor_flag':
                state.cursorFlag = n === 1
                break
            case 'insert_flag':
                state.insertFlag = n === 1
                break
            case 'keypad_cursor_flag':
                state.keypadCursorFlag = n === 1
                break
            case 'keypad_flag':
                state.keypadFlag = n === 1
                break
            case 'wrap_flag':
                state.wrapFlag = n === 1
                break
            case 'bracket_paste_flag':
                state.bracketPasteFlag = n === 1
                break
            case 'mouse_standard_flag':
                state.mouseStandardMode = n === 1
                break
            case 'mouse_button_flag':
                state.mouseButtonMode = n === 1
                break
            case 'mouse_any_flag':
                state.mouseAnyMode = n === 1
                break
            case 'pane_height':
                if (!isNaN(n)) state.rows = n
                break
        }
    }
    return state
}

/**
 * Build ANSI escape sequences for terminal mode state (without alternate
 * screen entry).  Used by both applyPaneState and pendingAltRestore.
 */
export function buildModeSequences(state: PaneState, skipCursor = false): string {
    const csi = (s: string) => `\x1b[${s}`
    const esc = (s: string) => `\x1b${s}`
    let seq = ''

    // Set scroll region (DECSTBM)
    if (state.scrollRegionUpper > 0 || state.scrollRegionLower > 0) {
        seq += csi(`${state.scrollRegionUpper + 1};${state.scrollRegionLower + 1}r`)
    }

    // Restore cursor position (CUP) — skipped when the pane was captured
    // before its shell printed anything (primary history empty), so the
    // cursor stays where the streamed %output leaves it.
    if (!skipCursor) {
        seq += csi(`${state.cursorY + 1};${state.cursorX + 1}H`)
    }

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

    // Tab stops (HTS / TBC) — skipped with the cursor setup when
    // skipCursor is set (cursor-moving sequences need the reset CUP).
    if (!skipCursor) {
        // TBC 3 = clear all tab stops, then HTS at each position
        seq += csi('3g')
        for (const col of state.paneTabs) {
            seq += csi(`${col + 1}G`) // CUP to column
            seq += esc('H') // HTS
        }
    }

    // Reset cursor back to final position (tab stop setup moves it) —
    // skipped together with the earlier CUP when skipCursor is set.
    if (!skipCursor) {
        seq += csi(`${state.cursorY + 1};${state.cursorX + 1}H`)
    }

    return seq
}

/**
 * Apply parsed pane state to the terminal via ANSI escape sequences.
 * Mirrors iTerm2 VT100ScreenMutableState.setTmuxState:.
 */
export function applyPaneState(
    session: PaneOutputSink,
    state: PaneState,
    skipCursor = false,
): void {
    // Build a sequence of escape codes to restore terminal state.
    const seq = buildModeSequences(state, skipCursor)
    session.feedOutput(Buffer.from(seq, 'utf-8'))
}
