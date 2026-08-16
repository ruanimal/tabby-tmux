import { describe, expect, it, vi } from 'vitest'
import { Subject } from 'rxjs'
import type { AppService, ConfigService, HotkeysService, LogService, Logger } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { TmuxService, SessionContext } from './services/tmux.service'

// tabby-core / tabby-terminal / tabby components are Angular partially-compiled
// packages; loading them in Node requires the Angular linker. Stub them so the
// test exercises TmuxService's real logic without pulling in the UI graph.
vi.mock('tabby-core', async () => {
    const { Injectable } = await import('@angular/core')
    return {
        Injectable,
        AppService: class AppService {},
        LogService: class LogService {},
        Logger: class Logger {},
        ConfigService: class ConfigService {},
        HotkeysService: class HotkeysService {},
    }
})

vi.mock('tabby-terminal', async () => {
    const { Subject } = await import('rxjs')
    class MockBaseSession {
        open = false
        output$ = new Subject<Buffer>()
        constructor(_logger: unknown) {
            this.open = true
        }
        protected emitOutput(data: Buffer): void {
            this.output$.next(data)
        }
        async destroy(): Promise<void> {
            this.output$.complete()
        }
    }
    class MockSessionMiddleware {
        push(): void {
            void 0
        }
        unshift(): void {
            void 0
        }
        remove(): void {
            void 0
        }
    }
    return {
        BaseSession: MockBaseSession,
        SessionMiddleware: MockSessionMiddleware,
        BaseTerminalTabComponent: class BaseTerminalTabComponent {},
    }
})

vi.mock('./components/tmuxSessionTab.component', () => ({
    TmuxSessionTabComponent: class TmuxSessionTabComponent {},
}))

function createLoggerMock() {
    return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    } as unknown as Logger
}

/** NgZone mock that records whether its callback runs "inside the zone". */
function createZoneMock() {
    let insideZone = false
    const zone = {
        run: vi.fn((fn: () => void) => {
            insideZone = true
            try {
                return fn()
            } finally {
                insideZone = false
            }
        }),
        isInsideZone: () => insideZone,
    }
    return zone
}

function createService() {
    const tabs: any[] = []
    const tabsChanged = new Subject<void>()
    const openNewTabRaw = vi.fn((params: any) => {
        const tab = {
            destroyed$: new Subject(),
            destroy: vi.fn(),
            ...params.inputs,
            // Record whether the tab was created inside the Angular zone
            createdInsideZone: zone.isInsideZone(),
        }
        tabs.push(tab)
        return tab
    })
    const selectTab = vi.fn()
    const appService = {
        tabs,
        tabsChanged,
        openNewTabRaw,
        selectTab,
        activeTab: null,
    } as unknown as AppService

    const zone = createZoneMock()
    const logger = createLoggerMock()
    const configService = {
        store: { tmuxPlugin: { debugLogging: true } },
    } as unknown as ConfigService
    const logService = { create: () => logger } as unknown as LogService
    const hotkeysService = {
        unfilteredHotkey$: new Subject<string>(),
    } as unknown as HotkeysService

    const service = new TmuxService(
        {} as any, // Injector — unused by the paths under test
        appService,
        configService,
        zone as any,
        logService,
        hotkeysService,
    )
    return { service, appService, zone, tabs, openNewTabRaw, selectTab, logger, hotkeysService }
}

function createContext(topmostParent?: any): SessionContext {
    const terminalTab = {
        topmostParent: topmostParent ?? null,
        session: { middleware: { unshift: vi.fn(), remove: vi.fn() } },
        destroyed$: new Subject(),
        frontend: {},
    } as any
    const context: SessionContext = {
        controller: {
            getSessionName: () => 'main',
            gateway: { detach: vi.fn() },
            destroy: vi.fn().mockResolvedValue(undefined),
        } as any,
        terminalTab,
        subscriptions: [],
    }
    return context
}

