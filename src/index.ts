import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import TabbyCoreModule, { TabContextMenuItemProvider, ConfigProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { TmuxContextMenuProvider } from './tabContextMenu'
import { TmuxConfigProvider } from './config'
import { TmuxSettingsTabProvider } from './settings'
import { TmuxPaneTabComponent } from './components/tmuxPaneTab.component'
import { TmuxSessionTabComponent } from './components/tmuxSessionTab.component'
import { TmuxWindowBarComponent } from './components/tmuxWindowBar.component'
import { TmuxSettingsTabComponent } from './components/settings.component'

@NgModule({
    imports: [CommonModule, FormsModule, TabbyCoreModule],
    providers: [
        { provide: TabContextMenuItemProvider, useClass: TmuxContextMenuProvider, multi: true },
        { provide: ConfigProvider, useClass: TmuxConfigProvider, multi: true },
        { provide: SettingsTabProvider, useClass: TmuxSettingsTabProvider, multi: true },
    ],
    declarations: [
        TmuxPaneTabComponent,
        TmuxSessionTabComponent,
        TmuxWindowBarComponent,
        TmuxSettingsTabComponent,
    ],
    entryComponents: [TmuxPaneTabComponent, TmuxSessionTabComponent, TmuxSettingsTabComponent],
})
export default class TmuxModule {}
