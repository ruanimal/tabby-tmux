import { Injectable, Injector } from '@angular/core'
import { AppService, LogService, Logger } from 'tabby-core'
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

    feedFromSession (data: Buffer): void {
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
        log: LogService,
    ) {
        this.logger = log.create('tmux-service')
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
        context.subscriptions.push(context.controller.events.subscribe(event => {
            // On initialized, replace the terminal tab with the session tab
            if (event.type === 'initialized' && !context.sessionTab) {
                this.replaceWithSessionTab(context)
            }
        }))
    }

    private replaceWithSessionTab(context: SessionContext): void {
        if (context.sessionTab) return

        this.logger.info('Creating TmuxSessionTab...')

        // IMPORTANT: We must use openNewTabRaw, NOT openNewTab.
        // openNewTab wraps non-SplitTab types in a wrapper SplitTab via wrapAndAddTab().
        // But TmuxSessionTabComponent extends SplitTabComponent, and wrapAndAddTab's
        // SplitTab.addTab(thing) has special logic: when thing instanceof SplitTabComponent,
        // it extracts thing.root and then DESTROYS thing. This kills our component instance
        // before it ever gets rendered, so ngOnInit/ngAfterViewInit never fire.
        //
        // openNewTabRaw adds the tab directly without wrapping, so our component's
        // view is properly attached and lifecycle hooks execute normally.
        const sessionTab = (this.appService as any).openNewTabRaw({
            type: TmuxSessionTabComponent as any,
            inputs: {
                existingController: context.controller,
                profile: { sessionName: context.controller.getSessionName() },
            },
        }) as TmuxSessionTabComponent

        context.sessionTab = sessionTab

        this.logger.info('TmuxSessionTab created, proceeding to hide original tab...')

        // Find the topmost parent tab (the actual tab listed in the top tab bar)
        const topmostTab = context.terminalTab.topmostParent || context.terminalTab
        context.topmostTab = topmostTab

        // Temporarily hide the topmost tab from the app tabs list
        const tabs: any[] = (this.appService as any).tabs
        const index = tabs.indexOf(topmostTab)
        this.logger.info(`Original tab index in app tabs: ${index}`)
        if (index !== -1) {
            tabs.splice(index, 1)
            ;(this.appService as any).tabsChanged.next()
        }

        // When the session tab is closed (by user or disconnect), clean up
        context.subscriptions.push(sessionTab.destroyed$.subscribe(() => {
            context.sessionTab = undefined
        }))
    }

    async disconnectContext(context: SessionContext): Promise<void> {
        this.sessions.delete(context)

        context.subscriptions.forEach(s => s.unsubscribe())

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

        // Restore the original topmost tab to the tab bar
        if (context.topmostTab) {
            ;(this.appService as any).addTabRaw(context.topmostTab)
        }

        this.logger.info('Disconnected tmux context')
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

        this.logger.info('Attaching tmux to existing terminal session')

        const context: SessionContext = {
            controller: null!, // Set below
            terminalTab,
            subscriptions: []
        }

        let buffer = ''

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
            () => this.disconnectContext(context)
        )

        // Subscribe to the interceptor's raw output to parse tmux control mode
        context.subscriptions.push(interceptor.rawOutput$.subscribe((data: Buffer) => {
            buffer += data.toString()
            const lines = buffer.split('\n')
            if (lines.length > 1) {
                buffer = lines.pop()!
                for (const line of lines) {
                    context.controller.handleLine(line)
                }
            }
        }))

        // Handle terminal tab closure (disconnect on close)
        context.subscriptions.push(terminalTab.destroyed$.subscribe(() => {
            this.logger.info('Attached terminal tab closed, disconnecting session')
            this.disconnectContext(context)
        }))

        this.sessions.add(context)
        this.setupControllerEvents(context)

        // Send the tmux -CC command to the terminal
        session.write(Buffer.from('tmux -CC new -A -s default\n'))
    }

    // replaceTabWithTmuxWindow removed as we open new tabs for windows instead

}

