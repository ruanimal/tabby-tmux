import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { APP_INITIALIZER } from '@angular/core'
import TabbyCoreModule, {
    TabContextMenuItemProvider,
    ConfigProvider,
    HotkeyProvider,
} from 'tabby-core'
import TabbyTerminalModule from 'tabby-terminal'
import { SettingsTabProvider } from 'tabby-settings'
import { TmuxContextMenuProvider } from './tabContextMenu'
import { TmuxConfigProvider } from './config'
import { TmuxHotkeyProvider } from './hotkeys'
import { TmuxSettingsTabProvider } from './settings'
import { TmuxService } from './services/tmux.service'
import { TmuxPaneTabComponent } from './components/tmuxPaneTab.component'
import { TmuxSessionTabComponent } from './components/tmuxSessionTab.component'
import { TmuxWindowBarComponent } from './components/tmuxWindowBar.component'
import { TmuxSearchPanelComponent } from './components/tmuxSearchPanel.component'
import { TmuxSettingsTabComponent } from './components/settings.component'

@NgModule({
    imports: [CommonModule, FormsModule, TabbyCoreModule, TabbyTerminalModule],
    providers: [
        {
            // Eagerly instantiate TmuxService so the tmuxPlugin.toggle-tmux-mode
            // hotkey subscription (setupToggleHotkey) exists from startup —
            // the "enter" direction of the toggle fires while NO session tab
            // exists, so it cannot rely on the service being pulled in by a
            // tab/context-menu injection later.
            provide: APP_INITIALIZER,
            useFactory: (tmux: TmuxService) => () => {
                void tmux
            },
            deps: [TmuxService],
            multi: true,
        },
        { provide: TabContextMenuItemProvider, useClass: TmuxContextMenuProvider, multi: true },
        { provide: ConfigProvider, useClass: TmuxConfigProvider, multi: true },
        { provide: HotkeyProvider, useClass: TmuxHotkeyProvider, multi: true },
        { provide: SettingsTabProvider, useClass: TmuxSettingsTabProvider, multi: true },
    ],
    declarations: [
        TmuxPaneTabComponent,
        TmuxSessionTabComponent,
        TmuxWindowBarComponent,
        TmuxSearchPanelComponent,
        TmuxSettingsTabComponent,
    ],
    entryComponents: [TmuxPaneTabComponent, TmuxSessionTabComponent, TmuxSettingsTabComponent],
})
export default class TmuxModule {}
