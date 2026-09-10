import { ChangeDetectorRef, Component, OnDestroy } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { Subscription } from 'rxjs'
import { TmuxI18nService } from '../services/tmuxI18n.service'
import { TmuxConfigChangeService } from '../services/tmuxConfigChange.service'
import { copyTextToClipboard } from '../clipboard'

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
                        (ngModelChange)="saveConfig()"
                    />
                </div>
                <div class="row">
                    <div class="header">
                        <div class="title">{{ i18n.t('settings.sessionTitleFormat') }}</div>
                    </div>
                    <input
                        class="form-control"
                        type="text"
                        [(ngModel)]="config.store.tmuxPlugin.sessionTitleFormat"
                        (ngModelChange)="saveConfig()"
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
                        (ngModelChange)="saveConfig()"
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
                        (ngModelChange)="saveConfig()"
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
                        (ngModelChange)="saveConfig()"
                    />
                </div>
                <div class="row">
                    <div class="header">
                        <div class="title">{{ i18n.t('settings.debugLogging') }}</div>
                    </div>
                    <input
                        type="checkbox"
                        [(ngModel)]="config.store.tmuxPlugin.debugLogging"
                        (ngModelChange)="saveConfig()"
                    />
                </div>
                <div class="row">
                    <div class="header">
                        <div class="title">{{ i18n.t('settings.showCloseButton') }}</div>
                    </div>
                    <input
                        type="checkbox"
                        [(ngModel)]="config.store.tmuxPlugin.showWindowCloseButton"
                        (ngModelChange)="saveConfig()"
                    />
                </div>
            </div>
            <div class="format-help" role="note">
                <div class="format-help-header">
                    <div class="format-help-title">
                        <span class="format-help-icon" aria-hidden="true">?</span>
                        <span>{{ i18n.t('settings.sessionTitleFormatHelp') }}</span>
                    </div>
                    <button
                        type="button"
                        class="format-help-copy"
                        (click)="copySessionTitleFormatVariables()"
                    >
                        {{
                            helpCopied
                                ? i18n.t('settings.sessionTitleFormatCopied')
                                : i18n.t('settings.copySessionTitleFormat')
                        }}
                    </button>
                </div>
                <code class="format-help-variables">
                    {{ i18n.t('settings.sessionTitleFormatVariables') }}
                </code>
            </div>
        </div>
    `,
    styles: [require('./settings.component.scss')],
})
export class TmuxSettingsTabComponent implements OnDestroy {
    private languageSubscription: Subscription
    private copyResetTimer: ReturnType<typeof setTimeout> | null = null
    helpCopied = false

    constructor(
        public config: ConfigService,
        public i18n: TmuxI18nService,
        private cdr: ChangeDetectorRef,
        private configChanges: TmuxConfigChangeService,
    ) {
        this.languageSubscription = this.i18n.languageChange$.subscribe(() =>
            this.cdr.detectChanges(),
        )
    }

    saveConfig(): void {
        this.config.save()
        this.configChanges.notifyChanged()
    }

    async copySessionTitleFormatVariables(): Promise<void> {
        const text = this.i18n.t('settings.sessionTitleFormatVariables')

        try {
            await copyTextToClipboard(text)
            this.helpCopied = true
            this.cdr.detectChanges()

            if (this.copyResetTimer) {
                clearTimeout(this.copyResetTimer)
            }
            this.copyResetTimer = setTimeout(() => {
                this.helpCopied = false
                this.copyResetTimer = null
                this.cdr.detectChanges()
            }, 2000)
        } catch {
            this.helpCopied = false
        }
    }

    ngOnDestroy(): void {
        if (this.copyResetTimer) {
            clearTimeout(this.copyResetTimer)
            this.copyResetTimer = null
        }
        this.languageSubscription.unsubscribe()
    }
}
