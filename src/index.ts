import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import TabbyCoreModule, { ProfileProvider } from 'tabby-core'
import { TmuxProfileProvider } from './profiles'
import { TmuxTabComponent } from './components/tmuxTab.component'
import { TmuxPaneTabComponent } from './components/tmuxPaneTab.component'

@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        TabbyCoreModule,
    ],
    providers: [
        { provide: ProfileProvider, useClass: TmuxProfileProvider, multi: true },
    ],
    declarations: [
        TmuxTabComponent,
        TmuxPaneTabComponent,
    ],
    entryComponents: [
        TmuxTabComponent,
        TmuxPaneTabComponent,
    ],
})
export default class TmuxModule { }
