import { describe, expect, it, vi } from 'vitest'
import { TmuxRenameDialogComponent } from './tmuxRenameDialog.component'

describe('TmuxRenameDialogComponent', () => {
    it('emits a normalized name on submit', () => {
        const dialog = new TmuxRenameDialogComponent()
        const submit = vi.fn()
        dialog.submitName.subscribe(submit)
        dialog.draft = '  editor\n'

        dialog.submit()

        expect(submit).toHaveBeenCalledWith('editor')
    })

    it('does not submit an empty name', () => {
        const dialog = new TmuxRenameDialogComponent()
        const submit = vi.fn()
        dialog.submitName.subscribe(submit)
        dialog.draft = '  '

        dialog.submit()

        expect(submit).not.toHaveBeenCalled()
    })

    it('emits cancel without using a browser prompt', () => {
        const dialog = new TmuxRenameDialogComponent()
        const cancel = vi.fn()
        dialog.cancel.subscribe(cancel)

        dialog.cancelRename()

        expect(cancel).toHaveBeenCalledOnce()
    })
})
