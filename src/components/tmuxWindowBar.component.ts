import {
    AfterViewInit,
    Component,
    ElementRef,
    Input,
    Output,
    EventEmitter,
    OnChanges,
    OnInit,
    OnDestroy,
    ChangeDetectorRef,
    SimpleChanges,
    ViewChild,
} from '@angular/core'
import { Subscription } from 'rxjs'
import { ConfigService, MenuItemOptions, PlatformService } from 'tabby-core'
import { TmuxController } from '../session'
import { TmuxI18nService } from '../services/tmuxI18n.service'
import { formatTmuxWindowTooltip, TmuxPaneTooltipData } from './tmuxWindowTooltip'
import {
    clampScrollLeft,
    computeScrollHints,
    resolveWheelScrollDelta,
    scrollLeftToReveal,
} from '../windowBarScroll'

interface WindowInfo {
    id: number
    name: string
    paneCount: number
    panes: TmuxPaneTooltipData[]
    tooltip: string
}

@Component({
    selector: 'tmux-window-bar',
    template: `
        <div class="window-bar">
            <div class="window-tabs" #tabsEl (wheel)="onTabsWheel($event)">
                <button
                    *ngFor="let win of windows"
                    class="window-tab"
                    [class.active]="win.id === activeWindowId"
                    [attr.data-window-id]="win.id"
                    (click)="windowSwitch.emit(win.id)"
                    (contextmenu)="onContextMenu($event, win)"
                    [title]="win.tooltip"
                >
                    <span class="window-name">{{ win.name }}</span>
                    <span class="pane-badge" *ngIf="win.paneCount > 1">{{ win.paneCount }}</span>
                    <span
                        class="window-close"
                        *ngIf="showCloseButton"
                        [attr.aria-label]="closeWindowTitle"
                        (click)="onCloseWindow($event, win)"
                    >
                        <i class="fas fa-times"></i>
                    </span>
                </button>
            </div>
            <!-- Sits directly after the strip, so it keeps its original place
                 right next to the last window tab; the strip shrinks (instead
                 of pushing it away) once the window list overflows. -->
            <button
                class="bar-btn add-btn"
                [title]="newWindowTitle"
                [attr.aria-label]="newWindowTitle"
                (click)="createWindow.emit()"
            >
                <i class="fas fa-plus"></i>
            </button>
            <div class="bar-actions">
                <button
                    class="bar-btn"
                    [title]="disconnectTitle"
                    [attr.aria-label]="disconnectTitle"
                    (click)="disconnect.emit()"
                >
                    <i class="fas fa-eject"></i>
                </button>
            </div>
        </div>
    `,
    styles: [
        `
            :host {
                display: block;
                flex: 0 0 auto;
            }
            /* The bar is always one single row. The window list scrolls
           horizontally on its own; the new-window button sits right after it
           (its original place, next to the last tab) and the exit button is
           pinned to the right edge, so a session with many windows can
           neither wrap the bar onto a second line nor push either button out
           of view. */
            .window-bar {
                display: flex;
                flex-wrap: nowrap;
                align-items: center;
                /* the tab strip keeps its own 2px rhythm with the + button */
                gap: 2px;
                padding: 2px 8px;
                background: var(--theme-bg-more-2, rgba(30, 30, 30, 0.95));
                border-top: 1px solid var(--theme-bg-less-2, rgba(255, 255, 255, 0.1));
                min-height: 28px;
                /* children scroll internally; nothing may spill out of the bar */
                overflow: hidden;
            }
            .window-tabs {
                display: flex;
                flex-wrap: nowrap;
                align-items: center;
                gap: 2px;
                /* Size to the tabs, but shrink (and scroll) instead of pushing
               the + button off-screen when the window list gets long. */
                flex: 0 1 auto;
                min-width: 0;
                position: relative;
                overflow-x: auto;
                overflow-y: hidden;
                /* A native scrollbar would eat into the 28px bar height and
               shift the pane area; wheel scrolling plus the edge fades
               below replace it. */
                scrollbar-width: none;
            }
            .window-tabs::-webkit-scrollbar {
                display: none;
            }
            /* Fades mark that more windows are scrolled out of sight; the
           classes are toggled from the component (updateScrollHints). */
            .window-tabs.can-scroll-left {
                -webkit-mask-image: linear-gradient(to right, transparent 0, #000 18px);
                mask-image: linear-gradient(to right, transparent 0, #000 18px);
            }
            .window-tabs.can-scroll-right {
                -webkit-mask-image: linear-gradient(to left, transparent 0, #000 18px);
                mask-image: linear-gradient(to left, transparent 0, #000 18px);
            }
            .window-tabs.can-scroll-left.can-scroll-right {
                -webkit-mask-image: linear-gradient(
                    to right,
                    transparent 0,
                    #000 18px,
                    #000 calc(100% - 18px),
                    transparent 100%
                );
                mask-image: linear-gradient(
                    to right,
                    transparent 0,
                    #000 18px,
                    #000 calc(100% - 18px),
                    transparent 100%
                );
            }
            .window-tab {
                display: flex;
                align-items: center;
                gap: 4px;
                height: 22px;
                /* Never shrink or wrap: the strip scrolls instead, so a tab
               always keeps its name and its close button apart. */
                flex: 0 0 auto;
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
                transition:
                    background 0.15s,
                    color 0.15s,
                    border-color 0.15s;
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
            /* Exit control — pinned to the right edge, never part of the
           scroll strip, so it stays reachable no matter how many windows
           the session has. */
            .bar-actions {
                display: flex;
                flex-wrap: nowrap;
                align-items: center;
                gap: 4px;
                flex: 0 0 auto;
                margin-left: auto;
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
            .add-btn {
                /* directly after the scroll strip — never shrinks away with it */
                flex: 0 0 auto;
                color: var(--theme-fg-more-2, #666);
            }
            .add-btn:hover {
                color: var(--theme-fg-more, #aaa);
            }
        `,
    ],
})
export class TmuxWindowBarComponent implements OnInit, OnChanges, AfterViewInit, OnDestroy {
    @Input() controller: TmuxController
    @Input() activeWindowId: number | null = null

