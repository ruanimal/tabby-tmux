import { describe, expect, it, vi } from 'vitest'
import type { ConfigService, Logger } from 'tabby-core'
import type { Injector } from '@angular/core'
import { TmuxController, TmuxPaneSession } from './session'

// tabby-terminal is an Angular partially-compiled package; loading it in Node
// requires the Angular linker/JIT compiler, so stub BaseSession instead. The
// fake class mirrors the members TmuxPaneSession actually uses.
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
    return { BaseSession: MockBaseSession }
})

function createLoggerMock() {
    return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    } as unknown as Logger
}

describe('TmuxPaneSession', () => {
    function createSession() {
        const logger = createLoggerMock()
        const controller = {
            registerPane: vi.fn(),
            unregisterPane: vi.fn(),
            restorePaneHistory: vi.fn().mockResolvedValue(undefined),
            writeToPane: vi.fn(),
        } as unknown as TmuxController
        const session = new TmuxPaneSession(logger, controller, 5)
        return { session, controller, logger }
    }

    /** Drive the session through its normal startup so _gridDone is true. */
    async function startSession(
        session: TmuxPaneSession,
    ): Promise<{ emitted: Array<Buffer | string> }> {
        const emitted: Array<Buffer | string> = []
        session.output$.subscribe((d) => emitted.push(d))
        const startPromise = session.start()
        session.gridApplied()
        await startPromise
        return { emitted }
    }

    it('registers itself with the controller on construction', () => {
        const { controller } = createSession()
        expect(controller.registerPane).toHaveBeenCalledTimes(1)
        const session = vi.mocked(controller.registerPane).mock.calls[0][1]
        expect(session).toBeInstanceOf(TmuxPaneSession)
    })

    it('buffers output until the grid is applied, then flushes in order', async () => {
        const { session } = createSession()
        const emitted: Array<Buffer | string> = []
        session.output$.subscribe((d) => emitted.push(d))

        session.feedOutput(Buffer.from('a'))
        session.feedOutput(Buffer.from('b'))
        expect(emitted).toEqual([])

        const startPromise = session.start()
        session.gridApplied()
        await startPromise

        expect(emitted.map((b) => b.toString())).toEqual(['a', 'b'])
    })

    it('emits output directly once the grid is done', async () => {
        const { session } = createSession()
        const { emitted } = await startSession(session)
        session.feedOutput(Buffer.from('c'))
        expect(emitted.map((b) => b.toString())).toEqual(['c'])
    })

    it('strips screen title sequences (ESC k ... ESC \\) from output', async () => {
        const { session } = createSession()
        const { emitted } = await startSession(session)
        session.feedOutput(Buffer.from('\x1bktitle\x1b\\world'))
        expect(emitted.map((b) => b.toString())).toEqual(['world'])
    })

    it('buffers a title sequence split across feedOutput calls', async () => {
        const { session } = createSession()
        const { emitted } = await startSession(session)

        // First chunk ends with a bare ESC (start of the ESC k pair)
        session.feedOutput(Buffer.from('a\x1b'))
        expect(emitted.map((b) => b.toString())).toEqual(['a'])

        // Second chunk completes ESC k ... ESC \
        session.feedOutput(Buffer.from('ktitle\x1b\\b'))
        expect(emitted.map((b) => b.toString())).toEqual(['a', 'b'])
    })

    it('strips multiple title sequences in one chunk', async () => {
        const { session } = createSession()
        const { emitted } = await startSession(session)
        session.feedOutput(Buffer.from('\x1bkt1\x1b\\x\x1bkt2\x1b\\y'))
        expect(emitted.map((b) => b.toString())).toEqual(['xy'])
    })

    it('does not emit when the chunk is only a title sequence', async () => {
        const { session } = createSession()
        const { emitted } = await startSession(session)
        session.feedOutput(Buffer.from('\x1bktitle\x1b\\'))
        expect(emitted).toEqual([])
    })

    it('filters title sequences before buffering pre-grid output', async () => {
        const { session } = createSession()
        const emitted: Array<Buffer | string> = []
        session.output$.subscribe((d) => emitted.push(d))

        session.feedOutput(Buffer.from('\x1bktitle\x1b\\hello'))

        const startPromise = session.start()
        session.gridApplied()
        await startPromise

        expect(emitted.map((b) => b.toString())).toEqual(['hello'])
    })

    it('forwards write() to the controller', () => {
        const { session, controller } = createSession()
        session.write(Buffer.from('z'))
        expect(vi.mocked(controller.writeToPane)).toHaveBeenCalledWith(5, Buffer.from('z'))
    })

    it('resize() is a no-op', () => {
        const { session } = createSession()
        expect(() => session.resize(100, 50)).not.toThrow()
    })

    it('destroy() unregisters the pane and clears pending state', async () => {
        const { session, controller } = createSession()
        await session.destroy()
        expect(controller.unregisterPane).toHaveBeenCalledWith(5)
    })

    it('does not support working directory queries', async () => {
        const { session } = createSession()
        expect(session.supportsWorkingDirectory()).toBe(false)
        await expect(session.getWorkingDirectory()).resolves.toBeNull()
    })
})

