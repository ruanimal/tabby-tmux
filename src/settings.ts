import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'
import { TmuxSettingsTabComponent } from './components/settings.component'

// eslint-disable-next-line new-cap
@Injectable()
export class TmuxSettingsTabProvider extends SettingsTabProvider {
    id = 'tmux'
    icon = 'border-all'
    title = 'Tmux'

    getComponentType (): any {
        return TmuxSettingsTabComponent
    }
}
