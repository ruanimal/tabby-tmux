import { Injectable, Injector, NgZone } from '@angular/core'
import { AppService, LogService, Logger, ConfigService } from 'tabby-core'
import { createConditionalLogger, ConditionalLogger } from '../logHelper'
import { BaseTerminalTabComponent, SessionMiddleware } from 'tabby-terminal'
import { Subject, Subscription } from 'rxjs'
import { TmuxController } from '../session'

import { TmuxSessionTabComponent } from '../components/tmuxSessionTab.component'

/**
 * Middleware inserted at position 0 of the original session's middleware chain
 * when entering tmux mode.  It captures raw output data for the tmux gateway
 * and BLOCKS it from propagating further, so that other middleware plugins
 * (e.g. trzsz) on the original session do not see tmux control mode data.
 *
 * Without this interceptor, trzsz middleware on the original session would
 * detect trzsz protocol markers embedded in %output lines and trigger
 * chooseSendFiles() a second time ("double file dialog" bug).
 */
class TmuxOutputInterceptor extends SessionMiddleware {
    private _rawOutput = new Subject<Buffer>()
    /** Raw session output, before any middleware processing */
    rawOutput$ = this._rawOutput.asObservable()

    feedFromSession(data: Buffer): void {
        // Capture raw data for the tmux gateway
        this._rawOutput.next(data)
        // Do NOT call super.feedFromSession() — this blocks data from
        // propagating to the rest of the middleware chain (trzsz, etc.)
    }

    // feedFromTerminal is NOT overridden — terminal→session data flows
    // through normally so the session can still receive input.
}

/** @hidden */
export { TmuxOutputInterceptor }

/**
 * TmuxService manages tmux integration.
 *
 * Each tmux session is bound to a terminal tab. When entering tmux mode,
 * the entire topmost Tab (usually a SplitTab) containing the terminal tab
 * is temporarily hidden from the Tabby tab list, and replaced with a
 * TmuxSessionTab at the top level. On disconnect, the original topmost Tab is restored.
 */
export interface SessionContext {
    controller: TmuxController
    /** The original terminal tab, hidden while tmux is active */
    terminalTab: BaseTerminalTabComponent<any>
    /** The topmost parent Tab (SplitTabComponent or terminal tab) that was hidden */
    topmostTab?: any
    /** Original index of topmostTab in app.tabs, for restoring position */
    topmostTabIndex?: number
    sessionTab?: TmuxSessionTabComponent
    subscriptions: Subscription[]
    /** Interceptor middleware on the original session, removed on disconnect */
    outputInterceptor?: TmuxOutputInterceptor
}

@Injectable({ providedIn: 'root' })
export class TmuxService {
    private logger: Logger
    private sessions = new Set<SessionContext>()

    constructor(
        private injector: Injector,
        private appService: AppService,
        private configService: ConfigService,
        private zone: NgZone,
        log: LogService,
    ) {
        this.logger = log.create('tmux-service')
    }

    private get log(): ConditionalLogger {
        return createConditionalLogger(this.logger, this.configService)
    }

    get isConnected(): boolean {
        return this.sessions.size > 0
    }

    get controller(): TmuxController | null {
        return this.sessions.values().next().value?.controller || null
    }

    /**
     * Find the SessionContext that owns a given sessionTab.
     */
    findContextForTab(tab: TmuxSessionTabComponent): SessionContext | undefined {
        for (const ctx of this.sessions) {
            if (ctx.sessionTab === tab) return ctx
        }
        return undefined
    }

    private setupControllerEvents(context: SessionContext): void {
        context.subscriptions.push(
            context.controller.events.subscribe((event) => {
                // On initialized, replace the terminal tab with the session tab
                if (event.type === 'initialized' && !context.sessionTab) {
                    this.replaceWithSessionTab(context)
                }
            }),
        )
    }

