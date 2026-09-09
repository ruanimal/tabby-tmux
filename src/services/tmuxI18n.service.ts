import { Injectable } from '@angular/core'
import { LocaleService } from 'tabby-core'
import { Observable, Subject } from 'rxjs'
import { resolveTmuxLocale, translateTmux, TmuxLocale, TmuxTranslationKey } from '../i18n'

/**
 * Tabby 语言的权威源是 LocaleService（tabby-core 对外 export 给插件用）：
 * 它的 setLocale() 只调 translate.setDefaultLang()、从不调 translate.use()，
 * 所以 TranslateService.onLangChange 在 Tabby 里永远不会触发——必须订阅
 * LocaleService.localeChanged$，初始值用 LocaleService.getLocale()。
 */
@Injectable({ providedIn: 'root' })
export class TmuxI18nService {
    private locale: TmuxLocale
    private readonly languageChanges = new Subject<TmuxLocale>()
    readonly languageChange$: Observable<TmuxLocale> = this.languageChanges.asObservable()

    constructor(private localeService: LocaleService) {
        this.locale = resolveTmuxLocale(this.localeService.getLocale())
        this.localeService.localeChanged$.subscribe((language) => {
            this.setLocale(language)
        })
    }

    t(key: TmuxTranslationKey, params: Record<string, string | number> = {}): string {
        return translateTmux(this.locale, key, params)
    }

    private setLocale(language: string): void {
        const nextLocale = resolveTmuxLocale(language)
        if (nextLocale === this.locale) {
            return
        }
        this.locale = nextLocale
        this.languageChanges.next(nextLocale)
    }
}
