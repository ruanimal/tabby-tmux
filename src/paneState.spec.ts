import { describe, expect, it, vi } from 'vitest'
import { PaneState, applyPaneState, buildModeSequences, parsePaneState } from './paneState'

/** Build a PaneState with sensible defaults, overriding as needed. */
function makeState(overrides: Partial<PaneState> = {}): PaneState {
    return {
        paneId: 5,
        cursorX: 3,
        cursorY: 2,
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
        ...overrides,
    }
}

/** Format a single `list-panes -F` line from a PaneState. */
function formatStateLine(state: PaneState): string {
    const fields = [
        `pane_id=%${state.paneId}`,
        `cursor_x=${state.cursorX}`,
        `cursor_y=${state.cursorY}`,
        `alternate_on=${state.alternateOn ? 1 : 0}`,
        `alternate_saved_x=${state.alternateSavedX}`,
        `alternate_saved_y=${state.alternateSavedY}`,
        `scroll_region_upper=${state.scrollRegionUpper}`,
        `scroll_region_lower=${state.scrollRegionLower}`,
        `pane_tabs=${state.paneTabs.join(',')}`,
        `cursor_flag=${state.cursorFlag ? 1 : 0}`,
        `insert_flag=${state.insertFlag ? 1 : 0}`,
        `keypad_cursor_flag=${state.keypadCursorFlag ? 1 : 0}`,
        `keypad_flag=${state.keypadFlag ? 1 : 0}`,
        `wrap_flag=${state.wrapFlag ? 1 : 0}`,
        `bracket_paste_flag=${state.bracketPasteFlag ? 1 : 0}`,
        `mouse_standard_flag=${state.mouseStandardMode ? 1 : 0}`,
        `mouse_button_flag=${state.mouseButtonMode ? 1 : 0}`,
        `mouse_any_flag=${state.mouseAnyMode ? 1 : 0}`,
        `pane_height=${state.rows ?? 0}`,
    ]
    return fields.join('\t')
}

describe('parsePaneState', () => {
    it('parses a single-line response into a PaneState', () => {
        const state = parsePaneState(formatStateLine(makeState()), 5)
        expect(state).toMatchObject({
            paneId: 5,
            cursorX: 3,
            cursorY: 2,
            wrapFlag: true,
            cursorFlag: true,
        })
    })

    it('picks the line whose pane_id matches the expected pane (multi-line)', () => {
        const other = makeState({ paneId: 1, cursorX: 0, cursorY: 0 })
        const target = makeState({ paneId: 2, cursorX: 10, cursorY: 5, wrapFlag: false })
        // Target pane is NOT the first line — mirrors list-panes returning
        // every pane in the window.
        const response = `${formatStateLine(other)}\n${formatStateLine(target)}`
        const state = parsePaneState(response, 2)
        expect(state.paneId).toBe(2)
        expect(state.cursorX).toBe(10)
        expect(state.cursorY).toBe(5)
        expect(state.wrapFlag).toBe(false)
    })

    it('falls back to the first pane_id line when no exact match exists', () => {
        const state = parsePaneState(formatStateLine(makeState({ paneId: 1 })), 99)
        expect(state.paneId).toBe(1)
    })

    it('returns the default state when the response has no pane_id line', () => {
        const state = parsePaneState('no pane data here', 42)
        expect(state).toMatchObject({
            paneId: 42,
            cursorX: 0,
            cursorY: 0,
            wrapFlag: true,
            cursorFlag: true,
            paneTabs: [],
        })
    })

    it('parses comma-separated pane_tabs and optional pane_height', () => {
        const state = parsePaneState(
            formatStateLine(makeState({ paneId: 5, paneTabs: [8, 16, 24], rows: 40 })),
            5,
        )
        expect(state.paneTabs).toEqual([8, 16, 24])
        expect(state.rows).toBe(40)
    })

    it('parses boolean flags from 0/1 values', () => {
        const state = parsePaneState(
            formatStateLine(
                makeState({
                    paneId: 5,
                    insertFlag: true,
                    bracketPasteFlag: true,
                    keypadCursorFlag: true,
                    mouseStandardMode: true,
                    mouseButtonMode: true,
                    mouseAnyMode: true,
                    alternateOn: true,
                    scrollRegionUpper: 4,
                    scrollRegionLower: 20,
                }),
            ),
            5,
        )
        expect(state.insertFlag).toBe(true)
        expect(state.bracketPasteFlag).toBe(true)
        expect(state.keypadCursorFlag).toBe(true)
        expect(state.mouseStandardMode).toBe(true)
        expect(state.mouseButtonMode).toBe(true)
        expect(state.mouseAnyMode).toBe(true)
        expect(state.alternateOn).toBe(true)
        expect(state.scrollRegionUpper).toBe(4)
        expect(state.scrollRegionLower).toBe(20)
    })
})

