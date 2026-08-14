import { Component, Input, Output, EventEmitter, OnDestroy } from '@angular/core'
import { Subject, debounceTime } from 'rxjs'
import { Frontend } from 'tabby-terminal'
import { ConfigService, NotificationsService, TranslateService } from 'tabby-core'

/** Structural copies of tabby-terminal's SearchOptions/SearchState (not exported). */
export interface SearchOptions {
    regex?: boolean
    wholeWord?: boolean
    caseSensitive?: boolean
    incremental?: true
}

export interface SearchState {
    resultIndex?: number
    resultCount: number
}

/**
 * Session-level search panel for the tmux integration.
 *
 * Replaces the built-in per-pane search panel (baseTerminalTab's
 * showSearchPanel / search-panel). In tmux mode every pane keeps
 * `hasFocus = true` simultaneously, which breaks the built-in panel's
 * `*ngIf='showSearchPanel && hasFocus && frontend'` lifecycle: panels linger
 * across pane switches, and the built-in close path calls cancelSearch(),
 * which ends in frontend.focus() and steals DOM keyboard focus.
 *
 * This panel lives once per session (in TmuxSessionTabComponent), searches
 * the active pane's frontend via the side-effect-free findNext()/findPrevious()
 * APIs, and never touches xterm focus itself — closing only clears the search
 * decorations. Its target never changes while open: the session tab closes it
 * on any pane focus switch, mirroring stock Tabby where the search panel
 * disappears when the tab loses focus.
 */
@Component({
    selector: 'tmux-search-panel',
    template: `
        <div
            class="search-panel"
            (mousedown)="$event.stopPropagation()"
            (click)="$event.stopPropagation()"
        >
            <div class="input-group">
                <input
                    class="form-control search-input"
                    type="text"
                    [(ngModel)]="query"
                    (ngModelChange)="onQueryChange()"
                    [class.text-danger]="state.resultCount === 0 && query.length > 0"
                    (keyup.enter)="findPrevious()"
                    (keyup.up)="findPrevious()"
                    (keyup.down)="findNext()"
                    (keyup.esc)="close.emit()"
                    placeholder="Search"
                />
                <div class="input-group-text result-counter" *ngIf="state.resultCount > 0">
                    {{ (state.resultIndex ?? 0) + 1 }} / {{ state.resultCount }}
                </div>
            </div>

            <ng-container *ngIf="state.resultCount > 0">
                <button class="btn btn-link" (click)="findPrevious()" [title]="searchUpLabel">
                    ↑
                </button>
                <button class="btn btn-link" (click)="findNext()" [title]="searchDownLabel">
                    ↓
                </button>
            </ng-container>

            <span class="panel-divider"></span>

            <button
                class="btn"
                [class.btn-link]="!options.caseSensitive"
                [class.btn-info]="options.caseSensitive"
                (click)="options.caseSensitive = !options.caseSensitive; saveSearchOptions()"
                [title]="caseSensitiveLabel"
            >
                Aa
            </button>
            <button
                class="btn"
                [class.btn-link]="!options.regex"
                [class.btn-info]="options.regex"
                (click)="options.regex = !options.regex; saveSearchOptions()"
                [title]="regexLabel"
            >
                .*
            </button>
            <button
                class="btn"
                [class.btn-link]="!options.wholeWord"
                [class.btn-info]="options.wholeWord"
                (click)="options.wholeWord = !options.wholeWord; saveSearchOptions()"
                [title]="wholeWordLabel"
            >
                ab
            </button>

            <span class="panel-divider"></span>

            <button class="btn btn-link" (click)="close.emit()" [title]="closeLabel">✕</button>
        </div>
    `,
    styles: [require('./tmuxSearchPanel.component.scss')],
})
export class TmuxSearchPanelComponent implements OnDestroy {
    @Input() frontend: Frontend
    query = ''
    state: SearchState = { resultCount: 0 }
    options: SearchOptions = {
        incremental: true,
        ...this.config.store.terminal.searchOptions,
    }

    @Output() close = new EventEmitter()

    searchUpLabel = this.translate.instant('Search up')
    searchDownLabel = this.translate.instant('Search down')
    caseSensitiveLabel = this.translate.instant('Case sensitivity')
    regexLabel = this.translate.instant('Regular expression')
    wholeWordLabel = this.translate.instant('Whole word')
    closeLabel = this.translate.instant('Close')

    private queryChanged = new Subject<string>()

    constructor(
        private notifications: NotificationsService,
        private translate: TranslateService,
        public config: ConfigService,
    ) {
        this.queryChanged.pipe(debounceTime(250)).subscribe(() => {
            this.findPrevious(true)
        })
    }

    onQueryChange(): void {
        this.state = { resultCount: 0 }
        this.queryChanged.next(this.query)
    }

    findNext(incremental = false): void {
        if (!this.query) {
            return
        }
        this.state = this.frontend.findNext(this.query, {
            ...this.options,
            incremental: incremental || undefined,
        })
        if (!this.state.resultCount) {
            this.notifications.notice(this.translate.instant('Not found'))
        }
    }

    findPrevious(incremental = false): void {
        if (!this.query) {
            return
        }
        this.state = this.frontend.findPrevious(this.query, {
            ...this.options,
            incremental: incremental || undefined,
        })
        if (!this.state.resultCount) {
            this.notifications.notice(this.translate.instant('Not found'))
        }
    }

    saveSearchOptions(): void {
        this.config.store.terminal.searchOptions.regex = this.options.regex
        this.config.store.terminal.searchOptions.caseSensitive = this.options.caseSensitive
        this.config.store.terminal.searchOptions.wholeWord = this.options.wholeWord
        this.config.save()
    }

    ngOnDestroy(): void {
        this.queryChanged.complete()
    }
}
