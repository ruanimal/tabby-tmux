import { describe, expect, it } from 'vitest'
import { formatTmuxSessionTitle } from './tmuxTitle'

describe('formatTmuxSessionTitle', () => {
    it('combines the active window name and tmux server hostname', () => {
        expect(formatTmuxSessionTitle('Tmux: default', 'zsh', 'pupu-MBP.local')).toBe(
            'zsh - pupu-MBP.local',
        )
    })

    it('keeps the fallback when either dynamic value is unavailable', () => {
        expect(formatTmuxSessionTitle('Tmux: default', '', 'pupu-MBP.local')).toBe('Tmux: default')
        expect(formatTmuxSessionTitle('Tmux: default', 'zsh', '')).toBe('Tmux: default')
        expect(formatTmuxSessionTitle('Tmux: default', undefined, undefined)).toBe('Tmux: default')
    })

    it('trims dynamic values before composing the title', () => {
        expect(formatTmuxSessionTitle('Tmux: default', ' zsh ', ' pupu-MBP.local ')).toBe(
            'zsh - pupu-MBP.local',
        )
    })
})
