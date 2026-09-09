import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'
import { TmuxSettingsTabComponent } from './components/settings.component'
import { TmuxI18nService } from './services/tmuxI18n.service'

// eslint-disable-next-line new-cap
@Injectable()
export class TmuxSettingsTabProvider extends SettingsTabProvider {
    id = 'tmux'
    icon = 'border-all'
    title = ''

    constructor(private i18n: TmuxI18nService) {
        super()
        this.updateTitle()
        this.i18n.languageChange$.subscribe(() => this.updateTitle())
    }

    getComponentType(): any {
        return TmuxSettingsTabComponent
    }

    private updateTitle(): void {
        this.title = this.i18n.t('settings.title')
    }
}
