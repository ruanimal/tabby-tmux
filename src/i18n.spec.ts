import { describe, expect, it } from 'vitest'
import { resolveTmuxLocale, translateTmux } from './i18n'

describe('tmux i18n', () => {
    it.each([
        ['zh', 'zh'],
        ['zh-CN', 'zh'],
        ['zh_CN', 'zh'],
        ['zh-Hans', 'zh'],
    ])('recognizes %s as Chinese', (language, expected) => {
        expect(resolveTmuxLocale(language)).toBe(expected)
    })

    it.each(['en', 'en-US', 'ja', 'fr', 'zhx', '', undefined, null])(
        'falls back to English for %s',
        (language) => {
            expect(resolveTmuxLocale(language)).toBe('en')
        },
    )

    it('translates static and interpolated messages', () => {
        expect(translateTmux('en', 'title.pane', { id: 3 })).toBe('Pane %3')
        expect(translateTmux('zh', 'title.pane', { id: 3 })).toBe('pane %3')
        expect(translateTmux('zh', 'window.defaultName', { id: 2 })).toBe('Window 2')
    })

    it('uses the English catalog as the fallback catalog', () => {
        expect(translateTmux('en', 'mode.enter')).toBe('Enter Tmux Mode')
        expect(translateTmux('zh', 'mode.enter')).toBe('进入 Tmux 模式')
    })
})