describe('buildModeSequences', () => {
    it('emits cursor CUP, scroll region and mode sequences in order', () => {
        const state = makeState({
            scrollRegionUpper: 4,
            scrollRegionLower: 20,
            insertFlag: true,
        })
        const seq = buildModeSequences(state)
        expect(seq).toBe(
            '\x1b[5;21r' + // DECSTBM (upper+1;lower+1)
                '\x1b[3;4H' + // CUP (cursorY+1;cursorX+1)
                '\x1b[?25h' + // DECTCEM on
                '\x1b[4h' + // IRM on
                '\x1b[?1l' + // DECCKM off
                '\x1b>' + // DECKPNM off
                '\x1b[?2004l' + // bracketed paste off
                '\x1b[?7h' + // DECAWM on
                '\x1b[?1000l\x1b[?1002l\x1b[?1003l' + // mouse modes off
                '\x1b[3g' + // TBC 3
                '\x1b[3;4H', // final CUP
        )
    })

    it('emits tab stops as TBC + HTS per column', () => {
        const seq = buildModeSequences(makeState({ paneTabs: [8, 16] }))
        expect(seq).toContain('\x1b[3g')
        expect(seq).toContain('\x1b[9G\x1bH') // col 8 → CUP column 9, HTS
        expect(seq).toContain('\x1b[17G\x1bH') // col 16 → CUP column 17, HTS
    })

    it('emits "on" sequences when flags are set', () => {
        const seq = buildModeSequences(
            makeState({
                cursorFlag: false,
                keypadCursorFlag: true,
                keypadFlag: true,
                bracketPasteFlag: true,
                wrapFlag: false,
                mouseStandardMode: true,
                mouseButtonMode: true,
                mouseAnyMode: true,
            }),
        )
        expect(seq).toContain('\x1b[?25l') // cursor hidden
        expect(seq).toContain('\x1b[?1h') // DECCKM on
        expect(seq).toContain('\x1b=') // DECKPAM on
        expect(seq).toContain('\x1b[?2004h') // bracketed paste on
        expect(seq).toContain('\x1b[?7l') // DECAWM off
        expect(seq).toContain('\x1b[?1000h\x1b[?1002h\x1b[?1003h') // mouse on
    })

    it('skips cursor and tab stop sequences when skipCursor is set', () => {
        const seq = buildModeSequences(makeState({ paneTabs: [8] }), true)
        expect(seq).not.toContain('H') // no CUP sequences
        expect(seq).not.toContain('\x1b[3g') // no TBC
        expect(seq).toContain('\x1b[?25h') // modes still applied
    })
})

describe('applyPaneState', () => {
    it('feeds the built mode sequences to the sink', () => {
        const feedOutput = vi.fn()
        const state = makeState({ scrollRegionUpper: 4, scrollRegionLower: 20 })
        applyPaneState({ feedOutput }, state)
        const expected = buildModeSequences(state)
        expect(feedOutput).toHaveBeenCalledTimes(1)
        const arg = vi.mocked(feedOutput).mock.calls[0][0] as Buffer
        expect(arg.toString('utf-8')).toBe(expected)
    })

    it('forwards skipCursor to the sequence builder', () => {
        const feedOutput = vi.fn()
        const state = makeState({ cursorX: 7, cursorY: 8 })
        applyPaneState({ feedOutput }, state, true)
        const arg = vi.mocked(feedOutput).mock.calls[0][0] as Buffer
        expect(arg.toString('utf-8')).not.toContain('\x1b[9;8H')
    })
})
