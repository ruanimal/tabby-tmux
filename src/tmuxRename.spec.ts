import { describe, expect, it } from 'vitest'
import { normalizeRename, quoteTmuxArgument, unescapeTmuxValue } from './tmuxRename'

describe('tmux rename helpers', () => {
    it('normalizes whitespace and rejects cancelled or empty names', () => {
        expect(normalizeRename(null)).toBeNull()
        expect(normalizeRename('   ')).toBeNull()
        expect(normalizeRename('  editor\n')).toBe('editor')
        expect(normalizeRename('one\ntwo')).toBe('one two')
    })

    it('quotes tmux names without allowing command syntax to escape', () => {
        expect(quoteTmuxArgument('my "window" $HOME `date` \\')).toBe(
            '"my \\"window\\" \\$HOME \\`date\\` \\\\"',
        )
    })

    it('decodes q:-escaped tmux values', () => {
        expect(unescapeTmuxValue('my\\ window\\!')).toBe('my window!')
        expect(unescapeTmuxValue("''")).toBe('')
    })
})
