import { Injectable } from '@angular/core'
import { TabContextMenuItemProvider, MenuItemOptions, BaseTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { TmuxService } from './services/tmux.service'
import { TmuxSessionTabComponent } from './components/tmuxSessionTab.component'
import { TmuxPaneTabComponent } from './components/tmuxPaneTab.component'

/**
 * TmuxContextMenuProvider - Adds tmux-related items to tab context menu.
 *
 * - On a terminal tab: "Enter Tmux Mode"
 * - On a TmuxSessionTab / TmuxPaneTab: "Exit Tmux Mode" + Split + Close pane
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
        // On a TmuxSessionTab: show exit option
        if (tab instanceof TmuxSessionTabComponent) {
            return [
                {
                    label: 'Exit Tmux Mode',
                    click: async () => {
                        await this.tmuxService.disconnect()
                    },
                },
            ]
        }

        // On a TmuxPaneTab: show exit, split, and close pane
        if (tab instanceof TmuxPaneTabComponent) {
            const items: MenuItemOptions[] = [
                {
                    label: 'Exit Tmux Mode',
                    click: async () => {
                        await this.tmuxService.disconnect()
                    },
                },
                {
                    label: 'Split',
                    submenu: [
                        { label: 'Right', click: () => this.splitPane(tab, 'right') },
                        { label: 'Down', click: () => this.splitPane(tab, 'down') },
                        { label: 'Left', click: () => this.splitPane(tab, 'left') },
                        { label: 'Up', click: () => this.splitPane(tab, 'up') },
                    ] as MenuItemOptions[],
                },
                {
                    label: 'Close',
                    click: () => this.closePane(tab),
                },
            ]
            return items
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

    private async splitPane(paneTab: TmuxPaneTabComponent, direction: 'right' | 'down' | 'left' | 'up'): Promise<void> {
        const controller = paneTab.controller
        if (!controller) return

        const paneId = paneTab.paneId
        const flagMap: Record<string, string> = {
            'right': '-h',
            'down': '-v',
            'left': '-h -b',
            'up': '-v -b',
        }
        const flag = flagMap[direction]
        await controller.gateway.sendCommand(
            `split-window ${flag} -t %${paneId}`
        )
        // Discover the new pane and trigger layout update
        await controller.refreshPanes()
    }

    private async closePane(paneTab: TmuxPaneTabComponent): Promise<void> {
        const controller = paneTab.controller
        if (!controller) return
        await controller.killPane(paneTab.paneId)
    }
}

