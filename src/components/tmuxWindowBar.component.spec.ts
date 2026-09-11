import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Subject } from 'rxjs'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('tabby-core', () => ({
    ConfigService: class ConfigService {},
    PlatformService: class PlatformService {},
}))
vi.mock('../session', () => ({ TmuxController: class TmuxController {} }))
vi.mock('../services/tmuxI18n.service', () => ({ TmuxI18nService: class TmuxI18nService {} }))

const COMPONENT_SOURCE = readFileSync(resolve(__dirname, 'tmuxWindowBar.component.ts'), 'utf8')

function extractBlock(keyword: 'template' | 'styles'): string {
    const start = COMPONENT_SOURCE.indexOf(`${keyword}:`)
    const backtick = COMPONENT_SOURCE.indexOf('`', start)
    if (start === -1 || backtick === -1) {
        throw new Error(`${keyword} not found in component source`)
    }
    const end = COMPONENT_SOURCE.indexOf('`', backtick + 1)
    return COMPONENT_SOURCE.slice(backtick + 1, end)
}

type FakeElement = {
    scrollLeft: number
    scrollWidth: number
    clientWidth: number
    offsetLeft: number
    offsetWidth: number
    classList: { toggle: (name: string, force?: boolean) => void; has: (name: string) => boolean }
    addEventListener: ReturnType<typeof vi.fn>
    removeEventListener: ReturnType<typeof vi.fn>
    querySelector: (selector: string) => FakeElement | null
}

function createFakeStrip(options: {
    scrollLeft?: number
    scrollWidth: number
    clientWidth: number
    tab?: { id: number; offsetLeft: number; offsetWidth: number }
}): FakeElement {
    const classes = new Set<string>()
    const tab: FakeElement | null = options.tab
        ? {
              scrollLeft: 0,
              scrollWidth: options.tab.offsetWidth,
              clientWidth: options.tab.offsetWidth,
              offsetLeft: options.tab.offsetLeft,
              offsetWidth: options.tab.offsetWidth,
              classList: { toggle: () => undefined, has: () => false },
              addEventListener: vi.fn(),
              removeEventListener: vi.fn(),
              querySelector: () => null,
          }
        : null

    return {
        scrollLeft: options.scrollLeft ?? 0,
        scrollWidth: options.scrollWidth,
        clientWidth: options.clientWidth,
        offsetLeft: 0,
        offsetWidth: 0,
        classList: {
            toggle: (name: string, force?: boolean) => {
                if (force) {
                    classes.add(name)
                } else {
                    classes.delete(name)
                }
            },
            has: (name: string) => classes.has(name),
        },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        querySelector: (selector: string) =>
            options.tab && selector === `[data-window-id="${options.tab.id}"]` ? tab : null,
    }
}

type WindowBarTestInstance = {
    activeWindowId: number | null
    windows: Array<{ id: number; name: string }>
    controller: unknown
    tabsEl?: { nativeElement: FakeElement }
    showCloseButton: boolean
    windowSwitch: { emit: (id: number) => void }
    createWindow: { emit: () => void }
    disconnect: { emit: () => void }
    ngOnInit(): void
    ngOnChanges(changes: Record<string, unknown>): void
    ngAfterViewInit(): void
    ngOnDestroy(): void
    refreshWindows(): void
    revealActiveWindow(): void
    updateScrollHints(): void
    onTabsWheel(event: WheelEvent): void
}

