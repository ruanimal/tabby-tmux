import { describe, expect, it } from 'vitest'
import { translateTmux } from '../i18n'
import { formatTmuxWindowTooltip } from './tmuxWindowTooltip'

describe('formatTmuxWindowTooltip', () => {
    it('marks the active pane while keeping one compact line per pane', () => {
        const tooltip = formatTmuxWindowTooltip(
            {
                id: 6,
                name: 'aa',
                panes: [
                    { id: 11, title: 'pane1', active: true },
                    { id: 12, title: 'pane2', active: false },
                ],
            },
            (params) => translateTmux('en', 'window.tooltip', params),
        )

        expect(tooltip).toBe('* window@6: aa - pane%11: pane1\n  window@6: aa - pane%12: pane2')
    })

    it('uses placeholders when pane details are unavailable', () => {
        const tooltip = formatTmuxWindowTooltip({ id: 2, name: '', panes: [] }, (params) =>
            translateTmux('zh', 'window.tooltip', params),
        )

        expect(tooltip).toBe('  window@2：— - pane—：—')
    })
})
