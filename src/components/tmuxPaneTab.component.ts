import { Component, Injector, Input } from '@angular/core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { TmuxControllerSession, TmuxPaneSession } from '../session'

@Component({
    selector: 'tmux-pane-tab',
    template: BaseTerminalTabComponent.template,
    styles: BaseTerminalTabComponent.styles,
    animations: BaseTerminalTabComponent.animations,
})
export class TmuxPaneTabComponent extends BaseTerminalTabComponent<any> {
    @Input() controller: TmuxControllerSession
    @Input() paneId: number
    session: TmuxPaneSession

    constructor(injector: Injector) {
        super(injector)
    }

    async initializeSession(): Promise<void> {
        if (!this.controller) {
            throw new Error('Tmux controller not provided to pane tab')
        }
        this.session = new TmuxPaneSession(this.logger, this.controller, this.paneId)
        await this.session.start()
    }
}
