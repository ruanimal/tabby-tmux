import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flattenLayout, parseTmuxLayout, TmuxLayoutNode, TmuxPane } from './layoutParser'

describe('parseTmuxLayout', () => {
    // parseTmuxLayout logs the parse failure via console.error on purpose;
    // silence it so expected malformed-input cases don't pollute test output.
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
        consoleErrorSpy.mockRestore()
    })

    it('returns null for empty input', () => {
        expect(parseTmuxLayout('')).toBeNull()
        expect(parseTmuxLayout(undefined as unknown as string)).toBeNull()
    })

    it('parses a simple pane without checksum', () => {
        const node = parseTmuxLayout('93x52,0,0,185')
        expect(node).toEqual({
            type: 'pane',
            x: 0,
            y: 0,
            width: 93,
            height: 52,
            paneId: 185,
        })
    })

    it('strips a leading checksum', () => {
        const node = parseTmuxLayout('41e9,93x52,0,0,185')
        expect(node).toEqual({
            type: 'pane',
            x: 0,
            y: 0,
            width: 93,
            height: 52,
            paneId: 185,
        })
    })

    it('parses a vertical split [...] of panes stacked top-to-bottom', () => {
        const node = parseTmuxLayout('41e9,279x71,0,0[279x40,0,0,71,279x30,0,41,72]')
        expect(node).toEqual({
            type: 'vertical',
            x: 0,
            y: 0,
            width: 279,
            height: 71,
            children: [
                { type: 'pane', x: 0, y: 0, width: 279, height: 40, paneId: 71 },
                { type: 'pane', x: 0, y: 41, width: 279, height: 30, paneId: 72 },
            ],
        })
    })

    it('parses a horizontal split {...} of panes side by side', () => {
        const node = parseTmuxLayout('147x30,0,41{131x30,0,41,72,16x30,132,41,73}')
        expect(node).toEqual({
            type: 'horizontal',
            x: 0,
            y: 41,
            width: 147,
            height: 30,
            children: [
                { type: 'pane', x: 0, y: 41, width: 131, height: 30, paneId: 72 },
                { type: 'pane', x: 132, y: 41, width: 16, height: 30, paneId: 73 },
            ],
        })
    })

    it('parses a nested layout (vertical containing horizontal)', () => {
        const node = parseTmuxLayout(
            '41e9,279x71,0,0[279x40,0,0,71,279x30,0,41{147x30,0,41,72,131x30,148,41,73}]',
        )
        expect(node).not.toBeNull()
        expect(node!.type).toBe('vertical')
        expect(node!.children).toHaveLength(2)
        expect(node!.children![1]).toEqual({
            type: 'horizontal',
            x: 0,
            y: 41,
            width: 279,
            height: 30,
            children: [
                { type: 'pane', x: 0, y: 41, width: 147, height: 30, paneId: 72 },
                { type: 'pane', x: 148, y: 41, width: 131, height: 30, paneId: 73 },
            ],
        })
    })

    it('returns null for malformed input', () => {
        expect(parseTmuxLayout('garbage')).toBeNull()
        expect(parseTmuxLayout('93x52,0,0')).toBeNull()
        expect(parseTmuxLayout('93x52')).toBeNull()
        expect(parseTmuxLayout('93x52,0,0[93x52,0,0,1')).toBeNull()
    })
})

describe('flattenLayout', () => {
    it('returns a single pane for a pane node', () => {
        const node: TmuxLayoutNode = { type: 'pane', x: 0, y: 0, width: 93, height: 52, paneId: 185 }
        expect(flattenLayout(node)).toEqual([{ paneId: 185, x: 0, y: 0, width: 93, height: 52 }])
    })

    it('flattens a nested tree into all panes in order', () => {
        const node = parseTmuxLayout(
            '41e9,279x71,0,0[279x40,0,0,71,279x30,0,41{147x30,0,41,72,131x30,148,41,73}]',
        )!
        const panes = flattenLayout(node)
        expect(panes).toEqual<TmuxPane[]>([
            { paneId: 71, x: 0, y: 0, width: 279, height: 40 },
            { paneId: 72, x: 0, y: 41, width: 147, height: 30 },
            { paneId: 73, x: 148, y: 41, width: 131, height: 30 },
        ])
    })

    it('skips panes without a paneId', () => {
        const node: TmuxLayoutNode = {
            type: 'vertical',
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            children: [
                { type: 'pane', x: 0, y: 0, width: 100, height: 50, paneId: 1 },
                { type: 'pane', x: 0, y: 50, width: 100, height: 50 },
            ],
        }
        expect(flattenLayout(node)).toEqual<TmuxPane[]>([{ paneId: 1, x: 0, y: 0, width: 100, height: 50 }])
    })
})
