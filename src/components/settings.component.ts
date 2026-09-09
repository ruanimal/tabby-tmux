import { ChangeDetectorRef, Component, OnDestroy } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { Subscription } from 'rxjs'
import { TmuxI18nService } from '../services/tmuxI18n.service'

// eslint-disable-next-line new-cap
@Component({
    template: `
        <h3>{{ i18n.t('settings.title') }}</h3>
        <div class="tmux-settings-tab">
            <div class="tmux-table">
                <div class="row">
                    <div class="header">
                        <div class="title">{{ i18n.t('settings.defaultSessionName') }}</div>
                    </div>
                    <input
                        class="form-control"
                        type="text"
                        [(ngModel)]="config.store.tmuxPlugin.defaultSessionName"
                        (ngModelChange)="config.save()"
                    />
                </div>
                <div class="row">
                    <div class="header">
                        <div class="title">{{ i18n.t('settings.commandTimeout') }}</div>
                    </div>
                    <input
                        class="form-control"
                        type="number"
                        [(ngModel)]="config.store.tmuxPlugin.commandTimeoutMs"
                        (ngModelChange)="config.save()"
                    />
                </div>
                <div class="row">
                    <div class="header">
                        <div class="title">{{ i18n.t('settings.sendKeysChunkSize') }}</div>
                    </div>
                    <input
                        class="form-control"
                        type="number"
                        [(ngModel)]="config.store.tmuxPlugin.sendKeysChunkSize"
                        (ngModelChange)="config.save()"
                    />
                </div>
                <div class="row">
                    <div class="header">
                        <div class="title">{{ i18n.t('settings.resizeDebounce') }}</div>
                    </div>
                    <input
                        class="form-control"
                        type="number"
                        [(ngModel)]="config.store.tmuxPlugin.resizeDebounceMs"
                        (ngModelChange)="config.save()"
                    />
                </div>
                <div class="row">
                    <div class="header">
                        <div class="title">{{ i18n.t('settings.debugLogging') }}</div>
                    </div>
                    <input
                        type="checkbox"
                        [(ngModel)]="config.store.tmuxPlugin.debugLogging"
                        (ngModelChange)="config.save()"
                    />
                </div>
                <div class="row">
                    <div class="header">
                        <div class="title">{{ i18n.t('settings.showCloseButton') }}</div>
                    </div>
                    <input
                        type="checkbox"
                        [(ngModel)]="config.store.tmuxPlugin.showWindowCloseButton"
                        (ngModelChange)="config.save()"
                    />
                </div>
            </div>
        </div>
    `,
    styles: [require('./settings.component.scss')],
})
export class TmuxSettingsTabComponent implements OnDestroy {
    private languageSubscription: Subscription

    constructor(
        public config: ConfigService,
        public i18n: TmuxI18nService,
        private cdr: ChangeDetectorRef,
    ) {
        this.languageSubscription = this.i18n.languageChange$.subscribe(() =>
            this.cdr.detectChanges(),
        )
    }

    ngOnDestroy(): void {
        this.languageSubscription.unsubscribe()
    }
}
