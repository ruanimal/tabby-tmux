import { Injectable } from '@angular/core'
import { ProfileProvider, Profile, NewTabParameters } from 'tabby-core'
import { BaseTabComponent } from 'tabby-core'
import { TmuxSessionTabComponent, TmuxSessionProfile } from './components/tmuxSessionTab.component'

export interface TmuxProfile extends Profile {
    type: 'tmux'
    options: {
        sessionName?: string
    }
}

@Injectable()
export class TmuxProfileProvider extends ProfileProvider<TmuxProfile> {
    id = 'tmux'
    name = 'Tmux'
    supportsQuickConnect = false

    settingsComponent = null

    configDefaults: Partial<TmuxProfile> = {
        type: 'tmux',
        options: {
            sessionName: 'default',
        },
    }

    async getBuiltinProfiles(): Promise<TmuxProfile[]> {
        return [
            {
                id: 'tmux:default',
                type: 'tmux',
                name: 'Tmux (default session)',
                icon: 'fas fa-layer-group',
                options: {
                    sessionName: 'default',
                },
                weight: -1,
                isBuiltin: true,
                isTemplate: false,
                disableDynamicTitle: false,
                behaviorOnSessionEnd: 'keep',
            },
        ]
    }

    async getNewProfileDefaults(): Promise<TmuxProfile> {
        return {
            id: '',
            type: 'tmux',
            name: 'New Tmux Session',
            icon: 'fas fa-layer-group',
            options: {
                sessionName: '',
            },
            weight: -1,
            isBuiltin: false,
            isTemplate: false,
            disableDynamicTitle: false,
            behaviorOnSessionEnd: 'keep',
        }
    }

    async getNewTabParameters(profile: TmuxProfile): Promise<NewTabParameters<BaseTabComponent>> {
        const sessionProfile: TmuxSessionProfile = {
            sessionName: profile.options?.sessionName || 'default',
        }

        return {
            type: TmuxSessionTabComponent,
            inputs: {
                profile: sessionProfile,
            },
        }
    }

    getDescription(profile: TmuxProfile): string {
        return profile.options?.sessionName
            ? `Session: ${profile.options.sessionName}`
            : 'Default session'
    }
}
