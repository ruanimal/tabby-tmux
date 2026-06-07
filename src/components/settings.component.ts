import { Component } from '@angular/core'
import { ConfigService } from 'tabby-core'

// eslint-disable-next-line new-cap
@Component({
    template: `
        <h3>Tmux</h3>
        <div class="tmux-settings-tab">
            <div class="tmux-table">
                <div class="row">
                    <div class="header"><div class="title">Default session name:</div></div>
                    <input class="form-control" type="text"
                        [(ngModel)]="config.store.tmuxPlugin.defaultSessionName"
                        (ngModelChange)="config.save()">
                </div>
                <div class="row">
                    <div class="header"><div class="title">Command timeout (ms):</div></div>
                    <input class="form-control" type="number"
                        [(ngModel)]="config.store.tmuxPlugin.commandTimeoutMs"
                        (ngModelChange)="config.save()">
                </div>
                <div class="row">
                    <div class="header"><div class="title">Send-keys chunk size:</div></div>
                    <input class="form-control" type="number"
                        [(ngModel)]="config.store.tmuxPlugin.sendKeysChunkSize"
                        (ngModelChange)="config.save()">
                </div>
                <div class="row">
                    <div class="header"><div class="title">Resize debounce (ms):</div></div>
                    <input class="form-control" type="number"
                        [(ngModel)]="config.store.tmuxPlugin.resizeDebounceMs"
                        (ngModelChange)="config.save()">
                </div>
            </div>
        </div>
    `,
    styles: [require('./settings.component.scss')],
})
export class TmuxSettingsTabComponent {
    constructor (public config: ConfigService) { }
}
