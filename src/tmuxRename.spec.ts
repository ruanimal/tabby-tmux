import { describe, expect, it, vi } from 'vitest'
import {
    getTmuxWindowRenameTarget,
    normalizeRename,
    quoteTmuxArgument,
    unescapeTmuxValue,
} from './tmuxRename'

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

    it('resolves the window owned by a pane for rename actions', () => {
        const controller = {
            getWindowIdForPane: vi.fn().mockReturnValue(7),
            getWindowState: vi.fn().mockReturnValue({ name: 'editor' }),
        }

        expect(getTmuxWindowRenameTarget(controller, 12)).toEqual({ id: 7, name: 'editor' })
        expect(controller.getWindowIdForPane).toHaveBeenCalledWith(12)
        expect(controller.getWindowState).toHaveBeenCalledWith(7)
    })

    it('returns no rename target for an unknown pane or window', () => {
        const unknownPaneController = {
            getWindowIdForPane: vi.fn().mockReturnValue(null),
            getWindowState: vi.fn(),
        }
        expect(getTmuxWindowRenameTarget(unknownPaneController, 12)).toBeNull()
        expect(unknownPaneController.getWindowState).not.toHaveBeenCalled()

        const unknownWindowController = {
            getWindowIdForPane: vi.fn().mockReturnValue(7),
            getWindowState: vi.fn().mockReturnValue(undefined),
        }
        expect(getTmuxWindowRenameTarget(unknownWindowController, 12)).toBeNull()
    })
})