describe('TmuxService', () => {
    describe('replaceWithSessionTab', () => {
        it('creates the session tab inside the Angular zone', () => {
            const { service, zone, openNewTabRaw } = createService()
            const context = createContext()

            ;(service as any).replaceWithSessionTab(context)

            expect(zone.run).toHaveBeenCalled()
            expect(openNewTabRaw).toHaveBeenCalled()
            // The tab instance must be created while zone.run is executing,
            // otherwise Angular change detection never fires and the tab
            // component stays unmounted until an unrelated zone event.
            expect(openNewTabRaw.mock.results[0].value.createdInsideZone).toBe(true)
        })

        it('swaps the session tab in place of the original topmost tab', () => {
            const { service, appService, tabs } = createService()
            const originalTab = { name: 'original' }
            const context = createContext(originalTab)
            ;(appService as any).tabs.push(originalTab)

            ;(service as any).replaceWithSessionTab(context)

            // Session tab sits at the original tab's index; original is hidden
            expect(tabs).toHaveLength(1)
            expect(tabs[0]).not.toBe(originalTab)
            expect(context.sessionTab).toBeDefined()
            expect((context.sessionTab as any)?.createdInsideZone).toBe(true)
        })
    })

    describe('disconnectContext', () => {
        it('restores the original topmost tab inside the Angular zone', async () => {
            const { service, zone, selectTab, tabs } = createService()
            const originalTab = { name: 'original' }
            const context = createContext(originalTab)
            ;(service as any).replaceWithSessionTab(context)
            // Session tab is now the only tab; simulate the original being
            // hidden (removed from app.tabs) as replaceWithSessionTab does.
            const sessionTab = context.sessionTab!
            expect(tabs).toContain(sessionTab)

            await (service as any).disconnectContext(context)

            expect(zone.run).toHaveBeenCalled()
            expect(tabs).toContain(originalTab)
            expect(selectTab).toHaveBeenCalledWith(originalTab)
        })
    })

    describe('toggleTmuxMode', () => {
        it('attaches from the active terminal tab when idle', () => {
            const { service, appService } = createService()
            const attachSpy = vi.spyOn(service, 'attachToTerminal').mockResolvedValue(undefined)
            const terminal = Object.create(BaseTerminalTabComponent.prototype)
            ;(appService as any).activeTab = terminal

            service.toggleTmuxMode()

            expect(attachSpy).toHaveBeenCalledWith(terminal)
        })

        it('disconnects when already connected', () => {
            const { service } = createService()
            ;(service as any).sessions.add(createContext())
            const disconnectSpy = vi.spyOn(service, 'disconnect').mockResolvedValue(undefined)

            service.toggleTmuxMode()

            expect(disconnectSpy).toHaveBeenCalled()
        })

        it('attaches from a terminal nested inside the active split tab', () => {
            const { service, appService } = createService()
            const attachSpy = vi.spyOn(service, 'attachToTerminal').mockResolvedValue(undefined)
            const terminal = Object.create(BaseTerminalTabComponent.prototype)
            ;(appService as any).activeTab = { focusedTab: terminal }

            service.toggleTmuxMode()

            expect(attachSpy).toHaveBeenCalledWith(terminal)
        })

        it('does not re-attach a terminal tab already in a session', async () => {
            const { service } = createService()
            const context = createContext()
            ;(service as any).sessions.add(context)
            const unshiftSpy = vi.spyOn(context.terminalTab.session.middleware, 'unshift')

            await service.attachToTerminal(context.terminalTab)

            expect(unshiftSpy).not.toHaveBeenCalled()
        })

        it('ignores non-terminal active tabs', () => {
            const { service, appService } = createService()
            const attachSpy = vi.spyOn(service, 'attachToTerminal').mockResolvedValue(undefined)
            ;(appService as any).activeTab = {} as any

            service.toggleTmuxMode()

            expect(attachSpy).not.toHaveBeenCalled()
        })
    })

    describe('toggle hotkey wiring', () => {
        it('responds to the tmuxPlugin.toggle-tmux-mode hotkey', () => {
            const { service, hotkeysService } = createService()
            const toggleSpy = vi
                .spyOn(service, 'toggleTmuxMode')
                .mockImplementation(() => undefined)

            ;(hotkeysService as any).unfilteredHotkey$.next('tmuxPlugin.toggle-tmux-mode')

            expect(toggleSpy).toHaveBeenCalled()
        })

        it('ignores unrelated hotkeys', () => {
            const { service, hotkeysService } = createService()
            const toggleSpy = vi
                .spyOn(service, 'toggleTmuxMode')
                .mockImplementation(() => undefined)

            ;(hotkeysService as any).unfilteredHotkey$.next('tmuxPlugin.next-window')

            expect(toggleSpy).not.toHaveBeenCalled()
        })
    })
})
