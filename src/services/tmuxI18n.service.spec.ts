import { Subject } from 'rxjs'
import { describe, expect, it, vi } from 'vitest'
import type { LocaleService } from 'tabby-core'
import { TmuxI18nService } from './tmuxI18n.service'

vi.mock('tabby-core', () => ({
    LocaleService: class {},
}))

function createLocaleService(currentLocale: string) {
    return {
        currentLocale,
        localeChanged: new Subject<string>(),
        getLocale() {
            return this.currentLocale
        },
        get localeChanged$() {
            return this.localeChanged.asObservable()
        },
    }
}

function createI18nService(currentLocale: string) {
    const localeService = createLocaleService(currentLocale)
    return {
        localeService,
        service: new TmuxI18nService(localeService as unknown as LocaleService),
    }
}

describe('TmuxI18nService', () => {
    it('resolves the initial locale from LocaleService', () => {
        const { service } = createI18nService('zh-CN')

        expect(service.t('mode.enter')).toBe('进入 Tmux 模式')
    })

    it('falls back to English for unrecognized locales', () => {
        const { service } = createI18nService('fr-FR')

        expect(service.t('mode.enter')).toBe('Enter Tmux Mode')
    })

    it('updates translations when Tabby changes language', () => {
        const { service, localeService } = createI18nService('en-US')
        const changes: string[] = []
        service.languageChange$.subscribe((locale) => changes.push(locale))

        localeService.localeChanged.next('zh-CN')

        expect(service.t('mode.disconnect')).toBe('断开连接')
        expect(changes).toEqual(['zh'])
    })

    it('does not emit when the resolved locale is unchanged', () => {
        const { service, localeService } = createI18nService('en-US')
        const changes: string[] = []
        service.languageChange$.subscribe((locale) => changes.push(locale))

        localeService.localeChanged.next('en-GB')

        expect(changes).toEqual([])
    })
})
