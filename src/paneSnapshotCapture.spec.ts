import { describe, expect, it, vi } from 'vitest'
import type { ConfigService, Logger } from 'tabby-core'
import type { Injector } from '@angular/core'
import { TmuxController, TmuxPaneSession } from './session'

vi.mock('tabby-terminal', async () => import('../test-support/sessionMocks'))

function state(alternate = false, history = 0, rows = 3): string {
    return (
        `pane_id=%1\talternate_on=${Number(alternate)}\t` +
        `cursor_x=0\tcursor_y=0\tpane_width=12\tpane_height=${rows}\t` +
        `history_size=${history}\talternate_saved_x=5\talternate_saved_y=0`
    )
}

function setup(
    respond: (command: string) => string | Promise<string>,
    historyRestoreLimit?: unknown,
) {
    const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    } as unknown as Logger
    const controller = new TmuxController(
        logger,
        null as unknown as Injector,
        () => undefined,
        () => undefined,
        { store: { tmuxPlugin: { historyRestoreLimit } } } as ConfigService,
    )
    const commands = vi
        .spyOn(controller.gateway, 'sendCommand')
        .mockImplementation(async (command, _flags, onSuccess) => {
            const response = await respond(command)
            onSuccess?.()
            return response
        })
    vi.spyOn(controller.gateway, 'sendCommands').mockImplementation((requests) =>
        Promise.all(
            requests.map(({ command, flags, onSuccess }) =>
                controller.gateway.sendCommand(command, flags, onSuccess),
            ),
        ),
    )
    return { controller, commands, logger }
}

