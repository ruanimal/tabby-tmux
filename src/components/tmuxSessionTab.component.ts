import { Component, Injector, Input, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core'
import { Subscription } from 'rxjs'
import { SplitTabComponent, SplitContainer, LogService, Logger, TabsService, HotkeysService } from 'tabby-core'
import { TabRecoveryService } from 'tabby-core'
import { TmuxController } from '../session'
import { TmuxService } from '../services/tmux.service'
import { TmuxPaneTabComponent } from './tmuxPaneTab.component'
import { parseTmuxLayout, TmuxLayoutNode, flattenLayout } from '../layoutParser'

export interface TmuxSessionProfile {
    sessionName?: string
}

/**
 * TmuxSessionTabComponent - Manages an entire tmux session within a single Tabby tab.
 *
 * Each tmux window is represented by its pane tabs, which are hidden/shown via
 * removeTab()/addTab() when switching windows. The bottom window bar provides
 * window switching UI.
 */
@Component({
    selector: 'tmux-session-tab',
    template: `
        <ng-container #vc></ng-container>
        <split-tab-spanner
            *ngFor='let spanner of _spanners'
            [container]='spanner.container'
            [index]='spanner.index'
            (change)='onSpannerAdjusted(spanner)'
            (resizing)='onSpannerResizing($event)'
        ></split-tab-spanner>
        <split-tab-drop-zone
            *ngFor='let dropZone of _dropZones'
            [parent]='this'
            [dropZone]='dropZone'
            (tabDropped)='onTabDropped($event, dropZone)'
        >
        </split-tab-drop-zone>
        <split-tab-pane-label
            *ngFor='let tab of getAllTabs()'
            cdkDropList
            cdkAutoDropGroup='app-tabs'
            [tab]='tab'
            [parent]='this'
        >
        </split-tab-pane-label>
        <tmux-window-bar
            [controller]="controller"
            [activeWindowId]="activeWindowId"
            [collapsed]="windowBarCollapsed"
            [sessionName]="sessionName"
            (windowSwitch)="switchToWindow($event)"
            (disconnect)="onDisconnect()"
            (createWindow)="onCreateWindow()"
            (collapsedChange)="onToggleCollapse($event)"
        ></tmux-window-bar>
    `,
    styles: [`
        :host {
            display: flex;
            flex-direction: column;
            height: 100%;
        }
        ng-container, split-tab-spanner, split-tab-drop-zone, split-tab-pane-label {
            flex: 1 1 auto;
        }
        tmux-window-bar {
            flex: 0 0 auto;
        }
    `]
})
export class TmuxSessionTabComponent extends SplitTabComponent implements OnInit, OnDestroy {
    @Input() profile: TmuxSessionProfile = {}
    @Input() existingController?: TmuxController

    private logger: Logger
    private eventSubscription: Subscription | null = null
    private _injector: Injector

    // windowId → (paneId → paneTab)
    private windowPaneTabs = new Map<number, Map<number, TmuxPaneTabComponent>>()

    controller: TmuxController | null = null
    activeWindowId: number | null = null
    connected = false
    sessionName = ''
    windowBarCollapsed = false

    constructor(
        injector: Injector,
        private tmuxService: TmuxService,
        private cdr: ChangeDetectorRef,
        log: LogService,
    ) {
        super(
            injector.get(HotkeysService),
            injector.get(TabsService),
            injector.get(TabRecoveryService),
            injector
        )
        this._injector = injector
        this.logger = log.create('tmux-session')
    }

    async ngOnInit(): Promise<void> {
        if (this.existingController) {
            this.controller = this.existingController
        } else {
            const sessionName = this.profile.sessionName || 'default'
            await this.tmuxService.connectToSession(sessionName)
            this.controller = this.tmuxService.controller
        }

        if (!this.controller) {
            this.logger.error('Failed to get tmux controller')
            return
        }

        this.sessionName = this.controller.getSessionName() || this.profile.sessionName || 'default'
        this.setTitle(`Tmux: ${this.sessionName}`)

        // Subscribe to controller events
        this.eventSubscription = this.controller.events.subscribe(event => {
            this.handleControllerEvent(event)
        })

        // If controller already has windows (e.g. attaching to existing session),
        // activate the first one
        const firstWindowId = this.controller.getFirstWindowId()
        if (firstWindowId !== undefined) {
            await this.switchToWindow(firstWindowId)
        }
    }

    private async handleControllerEvent(event: { type: string; paneId?: number; windowId?: number; data?: any }): Promise<void> {
        this.logger.info('SessionTab event:', event.type, event)

        switch (event.type) {
            case 'initialized':
            case 'session-changed':
                this.connected = true
                this.sessionName = this.controller?.getSessionName() || this.profile.sessionName || 'default'
                this.setTitle(`Tmux: ${this.sessionName}`)
                this.cdr.detectChanges()
                break

            case 'window-add':
                if (event.windowId !== undefined) {
                    // Ensure the window has an entry in our map
                    if (!this.windowPaneTabs.has(event.windowId)) {
                        this.windowPaneTabs.set(event.windowId, new Map())
                    }
                    // If no active window yet, switch to this one
                    if (this.activeWindowId === null) {
                        await this.switchToWindow(event.windowId)
                    }
                }
                break

            case 'window-close':
                if (event.windowId !== undefined) {
                    await this.handleWindowClose(event.windowId)
                }
                break

            case 'pane-add':
                if (event.paneId !== undefined && event.windowId !== undefined) {
                    await this.handlePaneAdd(event.paneId, event.windowId)
                }
                break

            case 'pane-update':
                if (event.paneId !== undefined && event.windowId !== undefined) {
                    // Pane might have moved to a different window
                    await this.handlePaneUpdate(event.paneId, event.windowId)
                }
                break

            case 'layout-change':
                if (event.windowId === this.activeWindowId && event.data?.layout) {
                    this.syncLayout(event.data.layout)
                }
                break

            case 'exit':
                this.connected = false
                this.cdr.detectChanges()
                break
        }
    }

    /**
     * Switch to a different tmux window.
     * Hides current window's panes and shows target window's panes.
     */
    async switchToWindow(windowId: number): Promise<void> {
        if (windowId === this.activeWindowId) return

        this.logger.info(`Switching to window @${windowId}`)

        // 1. Remove current active window's panes from SplitTab (keep tab objects alive)
        if (this.activeWindowId !== null) {
            const paneMap = this.windowPaneTabs.get(this.activeWindowId)
            if (paneMap) {
                for (const paneTab of paneMap.values()) {
                    ;(paneTab as any).emitVisibility(false)
                    this.removeTab(paneTab as any)
                }
            }
        }

        // 2. Update active window
        this.activeWindowId = windowId

        // 3. Ensure pane tabs exist for this window
        if (!this.windowPaneTabs.has(windowId)) {
            this.windowPaneTabs.set(windowId, new Map())
        }
        const paneMap = this.windowPaneTabs.get(windowId)!

        if (paneMap.size === 0) {
            // First time visiting this window — create pane tabs
            await this.addPanesForWindow(windowId)
        }

        // 4. Rebuild SplitContainer tree with this window's panes
        this.root = new SplitContainer()
        this.root.orientation = 'h'

        const paneTabs = Array.from(paneMap.values())
        if (paneTabs.length > 0) {
            for (let i = 0; i < paneTabs.length; i++) {
                const paneTab = paneTabs[i] as any
                if (i === 0) {
                    await this.addTab(paneTab, null, 'r')
                } else {
                    await this.addTab(paneTab, paneTabs[i - 1] as any, 'r')
                }
                paneTab.emitVisibility(true)
            }

            // 5. Sync layout from tmux
            const windowState = this.controller?.getWindowState(windowId)
            if (windowState?.layout) {
                this.syncLayout(windowState.layout)
            }
        }

        // 6. Refresh tmux client size
        this.refreshClientSize()
        this.cdr.detectChanges()
    }

    /**
     * Create pane tabs for a window that hasn't been visited yet.
     */
    private async addPanesForWindow(windowId: number): Promise<void> {
        if (!this.controller) return

        const paneIds = this.controller.getWindowPanes(windowId)
        this.logger.info(`Creating pane tabs for window @${windowId}: ${paneIds.map(p => '%' + p).join(', ')}`)

        const paneMap = this.windowPaneTabs.get(windowId) || new Map<number, TmuxPaneTabComponent>()
        this.windowPaneTabs.set(windowId, paneMap)

        for (const paneId of paneIds) {
            if (paneMap.has(paneId)) continue

            const paneTab = new TmuxPaneTabComponent(this._injector)
            paneTab.controller = this.controller
            paneTab.paneId = paneId
            paneMap.set(paneId, paneTab)
        }
    }

    /**
     * Handle a new pane being added to a window (real-time from tmux).
     */
    private async handlePaneAdd(paneId: number, windowId: number): Promise<void> {
        if (!this.controller) return

        let paneMap = this.windowPaneTabs.get(windowId)
        if (!paneMap) {
            paneMap = new Map()
            this.windowPaneTabs.set(windowId, paneMap)
        }

        if (paneMap.has(paneId)) {
            this.logger.debug(`Pane %${paneId} already tracked for window @${windowId}`)
            return
        }

        // Create the pane tab
        const paneTab = new TmuxPaneTabComponent(this._injector)
        paneTab.controller = this.controller
        paneTab.paneId = paneId
        paneMap.set(paneId, paneTab)

        // If this pane belongs to the active window, mount it in SplitTab
        if (windowId === this.activeWindowId) {
            const existingTabs = this.getAllTabs()
            if (existingTabs.length === 0) {
                await this.addTab(paneTab as any, null, 'r')
            } else {
                await this.addTab(paneTab as any, existingTabs[existingTabs.length - 1] as any, 'r')
            }
            ;(paneTab as any).emitVisibility(true)

            // Re-sync layout
            const windowState = this.controller.getWindowState(windowId)
            if (windowState?.layout) {
                this.syncLayout(windowState.layout)
            }
            this.cdr.detectChanges()
        }
    }

    /**
     * Handle pane-update event (pane might have moved between windows).
     */
    private async handlePaneUpdate(paneId: number, windowId: number): Promise<void> {
        // Find which window currently owns this pane
        let currentWindowId: number | null = null
        for (const [wid, paneMap] of this.windowPaneTabs) {
            if (paneMap.has(paneId)) {
                currentWindowId = wid
                break
            }
        }

        if (currentWindowId === windowId) {
            // Same window — no action needed
            return
        }

        // Pane moved between windows — move the tab object
        if (currentWindowId !== null) {
            const oldPaneMap = this.windowPaneTabs.get(currentWindowId)!
            const paneTab = oldPaneMap.get(paneId)
            if (paneTab) {
                oldPaneMap.delete(paneId)
                let newPaneMap = this.windowPaneTabs.get(windowId)
                if (!newPaneMap) {
                    newPaneMap = new Map()
                    this.windowPaneTabs.set(windowId, newPaneMap)
                }
                newPaneMap.set(paneId, paneTab)

                // If it was in the active window, remove from SplitTab
                if (currentWindowId === this.activeWindowId) {
                    ;(paneTab as any).emitVisibility(false)
                    this.removeTab(paneTab as any)
                }
            }
        } else {
            // Pane not tracked yet — treat as add
            await this.handlePaneAdd(paneId, windowId)
        }
    }

    /**
     * Handle a tmux window being closed.
     */
    private async handleWindowClose(windowId: number): Promise<void> {
        const paneMap = this.windowPaneTabs.get(windowId)
        if (paneMap) {
            // Destroy all pane tabs for this window
            for (const paneTab of paneMap.values()) {
                if (windowId === this.activeWindowId) {
                    ;(paneTab as any).emitVisibility(false)
                    this.removeTab(paneTab as any)
                }
                ;(paneTab as any).destroy()
            }
            this.windowPaneTabs.delete(windowId)
        }

        // If we just closed the active window, switch to another one
        if (windowId === this.activeWindowId) {
            this.activeWindowId = null
            const remainingWindows = Array.from(this.windowPaneTabs.keys())
            if (remainingWindows.length > 0) {
                await this.switchToWindow(remainingWindows[0])
            } else {
                // No windows left — reset
                this.root = new SplitContainer()
                this.root.orientation = 'h'
                this.layout()
                this.cdr.detectChanges()
            }
        }
    }

    /**
     * Synchronize SplitTab layout with tmux's layout string.
     */
    private syncLayout(layoutStr: string): void {
        const layoutTree = parseTmuxLayout(layoutStr)
        if (!layoutTree) {
            this.logger.warn('Failed to parse layout:', layoutStr)
            return
        }

        const panes = flattenLayout(layoutTree)
        this.logger.info(`Syncing layout for window @${this.activeWindowId}: ${panes.length} panes`)

        // Build the SplitContainer tree from the parsed layout
        const newRoot = this.buildSplitContainerFromLayout(layoutTree)
        if (newRoot instanceof SplitContainer) {
            this.root = newRoot
            this.layout()
        } else if (newRoot) {
            // Single pane — wrap in a container
            this.root = new SplitContainer()
            this.root.orientation = 'h'
            this.root.children.push(newRoot as any)
            this.root.ratios.push(1)
            this.layout()
        }
    }

    /**
     * Build a SplitContainer tree from a tmux layout node.
     */
    private buildSplitContainerFromLayout(node: TmuxLayoutNode): SplitContainer | TmuxPaneTabComponent | null {
        if (node.type === 'pane' && node.paneId !== undefined && this.activeWindowId !== null) {
            const paneMap = this.windowPaneTabs.get(this.activeWindowId)
            return paneMap?.get(node.paneId) || null
        }

        if (!node.children || node.children.length === 0) {
            return null
        }

        const container = new SplitContainer()
        container.orientation = node.type === 'horizontal' ? 'h' : 'v'

        const totalSize = node.type === 'horizontal'
            ? node.children.reduce((sum, c) => sum + c.width, 0)
            : node.children.reduce((sum, c) => sum + c.height, 0)

        for (const child of node.children) {
            const childComponent = this.buildSplitContainerFromLayout(child)
            if (childComponent) {
                container.children.push(childComponent as any)
                const ratio = totalSize > 0
                    ? (node.type === 'horizontal' ? child.width / totalSize : child.height / totalSize)
                    : 1 / node.children.length
                container.ratios.push(ratio)
            }
        }

        return container.children.length > 0 ? container : null
    }

    /**
     * Refresh tmux client size to match current SplitTab dimensions.
     */
    private refreshClientSize(): void {
        if (this.controller) {
            const size = (this as any).size
            if (size) {
                this.controller.resizePane(0, size.columns, size.rows)
            }
        }
    }

    // --- UI Event Handlers ---

    onDisconnect(): void {
        this.tmuxService.disconnect()
    }

    async onCreateWindow(): Promise<void> {
        if (this.controller) {
            const newWindowId = await this.controller.createWindow()
            if (newWindowId !== null) {
                await this.switchToWindow(newWindowId)
            }
        }
    }

    onToggleCollapse(collapsed: boolean): void {
        this.windowBarCollapsed = collapsed
        this.cdr.detectChanges()
    }

    override ngOnDestroy(): void {
        if (this.eventSubscription) {
            this.eventSubscription.unsubscribe()
        }
        super.ngOnDestroy()
    }

    override async canClose(): Promise<boolean> {
        return true
    }
}
