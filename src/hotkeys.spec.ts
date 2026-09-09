import { Subject } from 'rxjs'
import { describe, expect, it, vi } from 'vitest'
import { translateTmux, TmuxTranslationKey } from './i18n'
import type { TmuxI18nService } from './services/tmuxI18n.service'
import { TmuxHotkeyProvider } from './hotkeys'

vi.mock('tabby-core', () => ({
    ConfigService: class {},
    HotkeyProvider: class {},
    LocaleService: class {},
    TranslateService: class {},
}))

describe('TmuxHotkeyProvider', () => {
    it('updates an existing hotkey list when Tabby language changes', async () => {
        const languageChanges = new Subject<'en' | 'zh'>()
        let locale: 'en' | 'zh' = 'en'
        const i18n = {
            languageChange$: languageChanges,
            t: (key: TmuxTranslationKey, params?: Record<string, string | number>) =>
                translateTmux(locale, key, params),
        }
        const provider = new TmuxHotkeyProvider(i18n as unknown as TmuxI18nService)
        const hotkeys = await provider.provide()

        expect(hotkeys[0].name).toBe('Tmux: Previous window')
        locale = 'zh'
        languageChanges.next('zh')

        expect(hotkeys[0].name).toBe('Tmux：上一个 window')
    })
})
