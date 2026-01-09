import { Injectable } from '@angular/core'
import { TabContextMenuItemProvider, MenuItemOptions, BaseTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { TmuxService } from './services/tmux.service'

/**
 * TmuxContextMenuProvider - Adds "Enter Tmux Mode" to terminal tab context menu
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
        // Only show for terminal tabs (not in tab header context menu)
        if (!(tab instanceof BaseTerminalTabComponent)) {
            return []
        }

        // Don't show if already in tmux mode
        if (this.tmuxService.isConnected) {
            return [
                {
                    label: 'Disconnect from Tmux',
                    click: async () => {
                        await this.tmuxService.disconnect()
                    },
                },
            ]
        }

        return [
            {
                label: 'Enter Tmux Mode',
                click: async () => {
                    await this.tmuxService.attachToTerminal(tab as BaseTerminalTabComponent<any>)
                },
            },
        ]
    }
}