    private replaceWithSessionTab(context: SessionContext): void {
        if (context.sessionTab) return

        this.log.info('Creating TmuxSessionTab...')

        // The whole attach pipeline (PTY IPC callback → output interceptor →
        // gateway → controller.events) runs OUTSIDE the Angular zone, so a
        // bare tabs.push/tabOpened.next() here would never trigger change
        // detection: the new tab's component stays unmounted and its ngOnInit
        // (which pushes the first client size via refresh-client -C) is
        // deferred until some unrelated zone event (window focus/resize)
        // happens to run CD — on a cold start that can take many seconds.
        // Run the tab creation inside the Angular zone so the tab-body ngFor
        // renders immediately and the tmux session initializes right away.
        let sessionTab: TmuxSessionTabComponent
        this.zone.run(() => {
            // Find the topmost parent tab (the actual tab listed in the top tab bar)
            const topmostTab = context.terminalTab.topmostParent || context.terminalTab
            context.topmostTab = topmostTab

            // Remember the original index so we can replace in-place
            const tabs: any[] = (this.appService as any).tabs
            const index = tabs.indexOf(topmostTab)
            context.topmostTabIndex = index

            // IMPORTANT: We must use openNewTabRaw, NOT openNewTab.
            // openNewTab wraps non-SplitTab types in a wrapper SplitTab via wrapAndAddTab().
            // But TmuxSessionTabComponent extends SplitTabComponent, and wrapAndAddTab's
            // SplitTab.addTab(thing) has special logic: when thing instanceof SplitTabComponent,
            // it extracts thing.root and then DESTROYS thing. This kills our component instance
            // before it ever gets rendered, so ngOnInit/ngAfterViewInit never fire.
            //
            // openNewTabRaw adds the tab directly without wrapping, so our component's
            // view is properly attached and lifecycle hooks execute normally.
            sessionTab = (this.appService as any).openNewTabRaw({
                type: TmuxSessionTabComponent as any,
                inputs: {
                    existingController: context.controller,
                    profile: { sessionName: context.controller.getSessionName() },
                },
            }) as TmuxSessionTabComponent

            context.sessionTab = sessionTab

            // Move the session tab to the same position as the original tab
            if (index !== -1) {
                const sessionIndex = tabs.indexOf(sessionTab)
                if (sessionIndex !== -1) {
                    tabs.splice(sessionIndex, 1) // remove from end
                    tabs.splice(index, 0, sessionTab) // insert at original position
                    ;(this.appService as any).tabsChanged.next()
                }
            }

            // Hide the original topmost tab
            if (index !== -1) {
                const origIndex = tabs.indexOf(topmostTab)
                if (origIndex !== -1) {
                    tabs.splice(origIndex, 1)
                    ;(this.appService as any).tabsChanged.next()
                }
            }
        })

        // When the session tab is closed (by user or disconnect), clean up
        context.subscriptions.push(
            sessionTab.destroyed$.subscribe(() => {
                context.sessionTab = undefined
            }),
        )
    }

    async disconnectContext(context: SessionContext): Promise<void> {
        this.sessions.delete(context)

        context.subscriptions.forEach((s) => s.unsubscribe())

        // Detach from tmux control mode so the tmux client process exits
        // cleanly. Without this, the original terminal tab's PTY still has
        // a running `tmux -CC attach` process, causing "tmux is still running"
        // confirmation dialogs when the user tries to close the restored tab.
        context.controller.gateway.detach()

        // Remove the output interceptor from the original session's middleware chain
        if (context.outputInterceptor) {
            context.terminalTab.session?.middleware.remove(context.outputInterceptor)
            context.outputInterceptor = undefined
        }

        await context.controller.destroy()

        // Destroy the session tab (removes from tab bar)
        if (context.sessionTab) {
            context.sessionTab.destroy()
            context.sessionTab = undefined
        }

        // Restore the original topmost tab to the tab bar at its original position.
        // This mutates app.tabs + tabsChanged, which must run inside the Angular
        // zone (see replaceWithSessionTab) so change detection re-renders the
        // tab bar — otherwise the restored tab stays invisible until an
        // unrelated zone event triggers CD.
        this.zone.run(() => {
            if (context.topmostTab) {
                const tabs: any[] = (this.appService as any).tabs
                const insertAt =
                    context.topmostTabIndex !== undefined
                        ? Math.min(context.topmostTabIndex, tabs.length)
                        : tabs.length
                tabs.splice(insertAt, 0, context.topmostTab)
                ;(this.appService as any).tabsChanged.next()

                // Activate the restored tab
                ;(this.appService as any).selectTab(context.topmostTab)
            }
        })

        this.log.info('Disconnected tmux context')
    }