describe('pane snapshot capture', () => {
    it.each([
        { limit: undefined, expected: 5000 },
        { limit: 1, expected: 1 },
        { limit: 1234, expected: 1234 },
        { limit: -1, expected: 5000 },
        { limit: Number.MAX_SAFE_INTEGER, expected: 5000 },
        { limit: '1; kill-server', expected: 5000 },
    ])(
        'captures only the last $expected history rows for limit=$limit',
        async ({ limit, expected }) => {
            const { controller, commands } = setup((command) => {
                if (command.startsWith('list-panes')) return state(false, 50000)
                if (command.includes('-E0')) return 'history tail\nscreen'
                if (command.includes('-E-1')) return 'history tail'
                return 'screen\n\n'
            }, limit)
            expect(await controller.ensurePaneSnapshot(1)).toBe(true)
            const captures = commands.mock.calls
                .map(([command]) => command)
                .filter((command) => command.startsWith('capture'))
            expect(captures).toEqual([
                `capture-pane -peJN -S-${expected} -E-1 -t %1`,
                'capture-pane -peJN -S-1 -E0 -t %1',
                'capture-pane -peJN -S0 -t %1',
            ])
        },
    )

    it.each([false, true])(
        'captures both screens without history for limit=0, alternate=%s',
        async (alternate) => {
            const { controller, commands } = setup(
                (command) =>
                    command.startsWith('list-panes') ? state(alternate, 50000) : 'screen\n\n',
                0,
            )
            expect(await controller.ensurePaneSnapshot(1)).toBe(true)
            const captures = commands.mock.calls
                .map(([command]) => command)
                .filter((command) => command.startsWith('capture'))
            expect(captures).toEqual(
                alternate
                    ? ['capture-pane -peJN -a -S0 -t %1', 'capture-pane -peN -S0 -t %1']
                    : ['capture-pane -peJN -S0 -t %1'],
            )
        },
    )
    it('accepts cursor/history changes from normal output without retransmitting large history', async () => {
        let reads = 0
        const { controller, commands } = setup((command) => {
            if (command.startsWith('list-panes')) {
                return state(false, ++reads === 1 ? 50000 : 50001).replace(
                    'cursor_x=0',
                    `cursor_x=${reads}`,
                )
            }
            if (command.includes('-S-1')) return 'history tail\nfirst row'
            if (command.includes('-E-1')) return 'full history'
            return 'first row\nlast row\n'
        })
        expect(await controller.ensurePaneSnapshot(1)).toBe(true)
        expect(commands.mock.calls.filter(([command]) => command.includes('-E-1'))).toHaveLength(1)
        expect(reads).toBe(2)
        const session = new TmuxPaneSession({ warn: vi.fn() } as unknown as Logger, controller, 1)
        const output: string[] = []
        session.output$.subscribe((data) => output.push(data.toString()))
        await controller.restorePaneHistory(1)
        expect(output.join('')).toContain('\x1b[1;3H')
    })

    it.each([true, false])(
        'detects history/screen soft wrap=%s from only two boundary rows',
        async (wrapped) => {
            const { controller, commands } = setup((command) => {
                if (command.startsWith('list-panes')) return state(false, 50000)
                if (command.includes('-S-1')) return wrapped ? 'tailfirst' : 'tail\nfirst'
                if (command.includes('-E-1')) return 'history tail'
                return 'first\nsecond\n'
            })
            await controller.ensurePaneSnapshot(1)
            const session = new TmuxPaneSession(
                { warn: vi.fn() } as unknown as Logger,
                controller,
                1,
            )
            const output: string[] = []
            session.output$.subscribe((data) => output.push(data.toString()))
            await controller.restorePaneHistory(1)
            expect(output.join('')).toContain(
                wrapped ? 'history tail\x1b[0m\x1b[0mfirst' : 'history tail\x1b[0m\r\n\x1b[0mfirst',
            )
            expect(commands.mock.calls.some(([command]) => command.includes('-S- -E0'))).toBe(false)
        },
    )

    it('does not enqueue more captures after a transport timeout', async () => {
        const { controller, commands } = setup((command) => {
            if (command.startsWith('list-panes')) return state(false, 50000)
            throw new Error('Command timed out after 30000ms')
        })
        expect(await controller.ensurePaneSnapshot(1)).toBe(false)
        expect(commands.mock.calls.filter(([command]) => command.includes('-E-1'))).toHaveLength(1)
    })

    it('serializes concurrent captures and shares concurrent requests for one pane', async () => {
        let release: (value: string) => void
        let paused = true
        const { controller, commands } = setup((command) => {
            const pane = Number(command.match(/%([12])/)?.[1])
            if (command.startsWith('list-panes'))
                return state().replace('pane_id=%1', `pane_id=%${pane}`)
            if (pane === 1 && paused)
                return new Promise((resolve) => {
                    release = resolve
                })
            return 'frame\n\n'
        })
        const first = controller.ensurePaneSnapshot(1)
        const shared = controller.ensurePaneSnapshot(1)
        const second = controller.ensurePaneSnapshot(2)
        await vi.waitFor(() => expect(release).toBeDefined())
        expect(commands.mock.calls.some(([command]) => command.includes('%2'))).toBe(false)
        paused = false
        release('frame\n\n')
        expect(await Promise.all([first, shared, second])).toEqual([true, true, true])
        expect(
            commands.mock.calls.filter(([command]) => command === 'capture-pane -peJN -S0 -t %1'),
        ).toHaveLength(1)
    })

    it('restores the active window before a slow background window', async () => {
        let releaseBackground: (value: string) => void
        const { controller } = setup((command) => {
            if (command.startsWith('list-windows'))
                return '@0 background 0 0 aa,12x3,0,0,1 - aa,12x3,0,0,1\n@1 active 1 1 aa,12x3,0,0,2 * aa,12x3,0,0,2'
            if (command.startsWith('list-panes -s')) return '%1 @0 1\n%2 @1 1'
            if (command.startsWith('list-panes'))
                return state().replace(
                    'pane_id=%1',
                    command.includes('%2') ? 'pane_id=%2' : 'pane_id=%1',
                )
            if (command.startsWith('capture') && command.includes('%1'))
                return new Promise((resolve) => {
                    releaseBackground = resolve
                })
            return 'frame\n\n'
        })
        controller.setClientSizePushed()
        const events: string[] = []
        controller.events.subscribe((event) => events.push(`${event.type}:${event.windowId}`))
        const discovering = controller.refreshPanes()
        await vi.waitFor(() => expect(releaseBackground).toBeDefined())
        expect(events).toContain('pane-add:1')
        expect(events).toContain('layout-change:1')
        expect(events).not.toContain('pane-add:0')
        releaseBackground('frame\n\n')
        await discovering
        expect(events).toContain('layout-change:0')
    })

    it('does not immediately repeat a failed discovery capture at pane start', async () => {
        const { controller, commands } = setup((command) => {
            if (command.startsWith('list-windows'))
                return '@0 main 0 1 aa,12x3,0,0,1 * aa,12x3,0,0,1'
            if (command.startsWith('list-panes -s')) return '%1 @0 1'
            if (command.startsWith('list-panes')) return state()
            if (command.startsWith('capture')) throw new Error('capture failed')
            return ''
        })
        controller.setClientSizePushed()
        await controller.refreshPanes()
        const before = commands.mock.calls.length
        const session = new TmuxPaneSession({ warn: vi.fn() } as unknown as Logger, controller, 1)
        const starting = session.start()
        session.gridApplied()
        await starting
        expect(commands).toHaveBeenCalledTimes(before)
    })

    it('publishes split panes together after every snapshot in that window is ready', async () => {
        let releaseSecond: (value: string) => void
        const { controller } = setup((command) => {
            if (command.startsWith('list-windows'))
                return '@0 main 0 1 aa,12x3,0,0{6x3,0,0,1,5x3,7,0,2} * aa,12x3,0,0{6x3,0,0,1,5x3,7,0,2}'
            if (command.startsWith('list-panes -s')) return '%1 @0 1\n%2 @0 0'
            if (command.startsWith('list-panes'))
                return state().replace(
                    'pane_id=%1',
                    command.includes('%2') ? 'pane_id=%2' : 'pane_id=%1',
                )
            if (command.startsWith('capture') && command.includes('%2'))
                return new Promise((resolve) => {
                    releaseSecond = resolve
                })
            return 'frame\n\n'
        })
        controller.setClientSizePushed()
        const events: string[] = []
        controller.events.subscribe((event) => events.push(event.type))
        const discovering = controller.refreshPanes()
        await vi.waitFor(() => expect(releaseSecond).toBeDefined())
        expect(controller.hasPendingSnapshot(1)).toBe(true)
        expect(events).not.toContain('pane-add')
        expect(events).not.toContain('layout-change')
        releaseSecond('frame\n\n')
        await discovering
        expect(events.filter((type) => type === 'pane-add' || type === 'layout-change')).toEqual([
            'pane-add',
            'pane-add',
            'layout-change',
        ])
    })
    it('does not capture nonexistent history or request -a in normal mode', async () => {
        const { controller, commands } = setup((command) =>
            command.startsWith('list-panes') ? state() : 'shell\n\n',
        )
        expect(await controller.ensurePaneSnapshot(1)).toBe(true)
        expect(
            commands.mock.calls.map(([command]) => command).filter((c) => c.startsWith('capture')),
        ).toEqual(['capture-pane -peJN -S0 -t %1'])
        expect(
            commands.mock.calls.filter(([command]) => command.startsWith('list-panes')),
        ).toHaveLength(2)
    })

    it('keeps saved normal and active Vim captures in their correct buffers', async () => {
        const { controller, commands } = setup((command) => {
            if (command.startsWith('list-panes')) return state(true, 1)
            if (command.includes('-E-1')) return 'history'
            if (command.includes('-E0')) return 'history\nVIM'
            if (command.includes('-a ')) return 'shell$ vim\n\n'
            return 'VIM\neditor\nstatus'
        })
        await controller.ensurePaneSnapshot(1)
        const session = new TmuxPaneSession({ warn: vi.fn() } as unknown as Logger, controller, 1)
        const output: string[] = []
        session.output$.subscribe((data) => output.push(data.toString()))
        const starting = session.start()
        session.gridApplied()
        await starting
        const [normal, alternate] = output.join('').split('\x1b[?1049h')
        expect(normal).toContain('history\x1b[0m\r\n')
        expect(normal).toContain('shell$ vim')
        expect(normal).not.toContain('VIM')
        expect(alternate).toContain('VIM')
        expect(alternate).not.toContain('shell$ vim')
        expect(commands.mock.calls.every(([, flags]) => !flags)).toBe(true)
    })

    it('does not consume a snapshot inside a fragmented live title sequence', async () => {
        const { controller, logger } = setup((command) =>
            command.startsWith('list-panes') ? state() : 'shell frame\n\n',
        )
        controller.gateway.output$.next({ paneId: 1, data: Buffer.from('\x1bkunfinished title') })
        await controller.ensurePaneSnapshot(1)
        const session = new TmuxPaneSession(logger, controller, 1)
        const output: string[] = []
        session.output$.subscribe((data) => output.push(data.toString()))
        const starting = session.start()
        session.gridApplied()
        await starting
        expect(output.join('')).toContain('shell frame')

        controller.gateway.output$.next({ paneId: 1, data: Buffer.from(' end\x1b\\after title') })
        expect(output[output.length - 1]).toBe('after title')
        expect(output.join('')).not.toContain('unfinished title')
    })

    it('retries if Vim exits between frame capture and the closing state fence', async () => {
        const states = [state(true), state(false), state(false), state(false)]
        const { controller, commands } = setup((command) => {
            if (command.startsWith('list-panes')) return states.shift()
            return command.includes('-peN ') ? 'old Vim\n\n' : 'current shell\n\n'
        })
        expect(await controller.ensurePaneSnapshot(1)).toBe(true)
        const requests = commands.mock.calls.map(([command]) => command)
        expect(requests.filter((c) => c.startsWith('list-panes'))).toHaveLength(4)
        expect(requests.filter((c) => c.includes('-a '))).toHaveLength(1)
    })

    it('retries if the pane changes size during capture', async () => {
        const states = [
            state(false, 0, 3),
            state(false, 0, 4),
            state(false, 0, 4),
            state(false, 0, 4),
        ]
        const { controller, commands } = setup((command) =>
            command.startsWith('list-panes') ? states.shift() : 'shell\n\n\n',
        )
        expect(await controller.ensurePaneSnapshot(1)).toBe(true)
        expect(
            commands.mock.calls.filter(([command]) => command.startsWith('list-panes')),
        ).toHaveLength(4)
    })

    it('rejects invalid or missing pane geometry instead of rendering a fake frame', async () => {
        const { controller, commands } = setup(() => 'pane_id=%1\tpane_width=\tpane_height=')
        expect(await controller.ensurePaneSnapshot(1)).toBe(false)
        expect(commands).toHaveBeenCalledTimes(1)
    })

    it("does not give an unmounted pane's in-flight snapshot to its replacement", async () => {
        let finishCapture: (value: string) => void
        const { controller, commands } = setup((command) =>
            command.startsWith('list-panes')
                ? state()
                : new Promise((resolve) => (finishCapture = resolve)),
        )
        const session = new TmuxPaneSession({ warn: vi.fn() } as unknown as Logger, controller, 1)
        const capturing = controller.ensurePaneSnapshot(1, true)
        await vi.waitFor(() =>
            expect(commands.mock.calls.some(([command]) => command.startsWith('capture'))).toBe(
                true,
            ),
        )
        await session.destroy()
        new TmuxPaneSession({ warn: vi.fn() } as unknown as Logger, controller, 1)
        finishCapture('old screen\n\n')
        expect(await capturing).toBe(false)
        expect(controller.hasPendingSnapshot(1)).toBe(false)
    })

    it('rejects capture errors and preserves live output when no snapshot succeeds', async () => {
        const { controller } = setup((command) => {
            if (command.startsWith('list-panes')) return state()
            return Promise.reject(new Error('capture failed'))
        })
        controller.gateway.output$.next({ paneId: 1, data: Buffer.from('live output') })
        const session = new TmuxPaneSession({ warn: vi.fn() } as unknown as Logger, controller, 1)
        const output: string[] = []
        session.output$.subscribe((data) => output.push(data.toString()))
        const starting = session.start()
        session.gridApplied()
        await starting
        expect(output).toEqual(['live output'])
        expect(controller.hasPendingSnapshot(1)).toBe(false)
    })
})
