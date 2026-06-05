import { Injectable } from '@angular/core'
import { TabContextMenuItemProvider, MenuItemOptions, BaseTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { TmuxService } from './services/tmux.service'
import { TmuxSessionTabComponent } from './components/tmuxSessionTab.component'

/**
 * TmuxContextMenuProvider - Adds tmux-related items to tab context menu.
 *
 * - On a terminal tab: "Enter Tmux Mode" (replaces tab with TmuxSessionTab)
 * - On a TmuxSessionTab: "Disconnect from Tmux" (restores original terminal tab)
 */
@Injectable()
export class TmuxContextMenuProvider extends TabContextMenuItemProvider {
    weight = 5

    constructor(
        private tmuxService: TmuxService,
    ) {
        super()
    }

    async getItems(tab: BaseTabComponent, _tabHeader?: boolean): Promise<MenuItemOptions[]> {
        // On a TmuxSessionTab: show disconnect option
        if (tab instanceof TmuxSessionTabComponent) {
            return [
                {
                    label: 'Disconnect from Tmux',
                    click: async () => {
                        await this.tmuxService.disconnect()
                    },
                },
            ]
        }

        // On a terminal tab: show enter tmux mode option
        if (tab instanceof BaseTerminalTabComponent) {
            return [
                {
                    label: 'Enter Tmux Mode',
                    click: async () => {
                        await this.tmuxService.attachToTerminal(tab as BaseTerminalTabComponent<any>)
                    },
                },
            ]
        }

        return []
    }
}