    /**
     * Disconnect from all sessions
     */
    async disconnect(): Promise<void> {
        for (const context of this.sessions) {
            await this.disconnectContext(context)
        }
    }

    /**
     * Attach to tmux from an existing terminal tab.
     * Replaces the terminal tab with a TmuxSessionTab, keeping the terminal tab
     * hidden in context. On disconnect, the terminal tab is restored.
     */
    async attachToTerminal(terminalTab: BaseTerminalTabComponent<any>): Promise<void> {
        const session = terminalTab.session
        if (!session) {
            this.logger.error('Terminal tab has no session')
            return
        }

        this.log.info('Attaching tmux to existing terminal session')

        const context: SessionContext = {
            controller: null!, // Set below
            terminalTab,
            subscriptions: [],
        }

        // Insert a tmux output interceptor at position 0 of the session's
        // middleware chain.  This captures raw output for the gateway and
        // prevents trzsz (or other) middleware on the original session from
        // seeing tmux control mode data (which would cause false positives).
        const interceptor = new TmuxOutputInterceptor()
        session.middleware.unshift(interceptor)
        context.outputInterceptor = interceptor

        // Create a controller that uses the terminal's session for I/O
        context.controller = new TmuxController(
            this.logger,
            this.injector,
            (data: string) => session.write(Buffer.from(data)),
            () => this.disconnectContext(context),
            this.configService,
        )

        // Capture the host terminal's xterm cell size NOW, while it is fully
        // rendered (the user just triggered "Enter tmux Mode", so fonts are
        // loaded and the cell measurement is accurate). tmux panes use the
        // same global font config, so this cell size is what every pane will
        // end up with — SessionTab uses it to compute the first client size
        // push correctly, instead of waiting for a pane's xterm to initialize
        // (whose early measurement may use a fallback font → wrong size).
        const hostFrontend = (terminalTab as any).frontend
        const hostDims = hostFrontend?.xtermCore?._renderService?.dimensions
        if (hostDims?.css?.cell?.width > 0 && hostDims?.css?.cell?.height > 0) {
            context.controller.setHostCellSize({
                width: hostDims.css.cell.width,
                height: hostDims.css.cell.height,
            })
            this.log.info(
                `Captured host xterm cell size: ${hostDims.css.cell.width}x${hostDims.css.cell.height}`,
            )
        } else {
            // Shouldn't happen (host terminal is rendered), but fall back to
            // the original "wait for a pane's xterm" logic.
            this.logger.warn('Host xterm cell size unavailable at attach time')
        }

        // Subscribe to the interceptor's raw output to parse tmux control mode.
        // Feed raw buffers directly — the gateway handles line buffering internally
        // via executeData(), which properly handles TCP fragment boundaries.
        context.subscriptions.push(
            interceptor.rawOutput$.subscribe((data: Buffer) => {
                context.controller.handleData(data)
            }),
        )

        // Handle terminal tab closure (disconnect on close)
        context.subscriptions.push(
            terminalTab.destroyed$.subscribe(() => {
                this.log.info('Attached terminal tab closed, disconnecting session')
                this.disconnectContext(context)
            }),
        )

        this.sessions.add(context)
        this.setupControllerEvents(context)

        // Send the tmux -CC command to the terminal
        const sessionName = this.configService.store.tmuxPlugin?.defaultSessionName ?? 'default'
        session.write(Buffer.from(`tmux -CC new -A -s ${sessionName}\n`))
    }

    // replaceTabWithTmuxWindow removed as we open new tabs for windows instead
}
