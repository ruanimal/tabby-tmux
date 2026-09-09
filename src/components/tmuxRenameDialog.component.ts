import {
    AfterViewInit,
    Component,
    ElementRef,
    EventEmitter,
    Input,
    OnInit,
    Output,
    ViewChild,
} from '@angular/core'
import { normalizeRename } from '../tmuxRename'

@Component({
    selector: 'tmux-rename-dialog',
    template: `
        <div
            class="rename-dialog-backdrop"
            role="presentation"
            (mousedown)="$event.stopPropagation()"
            (click)="cancelRename()"
        >
            <form
                class="rename-dialog"
                role="dialog"
                aria-modal="true"
                [attr.aria-labelledby]="titleId"
                (mousedown)="$event.stopPropagation()"
                (click)="$event.stopPropagation()"
                (ngSubmit)="submit()"
            >
                <h4 [id]="titleId">{{ title }}</h4>
                <label class="sr-only" [attr.for]="inputId">{{ title }}</label>
                <input
                    #nameInput
                    [id]="inputId"
                    class="form-control"
                    type="text"
                    name="name"
                    autocomplete="off"
                    [(ngModel)]="draft"
                    (keydown.escape)="cancelRename()"
                />
                <div class="rename-dialog-actions">
                    <button type="button" class="btn btn-secondary" (click)="cancelRename()">
                        {{ cancelLabel }}
                    </button>
                    <button type="submit" class="btn btn-primary" [disabled]="!draft.trim()">
                        {{ confirmLabel }}
                    </button>
                </div>
            </form>
        </div>
    `,
    styles: [
        `
            :host {
                position: absolute;
                inset: 0;
                z-index: 100;
                display: block;
            }
            .rename-dialog-backdrop {
                position: absolute;
                inset: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 16px;
                background: rgba(0, 0, 0, 0.45);
                box-sizing: border-box;
            }
            .rename-dialog {
                width: min(420px, 100%);
                padding: 18px;
                border: 1px solid var(--theme-bg-less-2, rgba(255, 255, 255, 0.18));
                border-radius: 5px;
                background: var(--theme-bg-more-2, #252525);
                color: var(--theme-fg, #fff);
                box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
            }
            .rename-dialog h4 {
                margin: 0 0 14px;
                font-size: 1rem;
                font-weight: 500;
            }
            .rename-dialog-actions {
                display: flex;
                justify-content: flex-end;
                gap: 8px;
                margin-top: 16px;
            }
            .sr-only {
                position: absolute;
                width: 1px;
                height: 1px;
                padding: 0;
                margin: -1px;
                overflow: hidden;
                clip: rect(0, 0, 0, 0);
                white-space: nowrap;
                border: 0;
            }
        `,
    ],
})
export class TmuxRenameDialogComponent implements OnInit, AfterViewInit {
    @Input() title = ''
    @Input() initialValue = ''
    @Input() cancelLabel = ''
    @Input() confirmLabel = ''

    @Output() submitName = new EventEmitter<string>()
    @Output() cancel = new EventEmitter<void>()

    @ViewChild('nameInput') private nameInput?: ElementRef<HTMLInputElement>

    draft = ''
    readonly inputId = 'tmux-rename-input'
    readonly titleId = 'tmux-rename-title'

    ngOnInit(): void {
        this.draft = this.initialValue
    }

    ngAfterViewInit(): void {
        setTimeout(() => {
            this.nameInput?.nativeElement.focus()
            this.nameInput?.nativeElement.select()
        }, 0)
    }

    submit(): void {
        const name = normalizeRename(this.draft)
        if (name) {
            this.submitName.emit(name)
            return
        }

        this.nameInput?.nativeElement.focus()
    }

    cancelRename(): void {
        this.cancel.emit()
    }
}
