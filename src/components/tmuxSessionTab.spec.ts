import { Subject } from 'rxjs'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('tabby-core', () => {
    class MockSplitTabComponent {
        disableDynamicTitle = false
        title = ''
        subscribeUntilDestroyed(
            observable: { subscribe: (callback: (...args: any[]) => void) => unknown },
            callback: (...args: any[]) => void,
        ): void {
            observable.subscribe(callback)
        }
        setTitle(title: string): void {
            this.title = title
        }
    }
    return {
        SplitTabComponent: MockSplitTabComponent,
        SplitContainer: class SplitContainer {},
        HotkeysService: class HotkeysService {},
        TabRecoveryService: class TabRecoveryService {},
        TabsService: class TabsService {},
        LogService: class LogService {},
        ConfigService: class ConfigService {},
    }
})
vi.mock('tabby-terminal', () => ({ Frontend: class Frontend {} }))
vi.mock('../session', () => ({ TmuxController: class TmuxController {} }))
vi.mock('../services/tmux.service', () => ({ TmuxService: class TmuxService {} }))
vi.mock('../services/tmuxI18n.service', () => ({
    TmuxI18nService: class TmuxI18nService {},
}))
vi.mock('../gateway', () => ({ TMUX_COMMAND_TOLERATE_ERRORS: [] }))
vi.mock('./tmuxPaneTab.component', () => ({
    TmuxPaneTabComponent: class TmuxPaneTabComponent {},
}))
vi.mock('../layoutParser', () => ({
    flattenLayout: vi.fn(),
    parseTmuxLayout: vi.fn(),
}))
vi.mock('../divider', () => ({ renderDividers: vi.fn() }))
vi.mock('../tmuxKeymap', () => ({}))
vi.mock('../tmuxRename', () => ({ normalizeRename: vi.fn() }))

type SessionTabTitleState = {
    disableDynamicTitle: boolean
    title: string
    controller: unknown
    sessionName: string
    getCustomTitle(): string
}

type ControllerEvent = {
    type: string
    paneId?: number
    windowId?: number
}

type TestController = {
    events: Subject<ControllerEvent>
    gateway: { sendCommand: (...args: unknown[]) => Promise<string> }
    isAttached: boolean
    getActiveWindowId(): number | null
    getActivePaneId(windowId: number): number | null
    getHostName(): string
    getSessionName(): string
    getPaneTitle(paneId: number): string
    setActivePaneId(paneId: number): void
    setPaneTitle(paneId: number, title: string): void
    getAllWindowStates(): Array<{ id: number; name: string; panes: Set<number> }>
    getWindowState(windowId: number): { name: string; index?: number } | undefined
}

type SessionTabTestInstance = SessionTabTitleState & {
    activeWindowId: number | null
    controller: TestController
    existingController: TestController
    enqueueSwitchToWindow(windowId: number, syncToTmux?: boolean): void
    switchToWindow(windowId: number, syncToTmux?: boolean): Promise<void>
    ngOnInit(): void
}

type TestZone = {
    run(callback: () => void): void
}

