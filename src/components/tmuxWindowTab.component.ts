import { Component, Injector, Input, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core'
import { Subscription } from 'rxjs'
import { BaseTabComponent, SplitTabComponent, SplitContainer, LogService, Logger, TabsService, HotkeysService } from 'tabby-core'
import { TabRecoveryService } from 'tabby-core'
import { TmuxController } from '../session'
import { TmuxService } from '../services/tmux.service'
import { TmuxPaneTabComponent } from './tmuxPaneTab.component'
import { parseTmuxLayout, TmuxLayoutNode, flattenLayout } from '../layoutParser'

export interface TmuxWindowProfile {
    sessionName?: string
}

/**
 * TmuxWindowTabComponent - A unified container for all tmux panes
 *
 * This component extends SplitTabComponent to manage tmux panes within a single tab.
 * It synchronizes the layout with tmux's window layout.
 */
@Component({
    selector: 'tmux-window-tab',
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
        <div class="tmux-status-bar" *ngIf="connected">
            <span class="session-name">
                <i class="fas fa-layer-group"></i>
                {{sessionName}}
            </span>
            <span class="pane-count">{{paneCount}} pane(s)</span>
        </div>
    `,
    styles: [`
        :host {
            display: flex;
            flex-direction: column;
            height: 100%;
        }
        .tmux-status-bar {
            display: flex;
            justify-content: space-between;
            padding: 4px 12px;
            background: rgba(0, 100, 0, 0.3);
            border-top: 1px solid rgba(0, 255, 0, 0.2);
            font-size: 0.85em;
            color: #6f6;
        }
        .session-name {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .pane-count {
            color: #999;
        }
    `]
})
export class TmuxWindowTabComponent extends SplitTabComponent implements OnInit, OnDestroy {
    @Input() profile: TmuxWindowProfile = {}
    @Input() existingController?: TmuxController

    private logger: Logger
    private eventSubscription: Subscription | null = null
    private paneTabMap = new Map<number, TmuxPaneTabComponent>()
    private controller: TmuxController | null = null
    private _injector: Injector

    connected = false
    sessionName = ''
    paneCount = 0

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
        this.logger = log.create('tmux-window')
    }

    async ngOnInit(): Promise<void> {
        // If we have an existing controller (e.g., from context menu attach)
        if (this.existingController) {
            this.controller = this.existingController
        } else {
            // Connect to tmux session
            const sessionName = this.profile.sessionName || 'default'
            await this.tmuxService.connectToSession(sessionName)
            this.controller = this.tmuxService.controller
        }

        if (!this.controller) {
            this.logger.error('Failed to get tmux controller')
            return
        }

        this.sessionName = this.controller.getSessionName() || 'default'
        this.setTitle(`Tmux: ${this.sessionName}`)

        // Subscribe to controller events
        this.eventSubscription = this.controller.events.subscribe(event => {
            this.logger.info('TmuxWindowTab received event:', event.type, event)

            switch (event.type) {
                case 'initialized':
                case 'session-changed':
                    this.connected = true
                    this.sessionName = this.controller?.getSessionName() || 'default'
                    this.setTitle(`Tmux: ${this.sessionName}`)
                    this.cdr.detectChanges()
                    break

                case 'pane-add':
                    if (event.paneId !== undefined) {
                        this.addPaneToSplit(event.paneId)
                    }
                    break

                case 'layout-change':
                    if (event.data?.layout) {
                        this.syncLayout(event.data.layout)
                    }
                    break

                case 'exit':
                    this.connected = false
                    this.cdr.detectChanges()
                    break
            }
        })
    }

    /**
     * Add a tmux pane to the split layout
     */
    private async addPaneToSplit(paneId: number): Promise<void> {
        if (this.paneTabMap.has(paneId)) {
            this.logger.debug(`Pane %${paneId} already exists in split`)
            return
        }

        if (!this.controller) {
            this.logger.error('No controller available')
            return
        }

        this.logger.info(`Adding pane %${paneId} to split layout`)

        // Create the pane tab component
        const paneTab = new TmuxPaneTabComponent(
            this._injector
        )
        paneTab.controller = this.controller
        paneTab.paneId = paneId

        // Store reference
        this.paneTabMap.set(paneId, paneTab)
        this.paneCount = this.paneTabMap.size

        // Add to split layout
        // Determine direction based on existing panes
        const existingTabs = this.getAllTabs()
        if (existingTabs.length === 0) {
            // First pane - add to root
            await this.add(paneTab, null, 'r')
        } else {
            // Add to the right of the last pane
            const lastTab = existingTabs[existingTabs.length - 1]
            await this.add(paneTab, lastTab, 'r')
        }

        this.layout()
        this.cdr.detectChanges()
    }

    /**
     * Synchronize the split layout with tmux's layout
     */
    private syncLayout(layoutStr: string): void {
        const layoutTree = parseTmuxLayout(layoutStr)
        if (!layoutTree) {
            this.logger.warn('Failed to parse layout:', layoutStr)
            return
        }

        const panes = flattenLayout(layoutTree)
        this.logger.info(`Layout has ${panes.length} panes:`, panes.map(p => p.paneId))

        // For now, just ensure all panes exist
        // Full layout sync would require rebuilding the SplitContainer tree
        for (const pane of panes) {
            if (!this.paneTabMap.has(pane.paneId)) {
                this.addPaneToSplit(pane.paneId)
            }
        }

        // TODO: More sophisticated layout sync
        // This would involve:
        // 1. Building a new SplitContainer tree from layoutTree
        // 2. Matching pane IDs to existing TmuxPaneTabComponents
        // 3. Replacing this.root with the new tree
        // 4. Calling this.layout()
    }

    /**
     * Build a SplitContainer tree from a tmux layout tree
     * NOTE: Reserved for future full layout sync implementation
     */
    // @ts-ignore: Reserved for future implementation
    private _buildSplitContainerFromLayout(node: TmuxLayoutNode): SplitContainer | BaseTabComponent | null {
        if (node.type === 'pane' && node.paneId !== undefined) {
            return this.paneTabMap.get(node.paneId) || null
        }

        if (!node.children || node.children.length === 0) {
            return null
        }

        const container = new SplitContainer()
        container.orientation = node.type === 'horizontal' ? 'h' : 'v'

        // Calculate ratios from dimensions
        const totalSize = node.type === 'horizontal'
            ? node.children.reduce((sum, c) => sum + c.width, 0)
            : node.children.reduce((sum, c) => sum + c.height, 0)

        for (const child of node.children) {
            const childComponent = this._buildSplitContainerFromLayout(child)
            if (childComponent) {
                container.children.push(childComponent)
                const ratio = node.type === 'horizontal'
                    ? child.width / totalSize
                    : child.height / totalSize
                container.ratios.push(ratio)
            }
        }

        return container.children.length > 0 ? container : null
    }

    override ngOnDestroy(): void {
        if (this.eventSubscription) {
            this.eventSubscription.unsubscribe()
        }
        // Don't disconnect from tmux - let the service manage that
        super.ngOnDestroy()
    }

    override async canClose(): Promise<boolean> {
        // Allow closing the window without killing tmux
        return true
    }
}