describe('TmuxController', () => {
    function createController() {
        const written: string[] = []
        const writer = (data: string) => {
            written.push(data)
        }
        const logger = createLoggerMock()
        const closer = vi.fn()
        const configService = {
            store: { tmuxPlugin: { commandTimeoutMs: 30 } },
        } as unknown as ConfigService
        const controller = new TmuxController(
            logger,
            null as unknown as Injector,
            writer,
            closer,
            configService,
        )
        return { controller, written }
    }

    async function initController(controller: TmuxController): Promise<void> {
        const p = controller.gateway.sendCommand('list-windows')
        controller.gateway.executeData(Buffer.from('%begin 1 1 1\n%end 1\n'))
        await p
    }

    it('tracks the active pane per window via %window-pane-changed', async () => {
        const { controller } = createController()
        await initController(controller)
        expect(controller.getActivePaneId(1)).toBeNull()
        controller.gateway.executeLine('%window-pane-changed @1 %2')
        expect(controller.getActivePaneId(1)).toBe(2)
        expect(controller.getActivePaneId(2)).toBeNull()
    })

    it('tracks the active window via %session-window-changed', async () => {
        const { controller } = createController()
        await initController(controller)
        expect(controller.getActiveWindowId()).toBeNull()
        controller.gateway.executeLine('%session-window-changed $1 @3')
        expect(controller.getActiveWindowId()).toBe(3)
    })

    it('registers windows via %window-add and applies renames', async () => {
        const { controller } = createController()
        await initController(controller)
        controller.gateway.executeLine('%window-add @5')
        expect(controller.getFirstWindowId()).toBe(5)
        expect(controller.getAllWindowStates().map((w) => w.id)).toEqual([5])
        controller.gateway.executeLine('%window-renamed @5 work')
        expect(controller.getWindowState(5)?.name).toBe('work')
    })

    it('clears the active pane record on %pane-close', async () => {
        const { controller } = createController()
        await initController(controller)
        controller.gateway.executeLine('%window-pane-changed @1 %2')
        expect(controller.getActivePaneId(1)).toBe(2)
        controller.gateway.executeLine('%pane-close @1 %2')
        expect(controller.getActivePaneId(1)).toBeNull()
    })

    it('discovers panes and exposes them via getAllPaneIds', async () => {
        const { controller, written } = createController()
        controller.setClientSizePushed()

        const discover = controller.refreshPanes()
        await waitForWrite(written, (w) => w.some((x) => x.startsWith('list-windows')))
        controller.gateway.executeData(
            Buffer.from(
                '%begin 1 1 1\n@0 main 1 1234,80x24,0,0{40x24,0,0,1,40x24,41,0,2}\n%end 1\n',
            ),
        )
        await waitForWrite(written, (w) => w.some((x) => x.startsWith('list-panes')))
        controller.gateway.executeData(Buffer.from('%begin 1 2 1\n%1 @0 1\n%2 @0 0\n%end 2\n'))
        await discover

        expect(controller.getAllPaneIds()).toEqual([1, 2])
        expect(controller.getActivePaneId(0)).toBe(1)
        expect(controller.getActiveWindowId()).toBe(0)
        expect(controller.getFirstWindowId()).toBe(0)
    })

    it('tracks the zoomed pane from %layout-change and clears it on unzoom', async () => {
        const { controller } = createController()
        await initController(controller)
        controller.gateway.executeLine('%window-add @0')

        // Two-pane window: 200x25,0,0,0 → %0 and 200x24,0,26,1 → %1
        const layout = 'e553,200x50,0,0[200x25,0,0,0,200x24,0,26,1]'
        const zoomedLayout = 'ac9d,200x50,0,0,0'

        // Zoom %0 — visibleLayout is the single zoomed pane, flags *Z
        controller.gateway.executeLine(`%layout-change @0 ${layout} ${zoomedLayout} *Z`)
        expect(controller.getWindowState(0)?.zoomedPaneId).toBe(0)

        // Unzoom — flags lose Z, zoomedPaneId clears
        controller.gateway.executeLine(`%layout-change @0 ${layout} ${layout} *`)
        expect(controller.getWindowState(0)?.zoomedPaneId).toBeUndefined()

        // Multi-digit pane ids are parsed correctly
        controller.gateway.executeLine(`%layout-change @0 ${layout} ac9e,200x50,0,0,10 *Z`)
        expect(controller.getWindowState(0)?.zoomedPaneId).toBe(10)

        // Let the async layout discovery settle (capture commands time out
        // after commandTimeoutMs=30 and are swallowed by their try/catch).
        await new Promise((resolve) => setTimeout(resolve, 80))
    })

    it('reports the pane count of the owning window for the zoom toggle', async () => {
        const { controller } = createController()
        controller.setClientSizePushed()
        await initController(controller)
        controller.gateway.executeLine('%window-add @0')
        expect(controller.getWindowPaneCount(9)).toBe(0)

        // Two-pane layout: 200x25,0,0,0 → %0 and 200x24,0,26,1 → %1
        const layout = 'e553,200x50,0,0[200x25,0,0,0,200x24,0,26,1]'
        controller.gateway.executeLine(`%layout-change @0 ${layout} ${layout} *`)
        expect(controller.getWindowPaneCount(0)).toBe(2)
        expect(controller.getWindowPaneCount(1)).toBe(2)
        expect(controller.getWindowPaneCount(42)).toBe(0)

        // A single-pane window reports 1 — the zoom toggle gets disabled.
        // Layout leaf format is checksum,WxH,X,Y,paneId (e.g. aa,80x24,0,0,5).
        controller.gateway.executeLine('%window-add @1')
        controller.gateway.executeLine('%layout-change @1 aa,80x24,0,0,5 aa,80x24,0,0,5 *')
        expect(controller.getWindowPaneCount(5)).toBe(1)

        await new Promise((resolve) => setTimeout(resolve, 80))
    })

    it('broadcasts synchronized input within the current window or all windows', async () => {
        const { controller } = createController()
        await initController(controller)

        // @1 owns panes %2, %3; @10 owns pane %4
        controller.gateway.executeLine('%window-add @1')
        controller.gateway.executeLine('%window-add @10')
        controller.gateway.executeLine(
            '%layout-change @1 e553,200x50,0,0[200x25,0,0,2,200x24,0,26,3]',
        )
        controller.gateway.executeLine('%layout-change @10 ac9d,200x50,0,0,4')

        // Default: sync off — no targets, source pane is unknown
        expect(controller.getSyncScope()).toBe('off')
        expect(controller.getWindowIdForPane(3)).toBe(1)
        expect(controller.getWindowIdForPane(99)).toBeNull()
        expect(controller.getSyncTargetPaneIds(2)).toEqual([])

        // 'window' scope: only panes of the same window (tmux synchronize-panes)
        controller.setSyncScope('window')
        expect(controller.getSyncScope()).toBe('window')
        expect(controller.getSyncTargetPaneIds(2)).toEqual([3])
        expect(controller.getSyncTargetPaneIds(3)).toEqual([2])
        // A single-pane window has no other pane to broadcast to
        expect(controller.getSyncTargetPaneIds(4)).toEqual([])

        // 'all' scope: every pane across all windows except the source
        controller.setSyncScope('all')
        expect(controller.getSyncTargetPaneIds(2)).toEqual([3, 4])
        expect(controller.getSyncTargetPaneIds(4)).toEqual([2, 3])

        // Unknown source pane: no targets regardless of scope
        expect(controller.getSyncTargetPaneIds(99)).toEqual([])

        // Toggling back off clears the targets
        controller.setSyncScope('off')
        expect(controller.getSyncTargetPaneIds(2)).toEqual([])

        // Let the async layout discovery settle (capture commands time out
        // after commandTimeoutMs=30 and are swallowed by their try/catch).
        await new Promise((resolve) => setTimeout(resolve, 80))
    })
})

async function waitForWrite(
    written: string[],
    predicate: (writes: string[]) => boolean,
    timeoutMs = 100,
): Promise<void> {
    const start = Date.now()
    while (!predicate(written)) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('Timed out waiting for gateway write')
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
}