describe('TmuxSessionTabComponent title ownership', () => {
    let SessionTabComponent: unknown

    beforeAll(async () => {
        SessionTabComponent = (await import('./tmuxSessionTab.component')).TmuxSessionTabComponent
    })

    function createSessionTab(format = '#{window_name} - #{host}'): {
        component: SessionTabTestInstance
        zone: TestZone
        controller: TestController
        configChanges: Subject<void>
    } {
        const languageChange$ = new Subject<void>()
        const hotkey$ = new Subject<string>()
        const controllerEvents = new Subject<ControllerEvent>()
        const injector = { get: () => ({}) }
        const i18n = {
            languageChange$,
            t: (key: string, params?: { name?: string }) =>
                params?.name ? `${key}:${params.name}` : key,
        }
        const hotkeys = { hotkey$, unfilteredHotkey$: new Subject<string>() }
        const zone: TestZone = { run: vi.fn((callback: () => void) => callback()) }
        const log = {
            create: () => ({
                debug: vi.fn(),
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
            }),
        }
        const configChanges = new Subject<void>()
        let activePaneId = 9
        const paneTitles = new Map([[9, 'terminal']])
        const controller: TestController = {
            events: controllerEvents,
            gateway: { sendCommand: vi.fn().mockResolvedValue('') },
            isAttached: false,
            getActiveWindowId: () => 1,
            getActivePaneId: () => activePaneId,
            getHostName: () => 'host.example',
            getSessionName: () => 'session',
            getPaneTitle: (paneId) => paneTitles.get(paneId) ?? '',
            setActivePaneId: (paneId) => {
                activePaneId = paneId
            },
            setPaneTitle: (paneId, title) => {
                paneTitles.set(paneId, title)
            },
            getAllWindowStates: () => [],
            getWindowState: (windowId) =>
                windowId === 1 ? { name: 'editor', index: 2 } : { name: 'shell', index: 3 },
        }
        const config = { store: { tmuxPlugin: { sessionTitleFormat: format } } }
        const SessionTab = SessionTabComponent as new (...args: unknown[]) => SessionTabTestInstance
        const component = new SessionTab(
            injector,
            {},
            i18n,
            config,
            {},
            { detectChanges: vi.fn() },
            {},
            hotkeys,
            zone,
            { changed$: configChanges },
            log,
        )
        component.controller = controller
        component.existingController = controller
        component.sessionName = 'session'
        component.activeWindowId = 1
        return { component, zone, controller, configChanges }
    }

    it('keeps the session title as the parent SplitTab title owner', () => {
        const { component } = createSessionTab()

        expect(component.disableDynamicTitle).toBe(true)
    })

    it('renders the configured window, pane, session and host variables', () => {
        const { component } = createSessionTab(
            '#{session_name}: #{window_name} #{window_id}/#{window_index} #{pane_name} #{pane_id} #{host}',
        )

        expect(component.getCustomTitle()).toBe('session: editor @1/2 terminal %9 host.example')
    })

    it('refreshes the title when the format configuration changes', () => {
        const { component, configChanges } = createSessionTab()
        const config = (component as any).configService as {
            store: { tmuxPlugin: { sessionTitleFormat: string } }
        }
        config.store.tmuxPlugin.sessionTitleFormat = '#{session_name} / #{window_name}'

        configChanges.next()

        expect(component.title).toBe('session / editor')
    })

    it('refreshes the configured pane variables on active pane changes', () => {
        const { component, controller } = createSessionTab(
            '#{window_name} / #{pane_name} #{pane_id}',
        )
        component.ngOnInit()

        controller.setActivePaneId(10)
        controller.setPaneTitle(10, 'logs')
        controller.events.next({ type: 'active-pane-changed', windowId: 1, paneId: 10 })

        expect(component.title).toBe('editor / logs %10')
    })

    it('updates the pane title after a pane rename event', () => {
        const { component, controller } = createSessionTab('#{window_name} / #{pane_name}')
        component.ngOnInit()

        controller.setPaneTitle(9, 'renamed')
        controller.events.next({ type: 'pane-renamed', windowId: 1, paneId: 9 })

        expect(component.title).toBe('editor / renamed')
    })

    it('updates the title before a queued window view switch completes', async () => {
        const { component, zone } = createSessionTab()
        const switchSpy = vi.spyOn(component, 'switchToWindow').mockResolvedValue(undefined)

        component.enqueueSwitchToWindow(2, true)

        expect(component.title).toBe('shell - host.example')
        expect(component.getCustomTitle()).toBe('shell - host.example')
        expect(zone.run).toHaveBeenCalled()

        await Promise.resolve()
        expect(switchSpy).toHaveBeenCalledWith(2, true)
    })
})
