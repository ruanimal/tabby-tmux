import { Subject } from 'rxjs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
vi.mock('tabby-core', () => {
    class MockSplitTabComponent {
        disableDynamicTitle = false
        title = ''
        subscribeUntilDestroyed(): void {
            void 0
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

type TestController = {
    gateway: { sendCommand: (...args: unknown[]) => Promise<string> }
    getActiveWindowId(): number | null
    getHostName(): string
    getSessionName(): string
    getWindowState(windowId: number): { name: string } | undefined
}

type SessionTabTestInstance = SessionTabTitleState & {
    activeWindowId: number | null
    controller: TestController
    enqueueSwitchToWindow(windowId: number, syncToTmux?: boolean): void
    switchToWindow(windowId: number, syncToTmux?: boolean): Promise<void>
}

type TestZone = {
    run(callback: () => void): void
}
describe('TmuxSessionTabComponent title ownership', () => {
    let SessionTabComponent: unknown

    beforeAll(async () => {
        SessionTabComponent = (await import('./tmuxSessionTab.component')).TmuxSessionTabComponent
    })

    function createSessionTab(): {
        component: SessionTabTestInstance
        zone: TestZone
    } {
        const languageChange$ = new Subject<void>()
        const hotkey$ = new Subject<string>()
        const injector = { get: () => ({}) }
        const i18n = {
            languageChange$,
            t: (key: string, params?: { name?: string }) =>
                params?.name ? `${key}:${params.name}` : key,
        }
        const hotkeys = { hotkey$, unfilteredHotkey$: new Subject<string>() }
        const zone: TestZone = { run: vi.fn((callback: () => void) => callback()) }
        const log = { create: () => ({}) }
        const SessionTab = SessionTabComponent as new (...args: unknown[]) => SessionTabTestInstance
        const component = new SessionTab(
            injector,
            {},
            i18n,
            {},
            {},
            { detectChanges: vi.fn() },
            {},
            hotkeys,
            zone,
            log,
        )
        component.controller = {
            gateway: { sendCommand: vi.fn().mockResolvedValue('') },
            getActiveWindowId: () => 1,
            getHostName: () => 'host.example',
            getSessionName: () => 'session',
            getWindowState: (windowId) => (windowId === 1 ? { name: 'editor' } : { name: 'shell' }),
        }
        component.sessionName = 'session'
        component.activeWindowId = 1
        return { component, zone }
    }

    it('keeps the session title as the parent SplitTab title owner', () => {
        const { component } = createSessionTab()

        expect(component.disableDynamicTitle).toBe(true)
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
