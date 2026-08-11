import { Component, Input, Output, EventEmitter, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core'
import { Subscription } from 'rxjs'
import { TmuxController } from '../session'

interface WindowInfo {
    id: number
    name: string
    paneCount: number
}

@Component({
    selector: 'tmux-window-bar',
    template: `
        <div class="window-bar">
            <div class="window-tabs">
                <button
                    *ngFor="let win of windows"
                    class="window-tab"
                    [class.active]="win.id === activeWindowId"
                    (click)="windowSwitch.emit(win.id)"
                    (contextmenu)="onContextMenu($event, win)"
                    [title]="win.name"
                >
                    <span class="window-name">{{ win.name }}</span>
                    <span class="pane-badge" *ngIf="win.paneCount > 1">{{ win.paneCount }}</span>
                    <span class="window-close" title="Close Window" (click)="onCloseWindow($event, win)">
                        <i class="fas fa-times"></i>
                    </span>
                </button>
                <button class="window-tab add-btn" title="New Window" (click)="createWindow.emit()">
                    <i class="fas fa-plus"></i>
                </button>
            </div>
            <div class="bar-actions">
                <button class="bar-btn" title="Disconnect" (click)="disconnect.emit()">
                    <i class="fas fa-eject"></i>
                </button>
            </div>
        </div>
    `,
    styles: [`
        :host {
            display: block;
            flex: 0 0 auto;
        }
        .window-bar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 2px 8px;
            background: var(--theme-bg-more-2, rgba(30, 30, 30, 0.95));
            border-top: 1px solid var(--theme-bg-less-2, rgba(255, 255, 255, 0.1));
            min-height: 28px;
            overflow-x: auto;
        }
        .window-tabs {
            display: flex;
            align-items: center;
            gap: 2px;
            overflow-x: auto;
            flex: 1;
            min-width: 0;
        }
        .window-tab {
            display: flex;
            align-items: center;
            gap: 4px;
            height: 22px;
            /* 窗口名过短（如 "1"、"2"）时 tab 会缩得很窄，
               导致关闭按钮紧贴名称，悬停时极易误触关闭。
               设置最小宽度保证名称与关闭按钮之间有足够间距。 */
            min-width: 72px;
            padding: 0 8px;
            border: 1px solid transparent;
            border-radius: 3px;
            background: transparent;
            color: var(--theme-fg-more-2, #999);
            font-size: 0.82em;
            cursor: pointer;
            white-space: nowrap;
            transition: background 0.15s, color 0.15s, border-color 0.15s;
        }
        .window-tab:hover {
            background: var(--theme-bg-less-2, rgba(255, 255, 255, 0.08));
            color: var(--theme-fg-more, #ccc);
        }
        .window-tab.active {
            background: var(--body-bg, rgba(255, 255, 255, 0.12));
            color: var(--theme-fg, #fff);
            border-color: var(--theme-fg-more-2, rgba(255, 255, 255, 0.15));
        }
        .pane-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 16px;
            height: 16px;
            padding: 0 3px;
            border-radius: 8px;
            background: var(--theme-bg-less-2, rgba(255, 255, 255, 0.1));
            font-size: 0.85em;
            color: var(--theme-fg-more, #aaa);
        }
        .window-close {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            margin-left: auto;
            margin-right: -4px;
            width: 14px;
            height: 14px;
            border-radius: 2px;
            font-size: 0.7em;
            color: transparent;
            cursor: pointer;
            visibility: hidden;
        }
        .window-tab:hover .window-close {
            visibility: visible;
            color: var(--theme-fg-more-2, #888);
        }
        .window-close:hover {
            background: color-mix(in srgb, var(--theme-danger, #f66) 30%, transparent);
            color: var(--theme-danger, #f66);
        }
        .add-btn {
            color: var(--theme-fg-more-2, #666);
            padding: 0 6px;
            /* "+" 按钮不需要最小宽度，覆盖 .window-tab 的 min-width */
            min-width: 0;
        }
        .add-btn:hover {
            color: var(--theme-fg-more, #aaa);
        }
        .bar-actions {
            display: flex;
            align-items: center;
            gap: 2px;
            margin-left: 8px;
        }
        .bar-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 24px;
            height: 24px;
            border: none;
            border-radius: 3px;
            background: transparent;
            color: var(--theme-fg-more-2, #888);
            font-size: 0.8em;
            cursor: pointer;
        }
        .bar-btn:hover {
            background: var(--theme-bg-less-2, rgba(255, 255, 255, 0.1));
            color: var(--theme-fg-more, #ccc);
        }
    `]
})
export class TmuxWindowBarComponent implements OnInit, OnDestroy {
    @Input() controller: TmuxController
    @Input() activeWindowId: number | null = null

    @Output() windowSwitch = new EventEmitter<number>()
    @Output() windowClose = new EventEmitter<number>()
    @Output() disconnect = new EventEmitter<void>()
    @Output() createWindow = new EventEmitter<void>()

    windows: WindowInfo[] = []

    private subscription: Subscription

    constructor(private cdr: ChangeDetectorRef) {}

    ngOnInit(): void {
        this.refreshWindows()

        if (!this.controller) {
            return
        }

        this.subscription = this.controller.events.subscribe(event => {
            switch (event.type) {
                case 'window-add':
                case 'window-close':
                case 'window-renamed':
                case 'pane-add':
                case 'pane-close':
                case 'initialized':
                    this.refreshWindows()
                    break
                case 'layout-change':
                    // Layout changes may affect pane count display
                    // (e.g. zoom shows fewer panes in layout, but real count is unchanged)
                    this.refreshWindows()
                    break
            }
        })
    }

    ngOnDestroy(): void {
        this.subscription?.unsubscribe()
    }

    private refreshWindows(): void {
        if (!this.controller) {
            this.windows = []
            this.cdr.detectChanges()
            return
        }

        const windowStates = this.controller.getAllWindowStates()
        this.windows = windowStates.map(ws => ({
            id: ws.id,
            name: ws.name,
            paneCount: ws.panes.size,
        }))
        this.cdr.detectChanges()
    }

    onCloseWindow(event: MouseEvent, win: WindowInfo): void {
        event.stopPropagation()
        this.windowClose.emit(win.id)
    }

    onContextMenu(event: MouseEvent, _win: WindowInfo): void {
        // Reserved for future context menu (rename, close window, etc.)
        event.preventDefault()
    }
}
