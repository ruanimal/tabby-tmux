import { describe, expect, it } from 'vitest'
import {
    ResizeDirection,
    SplitDirection,
    resizePaneFlag,
    selectPaneFlag,
    splitWindowFlags,
} from './tmuxKeymap'

describe('splitWindowFlags', () => {
    it.each<[SplitDirection, string]>([
        ['r', '-h'],
        ['b', '-v'],
        ['l', '-h -b'],
        ['t', '-v -b'],
    ])('maps split direction %s → %s', (dir, expected) => {
        expect(splitWindowFlags(dir)).toBe(expected)
    })
})

describe('selectPaneFlag', () => {
    it.each<[SplitDirection, string]>([
        ['l', '-L'],
        ['r', '-R'],
        ['t', '-U'],
        ['b', '-D'],
    ])('maps nav direction %s → %s', (dir, expected) => {
        expect(selectPaneFlag(dir)).toBe(expected)
    })
})

describe('resizePaneFlag', () => {
    it.each<[ResizeDirection, string]>([
        ['v', '-U'],
        ['dv', '-D'],
        ['h', '-L'],
        ['dh', '-R'],
    ])('maps resize action %s → %s', (action, expected) => {
        expect(resizePaneFlag(action)).toBe(expected)
    })
})
