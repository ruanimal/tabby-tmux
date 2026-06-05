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
        <div class="window-bar" *ngIf="!collapsed">
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
                </button>
            </div>
            <div class="bar-actions">
                <button class="bar-btn" title="New Window" (click)="createWindow.emit()">
                    <i class="fas fa-plus"></i>
                </button>
                <button class="bar-btn" title="Disconnect" (click)="disconnect.emit()">
                    <i class="fas fa-eject"></i>
                </button>
                <button class="bar-btn" title="Collapse" (click)="onToggleCollapse()">
                    <i class="fas fa-chevron-down"></i>
                </button>
            </div>
        </div>
        <div class="window-bar collapsed-bar" *ngIf="collapsed">
            <button class="bar-btn expand-btn" title="Expand" (click)="onToggleCollapse()">
                <i class="fas fa-chevron-up"></i>
                <span class="session-label" *ngIf="sessionName">{{ sessionName }}</span>
            </button>
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
            background: rgba(30, 30, 30, 0.95);
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            min-height: 28px;
            overflow-x: auto;
        }
        .collapsed-bar {
            justify-content: center;
            padding: 2px 12px;
        }
        .expand-btn {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .session-label {
            font-size: 0.8em;
            color: #aaa;
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
            padding: 3px 10px;
            border: 1px solid transparent;
            border-radius: 3px;
            background: transparent;
            color: #999;
            font-size: 0.82em;
            cursor: pointer;
            white-space: nowrap;
            transition: all 0.15s;
        }
        .window-tab:hover {
            background: rgba(255, 255, 255, 0.08);
            color: #ccc;
        }
        .window-tab.active {
            background: rgba(255, 255, 255, 0.12);
            color: #fff;
            border-color: rgba(255, 255, 255, 0.15);
        }
        .pane-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 16px;
            height: 16px;
            padding: 0 3px;
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.1);
            font-size: 0.85em;
            color: #aaa;
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
            color: #888;
            font-size: 0.8em;
            cursor: pointer;
        }
        .bar-btn:hover {
            background: rgba(255, 255, 255, 0.1);
            color: #ccc;
        }
    `]
})
export class TmuxWindowBarComponent implements OnInit, OnDestroy {
    @Input() controller: TmuxController
    @Input() activeWindowId: number | null = null
    @Input() collapsed = false
    @Input() sessionName = ''

    @Output() windowSwitch = new EventEmitter<number>()
    @Output() disconnect = new EventEmitter<void>()
    @Output() createWindow = new EventEmitter<void>()
    @Output() collapsedChange = new EventEmitter<boolean>()

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

    onToggleCollapse(): void {
        this.collapsed = !this.collapsed
        this.collapsedChange.emit(this.collapsed)
    }

    onContextMenu(event: MouseEvent, _win: WindowInfo): void {
        // Reserved for future context menu (rename, close window, etc.)
        event.preventDefault()
    }
}
