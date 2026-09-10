import { describe, expect, it } from 'vitest'
import { formatTmuxSessionTitle, formatTmuxTitle } from './tmuxTitle'

describe('formatTmuxTitle', () => {
    const context = {
        sessionName: 'work',
        windowName: 'editor',
        windowId: 7,
        windowIndex: 2,
        paneName: 'shell',
        paneTitle: 'shell',
        paneId: 11,
        hostName: 'pupu-MBP.local',
    }

    it('renders all supported variables and prefixes tmux IDs', () => {
        expect(
            formatTmuxTitle(
                'Tmux: work',
                '#{session_name}: #{window_name} #{window_id}/#{window_index} #{pane_name}/#{pane_title} #{pane_id} #{host}',
                context,
            ),
        ).toBe('work: editor @7/2 shell/shell %11 pupu-MBP.local')
    })

    it('uses the default format when the configured format is empty', () => {
        expect(formatTmuxTitle('Tmux: work', '  ', context)).toBe('editor - pupu-MBP.local')
    })

    it('keeps unknown variables so configuration mistakes remain visible', () => {
        expect(formatTmuxTitle('Tmux: work', '#{window_name} #{unknown}', context)).toBe(
            'editor #{unknown}',
        )
    })

    it('uses the fallback when a known variable used by the format is unavailable', () => {
        expect(
            formatTmuxTitle('Tmux: work', '#{session_name} / #{pane_name}', {
                sessionName: 'work',
            }),
        ).toBe('Tmux: work')
    })

    it('trims values and supports pane_title as the pane_name source', () => {
        expect(
            formatTmuxTitle('Tmux: work', ' #{window_name} / #{pane_name} / #{host} ', {
                windowName: ' editor ',
                paneTitle: ' shell ',
                hostName: ' host ',
            }),
        ).toBe('editor / shell / host')
    })
})

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
