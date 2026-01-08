import { Injectable } from '@angular/core'
import { ProfileProvider, Profile, NewTabParameters } from 'tabby-core'
import { TmuxTabComponent } from './components/tmuxTab.component'
import { BaseTabComponent } from 'tabby-core'

export interface TmuxProfile extends Profile {
    type: 'tmux'
    options: any
    weight: number
    isBuiltin: boolean
    isTemplate: boolean
    disableDynamicTitle: boolean
    sessionName?: string
}

@Injectable()
export class TmuxProfileProvider extends ProfileProvider<TmuxProfile> {
    id = 'tmux'
    name = 'Tmux'

    settingsComponent = null // TODO: Implement settings component
    configDefaults: Partial<TmuxProfile> = {
        type: 'tmux',
    }

    async getBuiltinProfiles(): Promise<TmuxProfile[]> {
        return [
            {
                id: 'tmux:default',
                type: 'tmux',
                name: 'Tmux',
                icon: 'fas fa-layer-group',
                options: {},
                weight: -1,
                isBuiltin: true,
                isTemplate: false,
                disableDynamicTitle: false,
            },
        ]
    }

    async getNewProfileDefaults(): Promise<TmuxProfile> {
        return {
            id: 'tmux:template',
            type: 'tmux',
            name: 'New Tmux Profile',
            icon: 'fas fa-layer-group',
            options: {},
            weight: -1,
            isBuiltin: false,
            isTemplate: false,
            disableDynamicTitle: false,
        }
    }

    async getNewTabParameters(profile: TmuxProfile): Promise<NewTabParameters<BaseTabComponent>> {
        return {
            type: TmuxTabComponent,
            inputs: {
                profile,
            },
        }
    }

    getDescription(profile: TmuxProfile): string {
        return profile.sessionName ? `Session: ${profile.sessionName}` : 'Default session'
    }
}