describe('TmuxWindowBarComponent layout', () => {
    let WindowBarComponent: unknown

    beforeAll(async () => {
        WindowBarComponent = (await import('./tmuxWindowBar.component')).TmuxWindowBarComponent
    })

    function createComponent(): {
        component: WindowBarTestInstance
        languageChange$: Subject<void>
    } {
        const languageChange$ = new Subject<void>()
        const i18n = { languageChange$, t: (key: string) => key }
        const config = { store: { tmuxPlugin: { showWindowCloseButton: true } } }
        const WindowBar = WindowBarComponent as new (...args: unknown[]) => WindowBarTestInstance
        const component = new WindowBar(
            { detectChanges: vi.fn() },
            config,
            { popupContextMenu: vi.fn() },
            i18n,
        )
        return { component, languageChange$ }
    }

    describe('template contract', () => {
        const template = extractBlock('template')
        const styles = extractBlock('styles')

        /** Markup of the scrolling window strip, without the buttons. */
        function stripMarkup(): string {
            const start = template.indexOf('class="window-tabs"')
            const addButton = template.indexOf('add-btn')
            const actions = template.indexOf('class="bar-actions"')
            expect(start).toBeGreaterThan(-1)
            expect(addButton).toBeGreaterThan(start)
            expect(actions).toBeGreaterThan(addButton)
            return template.slice(start, addButton)
        }

        it('keeps the new-window and exit buttons outside the scrolling strip', () => {
            expect(stripMarkup()).not.toContain('createWindow.emit()')
            expect(stripMarkup()).not.toContain('disconnect.emit()')
            expect(template.slice(template.indexOf('add-btn'))).toContain('createWindow.emit()')
            expect(template.slice(template.indexOf('class="bar-actions"'))).toContain(
                'disconnect.emit()',
            )
        })

        it('keeps the new-window button right after the strip, next to the last tab', () => {
            // strip → + → pinned exit button, so with few windows the + sits
            // exactly where it always did instead of jumping to the far right
            expect(template.indexOf('class="bar-actions"')).toBeGreaterThan(
                template.indexOf('add-btn'),
            )
            expect(stripMarkup()).not.toContain('add-btn')
        })

        it('renders every window tab inside the scrolling strip', () => {
            expect(stripMarkup()).toContain('*ngFor="let win of windows"')
            expect(stripMarkup()).toContain('[attr.data-window-id]="win.id"')
        })

        it('never wraps the bar or the strip', () => {
            expect(styles).toMatch(/\.window-bar\s*{[^}]*flex-wrap:\s*nowrap/)
            expect(styles).toMatch(/\.window-tabs\s*{[^}]*flex-wrap:\s*nowrap/)
        })

        it('scrolls the strip horizontally without shrinking the tabs', () => {
            expect(styles).toMatch(/\.window-tabs\s*{[^}]*overflow-x:\s*auto/)
            expect(styles).toMatch(/\.window-tabs\s*{[^}]*min-width:\s*0/)
            expect(styles).toMatch(/\.window-tab\s*{[^}]*flex:\s*0 0 auto/)
            // the strip takes its content width, and gives it up (scrolls)
            // rather than pushing the + button out of view
            expect(styles).toMatch(/\.window-tabs\s*{[^}]*flex:\s*0 1 auto/)
        })

        it('pins the exit button to the right edge', () => {
            expect(styles).toMatch(/\.bar-actions\s*{[^}]*margin-left:\s*auto/)
            expect(styles).toMatch(/\.bar-actions\s*{[^}]*flex:\s*0 0 auto/)
            expect(styles).toMatch(/\.add-btn\s*{[^}]*flex:\s*0 0 auto/)
        })

        it('hides the native strip scrollbar so the bar height stays fixed', () => {
            expect(styles).toMatch(/\.window-tabs::-webkit-scrollbar\s*{[^}]*display:\s*none/)
            expect(styles).toMatch(/\.window-tabs\s*{[^}]*scrollbar-width:\s*none/)
        })
    })

    describe('horizontal scrolling', () => {
        it('scrolls the active tab into view when it is past the right edge', () => {
            const { component } = createComponent()
            const strip = createFakeStrip({
                scrollWidth: 900,
                clientWidth: 300,
                tab: { id: 7, offsetLeft: 500, offsetWidth: 72 },
            })
            component.activeWindowId = 7
            component.tabsEl = { nativeElement: strip }

            component.revealActiveWindow()

            expect(strip.scrollLeft).toBe(272)
        })

        it('scrolls back when the active tab sits before the viewport', () => {
            const { component } = createComponent()
            const strip = createFakeStrip({
                scrollLeft: 400,
                scrollWidth: 900,
                clientWidth: 300,
                tab: { id: 2, offsetLeft: 100, offsetWidth: 72 },
            })
            component.activeWindowId = 2
            component.tabsEl = { nativeElement: strip }

            component.revealActiveWindow()

            expect(strip.scrollLeft).toBe(100)
        })

        it('leaves a visible active tab untouched', () => {
            const { component } = createComponent()
            const strip = createFakeStrip({
                scrollLeft: 100,
                scrollWidth: 900,
                clientWidth: 300,
                tab: { id: 3, offsetLeft: 150, offsetWidth: 72 },
            })
            component.activeWindowId = 3
            component.tabsEl = { nativeElement: strip }

            component.revealActiveWindow()

            expect(strip.scrollLeft).toBe(100)
        })

        it('does nothing without a controller window or a rendered strip', () => {
            const { component } = createComponent()
            component.activeWindowId = null

            expect(() => component.revealActiveWindow()).not.toThrow()
            expect(() => component.updateScrollHints()).not.toThrow()
            expect(() => component.onTabsWheel({ deltaY: 10 } as WheelEvent)).not.toThrow()

            const strip = createFakeStrip({ scrollWidth: 900, clientWidth: 300 })
            component.tabsEl = { nativeElement: strip }
            component.revealActiveWindow()

            expect(strip.scrollLeft).toBe(0)
        })

        it('toggles the edge fade classes from the strip metrics', () => {
            const { component } = createComponent()
            const strip = createFakeStrip({ scrollWidth: 900, clientWidth: 300 })
            component.tabsEl = { nativeElement: strip }

            component.updateScrollHints()
            expect(strip.classList.has('can-scroll-left')).toBe(false)
            expect(strip.classList.has('can-scroll-right')).toBe(true)

            strip.scrollLeft = 600
            component.updateScrollHints()
            expect(strip.classList.has('can-scroll-left')).toBe(true)
            expect(strip.classList.has('can-scroll-right')).toBe(false)
        })

        it('converts a vertical wheel into horizontal scrolling', () => {
            const { component } = createComponent()
            const strip = createFakeStrip({ scrollWidth: 900, clientWidth: 300 })
            component.tabsEl = { nativeElement: strip }
            const event = { deltaX: 0, deltaY: 40, deltaMode: 0, preventDefault: vi.fn() }

            component.onTabsWheel(event as unknown as WheelEvent)

            expect(strip.scrollLeft).toBe(40)
            expect(event.preventDefault).toHaveBeenCalled()
        })

        it('keeps the wheel event for the terminal at the end of the strip', () => {
            const { component } = createComponent()
            const strip = createFakeStrip({ scrollLeft: 600, scrollWidth: 900, clientWidth: 300 })
            component.tabsEl = { nativeElement: strip }
            const event = { deltaX: 0, deltaY: 40, deltaMode: 0, preventDefault: vi.fn() }

            component.onTabsWheel(event as unknown as WheelEvent)

            expect(strip.scrollLeft).toBe(600)
            expect(event.preventDefault).not.toHaveBeenCalled()
        })

        it('keeps the wheel event for the terminal at the start of the strip', () => {
            const { component } = createComponent()
            const strip = createFakeStrip({ scrollLeft: 0, scrollWidth: 900, clientWidth: 300 })
            component.tabsEl = { nativeElement: strip }
            const event = { deltaX: 0, deltaY: -40, deltaMode: 0, preventDefault: vi.fn() }

            component.onTabsWheel(event as unknown as WheelEvent)

            expect(strip.scrollLeft).toBe(0)
            expect(event.preventDefault).not.toHaveBeenCalled()
        })

        it('ignores the wheel when the window list fits', () => {
            const { component } = createComponent()
            const strip = createFakeStrip({ scrollWidth: 120, clientWidth: 300 })
            component.tabsEl = { nativeElement: strip }
            const event = { deltaX: 0, deltaY: 40, deltaMode: 0, preventDefault: vi.fn() }

            component.onTabsWheel(event as unknown as WheelEvent)

            expect(strip.scrollLeft).toBe(0)
            expect(event.preventDefault).not.toHaveBeenCalled()
        })
    })

    describe('view lifecycle', () => {
        it('subscribes to strip scrolling and releases it again', () => {
            const { component } = createComponent()
            const strip = createFakeStrip({ scrollWidth: 900, clientWidth: 300 })
            component.tabsEl = { nativeElement: strip }

            component.ngAfterViewInit()
            expect(strip.addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function), {
                passive: true,
            })

            const listener = strip.addEventListener.mock.calls[0][1] as () => void
            strip.scrollLeft = 600
            listener()
            expect(strip.classList.has('can-scroll-left')).toBe(true)

            component.ngOnDestroy()
            expect(strip.removeEventListener).toHaveBeenCalledWith('scroll', listener)
        })

        it('reveals the active window after the tab list changes', () => {
            vi.useFakeTimers()
            try {
                const { component } = createComponent()
                const strip = createFakeStrip({
                    scrollWidth: 900,
                    clientWidth: 300,
                    tab: { id: 9, offsetLeft: 500, offsetWidth: 72 },
                })
                component.activeWindowId = 9
                component.tabsEl = { nativeElement: strip }
                component.controller = {
                    events: new Subject(),
                    getAllWindowStates: () => [{ id: 9, name: 'logs', panes: new Set<number>() }],
                    getActivePaneId: () => null,
                    getPaneTitle: () => '',
                }

                component.refreshWindows()
                expect(strip.scrollLeft).toBe(0)

                vi.runAllTimers()
                expect(strip.scrollLeft).toBe(272)
            } finally {
                vi.useRealTimers()
            }
        })

        it('does not drag the strip back on unrelated refreshes', () => {
            vi.useFakeTimers()
            try {
                const { component } = createComponent()
                const strip = createFakeStrip({
                    scrollWidth: 900,
                    clientWidth: 300,
                    tab: { id: 9, offsetLeft: 500, offsetWidth: 72 },
                })
                component.activeWindowId = 9
                component.tabsEl = { nativeElement: strip }
                component.controller = {
                    events: new Subject(),
                    getAllWindowStates: () => [{ id: 9, name: 'logs', panes: new Set<number>() }],
                    getActivePaneId: () => null,
                    getPaneTitle: () => '',
                }

                component.refreshWindows()
                vi.runAllTimers()

                // user scrolls away, then an unrelated pane event refreshes the list
                strip.scrollLeft = 0
                component.refreshWindows()
                vi.runAllTimers()

                expect(strip.scrollLeft).toBe(0)
            } finally {
                vi.useRealTimers()
            }
        })

        it('reveals the active window when the active window input changes', () => {
            vi.useFakeTimers()
            try {
                const { component } = createComponent()
                const strip = createFakeStrip({
                    scrollWidth: 900,
                    clientWidth: 300,
                    tab: { id: 4, offsetLeft: 500, offsetWidth: 72 },
                })
                component.activeWindowId = 4
                component.tabsEl = { nativeElement: strip }

                component.ngOnChanges({ activeWindowId: { currentValue: 4 } })
                vi.runAllTimers()

                expect(strip.scrollLeft).toBe(272)
            } finally {
                vi.useRealTimers()
            }
        })
    })
})
