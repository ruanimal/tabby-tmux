import { Injectable } from '@angular/core'
import { CommandProvider, Command, CommandLocation } from 'tabby-core'
import { TmuxService } from './services/tmux.service'

/** @hidden */
@Injectable()
export class TmuxCommandProvider extends CommandProvider {
    constructor(
        private tmuxService: TmuxService,
    ) {
        super()
    }

    async provide(): Promise<Command[]> {
        return [
            {
                id: 'tmux:open-manager',
                label: 'Tmux',
                icon: require('./icons/tmux.svg'),
                // Only show in LeftToolbar, NOT in StartPage
                locations: [CommandLocation.LeftToolbar],
                weight: -1,
                run: async () => this.tmuxService.showTmuxManager(),
            },
        ]
    }
}
