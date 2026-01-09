import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import TabbyCoreModule, { CommandProvider } from 'tabby-core'
import { TmuxCommandProvider } from './buttonProvider'
import { TmuxPaneTabComponent } from './components/tmuxPaneTab.component'

@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        TabbyCoreModule,
    ],
    providers: [
        { provide: CommandProvider, useClass: TmuxCommandProvider, multi: true },
    ],
    declarations: [
        TmuxPaneTabComponent,
    ],
    entryComponents: [
        TmuxPaneTabComponent,
    ],
})
export default class TmuxModule { }
