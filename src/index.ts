import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import TabbyCoreModule, { CommandProvider, ProfileProvider, TabContextMenuItemProvider } from 'tabby-core'
import { TmuxCommandProvider } from './buttonProvider'
import { TmuxProfileProvider } from './profiles'
import { TmuxContextMenuProvider } from './tabContextMenu'
import { TmuxPaneTabComponent } from './components/tmuxPaneTab.component'
import { TmuxSessionTabComponent } from './components/tmuxSessionTab.component'
import { TmuxWindowBarComponent } from './components/tmuxWindowBar.component'

@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        TabbyCoreModule,
    ],
    providers: [
        { provide: CommandProvider, useClass: TmuxCommandProvider, multi: true },
        { provide: ProfileProvider, useClass: TmuxProfileProvider, multi: true },
        { provide: TabContextMenuItemProvider, useClass: TmuxContextMenuProvider, multi: true },
    ],
    declarations: [
        TmuxPaneTabComponent,
        TmuxSessionTabComponent,
        TmuxWindowBarComponent,
    ],
    entryComponents: [
        TmuxPaneTabComponent,
        TmuxSessionTabComponent,
    ],
})
export default class TmuxModule { }