    @Output() windowSwitch = new EventEmitter<number>()
    @Output() windowClose = new EventEmitter<number>()
    @Output() renameRequested = new EventEmitter<{ id: number; name: string }>()
    @Output() disconnect = new EventEmitter<void>()
    @Output() createWindow = new EventEmitter<void>()

    /** Horizontally scrolling strip that holds the window tabs. */
    @ViewChild('tabsEl') tabsEl?: ElementRef<HTMLElement>

    windows: WindowInfo[] = []

    closeWindowTitle = ''
    newWindowTitle = ''
    renameWindowTitle = ''
    disconnectTitle = ''

    private subscription: Subscription
    private languageSubscription: Subscription
    /** Signature of the rendered tab list, used to detect add/remove/rename. */
    private renderedSignature = ''
    private revealScheduled = false
    private stripScrollListener: (() => void) | null = null
    private stripResizeObserver: ResizeObserver | null = null

    constructor(
        private cdr: ChangeDetectorRef,
        private configService: ConfigService,
        private platform: PlatformService,
        private i18n: TmuxI18nService,
    ) {
        this.updateLabels()
    }

    get showCloseButton(): boolean {
        return this.configService?.store?.tmuxPlugin?.showWindowCloseButton ?? true
    }

    ngOnInit(): void {
        this.languageSubscription = this.i18n.languageChange$.subscribe(() => {
            this.updateLabels()
            this.refreshWindows()
        })
        this.refreshWindows()

        if (!this.controller) {
            return
        }

        this.subscription = this.controller.events.subscribe((event) => {
            switch (event.type) {
                case 'window-add':
                case 'window-close':
                case 'window-renamed':
                case 'pane-add':
                case 'pane-close':
                case 'active-pane-changed':
                case 'pane-renamed':
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

    ngOnChanges(changes: SimpleChanges): void {
        if (changes['activeWindowId']) {
            // The strip can only be measured once the new active tab is in the DOM.
            this.scheduleReveal()
        }
    }

    ngAfterViewInit(): void {
        const strip = this.tabsEl?.nativeElement
        if (!strip) {
            return
        }
        this.stripScrollListener = () => this.updateScrollHints()
        strip.addEventListener('scroll', this.stripScrollListener, { passive: true })
        if (typeof ResizeObserver !== 'undefined') {
            this.stripResizeObserver = new ResizeObserver(() => this.updateScrollHints())
            this.stripResizeObserver.observe(strip)
        }
        this.scheduleReveal()
    }

    ngOnDestroy(): void {
        this.subscription?.unsubscribe()
        this.languageSubscription?.unsubscribe()
        const strip = this.tabsEl?.nativeElement
        if (strip && this.stripScrollListener) {
            strip.removeEventListener('scroll', this.stripScrollListener)
        }
        this.stripResizeObserver?.disconnect()
        this.stripResizeObserver = null
    }

    /**
     * Translate a vertical wheel over the tab strip into horizontal scrolling.
     *
     * At either end the event is left alone so the wheel keeps working for the
     * terminal / surrounding view instead of being swallowed.
     */
    onTabsWheel(event: WheelEvent): void {
        const strip = this.tabsEl?.nativeElement
        if (!strip) {
            return
        }
        const delta = resolveWheelScrollDelta(event, strip.clientWidth)
        if (delta === 0) {
            return
        }
        const next = clampScrollLeft(strip.scrollLeft + delta, strip.scrollWidth, strip.clientWidth)
        if (next === strip.scrollLeft) {
            return
        }
        event.preventDefault()
        strip.scrollLeft = next
        this.updateScrollHints()
    }

    /** Scroll the active window tab into view (no-op when it already is). */
    revealActiveWindow(): void {
        const strip = this.tabsEl?.nativeElement
        if (!strip) {
            return
        }
        const id = this.activeWindowId
        const tab =
            id === null ? null : strip.querySelector<HTMLElement>(`[data-window-id="${id}"]`)
        if (tab) {
            const target = scrollLeftToReveal(
                { start: tab.offsetLeft, end: tab.offsetLeft + tab.offsetWidth },
                { start: strip.scrollLeft, end: strip.scrollLeft + strip.clientWidth },
                strip.scrollWidth,
                strip.clientWidth,
            )
            if (target !== strip.scrollLeft) {
                strip.scrollLeft = target
            }
        }
        this.updateScrollHints()
    }

    /** Toggle the edge fades that advertise hidden windows. */
    updateScrollHints(): void {
        const strip = this.tabsEl?.nativeElement
        if (!strip) {
            return
        }
        const hints = computeScrollHints(strip.scrollLeft, strip.scrollWidth, strip.clientWidth)
        strip.classList.toggle('can-scroll-left', hints.moreLeft)
        strip.classList.toggle('can-scroll-right', hints.moreRight)
    }

    /**
     * Reveal the active tab on the next frame — the tab strip has to be laid
     * out with the new window list / active window before it can be measured.
     */
    private scheduleReveal(): void {
        if (this.revealScheduled) {
            return
        }
        this.revealScheduled = true
        const run = () => {
            this.revealScheduled = false
            this.revealActiveWindow()
        }
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(run)
        } else {
            setTimeout(run, 0)
        }
    }

    private refreshWindows(): void {
        const controller = this.controller
        if (!controller) {
            this.windows = []
            this.renderedSignature = ''
            this.cdr.detectChanges()
            return
        }

        const windowStates = controller.getAllWindowStates()
        this.windows = windowStates.map((ws) => {
            const name = ws.name || this.i18n.t('window.defaultName', { id: ws.id })
            const activePaneId = controller.getActivePaneId(ws.id)
            const panes = Array.from(ws.panes).map((paneId) => ({
                id: paneId,
                title: controller.getPaneTitle(paneId),
                active: paneId === activePaneId,
            }))

            return {
                id: ws.id,
                name,
                paneCount: panes.length,
                panes,
                tooltip: formatTmuxWindowTooltip({ id: ws.id, name, panes }, (params) =>
                    this.i18n.t('window.tooltip', params),
                ),
            }
        })
        this.cdr.detectChanges()

        // Only follow the layout when the tab list itself changed (window
        // added/removed/renamed): unrelated refreshes must not yank back a
        // strip the user scrolled manually.
        const signature = this.windows.map((win) => `${win.id}:${win.name}`).join('\n')
        if (signature !== this.renderedSignature) {
            this.renderedSignature = signature
            this.scheduleReveal()
        }
    }

    private updateLabels(): void {
        this.closeWindowTitle = this.i18n.t('window.close')
        this.newWindowTitle = this.i18n.t('window.new')
        this.renameWindowTitle = this.i18n.t('window.rename')
        this.disconnectTitle = this.i18n.t('mode.disconnect')
    }

    onCloseWindow(event: MouseEvent, win: WindowInfo): void {
        event.stopPropagation()
        this.windowClose.emit(win.id)
    }

    onContextMenu(event: MouseEvent, win: WindowInfo): void {
        event.preventDefault()
        event.stopPropagation()
        this.platform.popupContextMenu(
            [
                {
                    label: this.renameWindowTitle,
                    click: () => this.renameRequested.emit({ id: win.id, name: win.name }),
                },
            ] as MenuItemOptions[],
            event,
        )
    }
}
