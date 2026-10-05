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
        protected logger: unknown
        constructor(logger: unknown) {
            this.open = true
            this.logger = logger
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

/** `list-panes -F` state response for pane %1 (see captureSnapshotForPane). */
const STATE_LINE =
    'pane_id=%1\talternate_on=0\tcursor_x=8\tcursor_y=1\tscroll_region_upper=0\t' +
    'scroll_region_lower=0\tcursor_flag=1\twrap_flag=1\tpane_height=24'

describe('TmuxPaneSession', () => {
    function createSession() {
        const logger = createLoggerMock()
        const controller = {
            registerPane: vi.fn(),
            unregisterPane: vi.fn(),
            restorePaneHistory: vi.fn().mockResolvedValue(undefined),
            writeToPane: vi.fn(),
            // A pre-loaded snapshot is available, so start() does not need to
            // capture a fresh one (that path is exercised in the controller
            // tests below / TmuxController pane snapshot lifecycle).
            hasPendingSnapshot: vi.fn().mockReturnValue(true),
            ensurePaneSnapshot: vi.fn().mockResolvedValue(true),
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

    it('still flushes pre-grid output when history restore fails', async () => {
        const { session, controller } = createSession()
        vi.mocked(controller.restorePaneHistory).mockRejectedValueOnce(new Error('boom'))

        const emitted: Array<Buffer | string> = []
        session.output$.subscribe((d) => emitted.push(d))
        session.feedOutput(Buffer.from('early-live-output'))

        const startPromise = session.start()
        session.gridApplied()
        // A failed restore must not reject (unhandled rejection used to leave
        // the pane blank with no diagnostic) ...
        await expect(startPromise).resolves.toBeUndefined()
        // ... and the buffered live output is still delivered.
        expect(emitted.map((b) => b.toString())).toEqual(['early-live-output'])
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

    it('discovers and caches the tmux server hostname', async () => {
        const { controller, written } = createController()
        const hostChanges: Array<{ hostName: string }> = []
        controller.events.subscribe((event) => {
            if (event.type === 'host-changed') {
                hostChanges.push(event.data)
            }
        })

        const refresh = controller.refreshHostName()
        await waitForWrite(written, (writes) => writes.includes('display-message -p "#{host}"\r'))
        controller.gateway.executeData(Buffer.from('%begin 1 1 1\npupu-MBP.local\n%end 1\n'))
        await refresh

        expect(controller.getHostName()).toBe('pupu-MBP.local')
        expect(hostChanges).toEqual([{ hostName: 'pupu-MBP.local' }])

        const writeCount = written.filter((write) =>
            write.startsWith('display-message -p "#{host}"'),
        ).length
        await controller.refreshHostName()
        expect(
            written.filter((write) => write.startsWith('display-message -p "#{host}"')).length,
        ).toBe(writeCount)
    })

    it('does not cache an empty hostname response', async () => {
        const { controller, written } = createController()
        const gateway = controller.gateway as unknown as {
            initialized: boolean
            acceptNotifications: boolean
        }
        gateway.initialized = true
        gateway.acceptNotifications = true

        const firstRefresh = controller.refreshHostName()
        await waitForWrite(written, (writes) => writes.includes('display-message -p "#{host}"\r'))
        controller.gateway.executeData(Buffer.from('%begin 1 1 1\n%end 1\n'))
        await firstRefresh
        expect(controller.getHostName()).toBe('')

        const secondRefresh = controller.refreshHostName()
        await waitForWrite(
            written,
            (writes) =>
                writes.filter((write) => write.startsWith('display-message -p "#{host}"'))
                    .length === 2,
        )
        controller.gateway.executeData(Buffer.from('%begin 1 2 1\nremote\n%end 2\n'))
        await secondRefresh
        expect(controller.getHostName()).toBe('remote')
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

    it('sends tmux commands for window and pane renames', async () => {
        const windowController = createController()
        const windowRename = windowController.controller.renameWindow(5, 'my "window"')
        await waitForWrite(windowController.written, (writes) =>
            writes.some((write) => write.startsWith('rename-window -t @5')),
        )
        windowController.controller.gateway.executeData(Buffer.from('%begin 1 1 1\n%end 1\n'))
        await windowRename
        expect(windowController.written).toContain('rename-window -t @5 "my \\"window\\""\r')

        const paneController = createController()
        const paneRename = paneController.controller.renamePane(7, 'editor')
        await waitForWrite(paneController.written, (writes) =>
            writes.some((write) => write.startsWith('select-pane -t %7 -T')),
        )
        paneController.controller.gateway.executeData(Buffer.from('%begin 1 1 1\n%end 1\n'))
        await paneRename
        expect(paneController.written).toContain('select-pane -t %7 -T "editor"\r')
        expect(paneController.controller.getPaneTitle(7)).toBe('editor')
    })

    it('sends kill-pane only for an explicit close request', async () => {
        const { controller, written } = createController()
        const kill = controller.killPane(5)

        await waitForWrite(written, (writes) => writes.includes('kill-pane -t %5\r'))
        controller.gateway.executeData(Buffer.from('%begin 1 1 1\n%end 1\n'))
        await kill

        expect(written).toContain('kill-pane -t %5\r')
    })

    it('sends kill-window only for an explicit close request', async () => {
        const { controller, written } = createController()
        const kill = controller.killWindow(3)

        await waitForWrite(written, (writes) => writes.includes('kill-window -t @3\r'))
        controller.gateway.executeData(Buffer.from('%begin 1 1 1\n%end 1\n'))
        await kill

        expect(written).toContain('kill-window -t @3\r')
    })

    it('does not kill panes when the controller is destroyed', async () => {
        const { controller, written } = createController()
        new TmuxPaneSession(createLoggerMock(), controller, 5)

        await controller.destroy()

        expect(written.filter((write) => write.includes('kill-pane'))).toEqual([])
        expect(controller.isPaneTracked(5)).toBe(false)
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
                '%begin 1 1 1\n@0 main 0 1 1234,80x24,0,0{40x24,0,0,1,40x24,41,0,2} * 1234,80x24,0,0{40x24,0,0,1,40x24,41,0,2}\n%end 1\n',
            ),
        )
        await waitForWrite(written, (w) => w.some((x) => x.startsWith('list-panes')))
        controller.gateway.executeData(
            Buffer.from('%begin 1 2 1\n%1 @0 1 editor\\ pane\n%2 @0 0\n%end 2\n'),
        )
        await discover

        expect(controller.getAllPaneIds()).toEqual([1, 2])
        expect(controller.getPaneTitle(1)).toBe('editor pane')
        expect(controller.getActivePaneId(0)).toBe(1)
        expect(controller.getActiveWindowId()).toBe(0)
        expect(controller.getFirstWindowId()).toBe(0)
    })

    it('orders windows by tmux index, not by Map insertion order', async () => {
        const { controller, written } = createController()
        controller.setClientSizePushed()

        // %window-add notifications (runtime windows, and attach on older tmux
        // versions) insert into the Map in ARRIVAL order, which is the window
        // ID order — @7 before @5 here. tmux's real display order is the index
        // order from list-windows (index 0 → @5, index 1 → @7). getAllWindowStates
        // must follow the index, otherwise the window bar shows the wrong order.
        controller.gateway.executeLine('%window-add @7')
        controller.gateway.executeLine('%window-add @5')

        const discover = controller.refreshPanes()
        await waitForWrite(written, (w) => w.some((x) => x.startsWith('list-windows')))
        controller.gateway.executeData(
            Buffer.from(
                '%begin 1 1 1\n@5 main 0 1 1234,80x24,0,0 * 1234,80x24,0,0\n@7 two 1 0 1235,80x24,0,0 * 1235,80x24,0,0\n%end 1\n',
            ),
        )
        await waitForWrite(written, (w) => w.some((x) => x.startsWith('list-panes')))
        controller.gateway.executeData(Buffer.from('%begin 1 2 1\n%1 @5 1\n%2 @7 0\n%end 2\n'))
        await discover

        // Insertion order is [7, 5]; index order is [5, 7].
        expect(controller.getAllWindowStates().map((w) => w.id)).toEqual([5, 7])
        expect(controller.getFirstWindowId()).toBe(5)
        expect(controller.getWindowState(5)?.index).toBe(0)
        expect(controller.getWindowState(7)?.index).toBe(1)
    })

    it('restores window order from a real attach message stream (index order)', async () => {
        const { controller, written } = createController()
        controller.setClientSizePushed()

        // Real message stream captured from `tmux -CC attach` (tmux 3.5a) to a
        // session whose windows are @0 idx0, @2 idx1, @1 idx2 (active). The DCS
        // start (\x1bP1000p) prefixes the first message; ST (\x1b\\) only
        // appears at session end, NOT after each message — an ST after the
        // attach block would leak into the next executeData() chunk.
        controller.gateway.executeData(
            Buffer.from(
                '\x1bP1000p%begin 1786610841 346 0\r\n' +
                    '%end 1786610841 346 0\r\n' +
                    '%session-changed $0 probe\r\n',
            ),
        )
        await waitForWrite(written, (w) => w.some((x) => x.startsWith('list-windows')))
        controller.gateway.executeData(
            Buffer.from(
                '%begin 1786610843 350 1\r\n' +
                    '@0 win0 0 0 b25d,80x24,0,0,0 * b25d,80x24,0,0,0\r\n' +
                    '@2 win2 1 0 b25f,80x24,0,0,2 * b25f,80x24,0,0,2\r\n' +
                    '@1 win1 2 1 b25e,80x24,0,0,1 * b25e,80x24,0,0,1\r\n' +
                    '%end 1786610843 350 1\r\n',
            ),
        )
        await waitForWrite(written, (w) => w.some((x) => x.startsWith('list-panes')))
        controller.gateway.executeData(
            Buffer.from('%begin 1 2 1\r\n%1 @0 1\r\n%2 @2 1\r\n%3 @1 1\r\n%end 2\r\n'),
        )
        await new Promise((r) => setTimeout(r, 20))

        // Window order follows tmux INDEX order (@0, @2, @1), not Map
        // insertion / window ID order (@0, @1, @2).
        expect(controller.getAllWindowStates().map((w) => w.id)).toEqual([0, 2, 1])
        expect(controller.getFirstWindowId()).toBe(0)
        expect(controller.getActiveWindowId()).toBe(1)
        expect(controller.getActivePaneId(0)).toBe(1)
        expect(controller.getAllPaneIds()).toEqual([1, 2, 3])
    })

    it('parses q:-escaped window names containing spaces from list-windows', async () => {
        const { controller, written } = createController()
        controller.setClientSizePushed()

        // tmux #{q:window_name} escapes a space in a name as `\ ` (e.g. "foo 1").
        // A space+digit name must not be misparsed: the digit after the first
        // unescaped space belongs to #{window_index}, not to the name.
        const discover = controller.refreshPanes()
        await waitForWrite(written, (w) => w.some((x) => x.startsWith('list-windows')))
        controller.gateway.executeData(
            Buffer.from(
                '%begin 1 1 1\n@0 foo\\ 1 0 0 1234,80x24,0,0,0 * 1234,80x24,0,0,0\n@1 2 1 1 1235,80x24,0,0,1 * 1235,80x24,0,0,1\n%end 1\n',
            ),
        )
        await waitForWrite(written, (w) => w.some((x) => x.startsWith('list-panes')))
        controller.gateway.executeData(Buffer.from('%begin 1 2 1\n%1 @0 1\n%2 @1 0\n%end 2\n'))
        await discover

        expect(controller.getWindowState(0)?.name).toBe('foo 1')
        expect(controller.getWindowState(0)?.index).toBe(0)
        expect(controller.getWindowState(1)?.name).toBe('2')
        expect(controller.getWindowState(1)?.index).toBe(1)
        // Active flag must land on @1 (index 1), not be shifted by the name's "1".
        expect(controller.getActiveWindowId()).toBe(1)
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

    it('restores zoom state from list-windows window_flags on reattach', async () => {
        const { controller, written } = createController()
        controller.setClientSizePushed()

        // tmux does NOT emit %layout-change on attach (verified on tmux 3.5a),
        // so zoom state must be recovered from the initial list-windows batch.
        // window_flags carries the Z flag when a window is zoomed;
        // window_visible_layout is the single zoomed-pane layout then.
        const discover = controller.refreshPanes()
        await waitForWrite(written, (w) => w.some((x) => x.startsWith('list-windows')))
        controller.gateway.executeData(
            Buffer.from(
                '%begin 1 1 1\n' +
                    '@0 two 0 1 e553,200x50,0,0[200x25,0,0,0,200x24,0,26,1] *Z ac9d,200x50,0,0,0\n' +
                    '%end 1\n',
            ),
        )
        await waitForWrite(written, (w) => w.some((x) => x.startsWith('list-panes')))
        controller.gateway.executeData(Buffer.from('%begin 1 2 1\n%0 @0 1\n%1 @0 0\n%end 2\n'))
        await discover

        // Zoom state is seeded from the Z flag: %0 is the zoomed pane and the
        // window reports isPaneZoomed(%0). The window-layout stays the real
        // multi-pane layout while visibleLayout is the single-pane zoom layout.
        expect(controller.getWindowState(0)?.zoomedPaneId).toBe(0)
        expect(controller.getWindowState(0)?.visibleLayout).toBe('ac9d,200x50,0,0,0')
        expect(controller.getWindowState(0)?.layout).toBe(
            'e553,200x50,0,0[200x25,0,0,0,200x24,0,26,1]',
        )
        expect(controller.isPaneZoomed(0)).toBe(true)

        // A non-zoomed window stays un-zoomed even without a %layout-change.
        const discover2 = controller.refreshPanes()
        await waitForWrite(written, (w) => w.some((x) => x.startsWith('list-windows')))
        controller.gateway.executeData(
            Buffer.from(
                '%begin 1 3 1\n' + '@1 single 1 1 aa,80x24,0,0,5 * aa,80x24,0,0,5\n' + '%end 1\n',
            ),
        )
        await waitForWrite(written, (w) => w.some((x) => x.startsWith('list-panes')))
        controller.gateway.executeData(Buffer.from('%begin 1 4 1\n%5 @1 1\n%end 2\n'))
        await discover2
        expect(controller.getWindowState(1)?.zoomedPaneId).toBeUndefined()
        expect(controller.isPaneZoomed(5)).toBe(false)
    })

    it('discovers pane titles for panes found in layout changes', async () => {
        const { controller, written } = createController()
        const controllerInternals = controller as unknown as {
            capturePaneSnapshots: (
                paneIds: Array<{ paneId: number; windowId: number }>,
            ) => Promise<boolean>
            discoverWindowsAndPanes: () => Promise<void>
            discoverPaneTitles: (windowId: number, paneIds: Set<number>) => Promise<void>
        }
        const paneRenameEvents: Array<{ paneId?: number; windowId?: number; data?: unknown }> = []
        controller.events.subscribe((event) => {
            if (event.type === 'pane-renamed') {
                paneRenameEvents.push(event)
            }
        })
        const capturePaneSnapshots = vi
            .spyOn(controllerInternals, 'capturePaneSnapshots')
            .mockResolvedValue(true)
        vi.spyOn(controllerInternals, 'discoverWindowsAndPanes').mockResolvedValue(undefined)
        await initController(controller)
        controller.gateway.executeLine('%window-add @0')

        controller.gateway.executeLine('%layout-change @0 aa,80x24,0,0,7 aa,80x24,0,0,7 *')
        await waitForWrite(written, (writes) =>
            writes.some((write) => write.startsWith('list-panes -t @0 -F')),
        )
        controller.gateway.executeData(Buffer.from('%begin 1 2 1\n%7 editor\\ pane\n%end 2\n'))

        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(controller.getPaneTitle(7)).toBe('editor pane')
        expect(capturePaneSnapshots).toHaveBeenCalledWith([{ paneId: 7, windowId: 0 }])

        const refreshTitle = controllerInternals.discoverPaneTitles(0, new Set([7]))
        await waitForWrite(
            written,
            (writes) =>
                writes.filter((write) => write.startsWith('list-panes -t @0 -F')).length === 2,
        )
        controller.gateway.executeData(Buffer.from('%begin 1 3 1\n%7 renamed\n%end 3\n'))
        await refreshTitle

        expect(controller.getPaneTitle(7)).toBe('renamed')
        expect(paneRenameEvents).toContainEqual({
            type: 'pane-renamed',
            paneId: 7,
            windowId: 0,
            data: { name: 'renamed' },
        })
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

    /**
     * Answer the attach-phase batch discovery for a single pane (@0 / %1),
     * mirroring what tmux emits for `tmux -CC attach`.
     */
    async function answerAttachDiscovery(
        controller: TmuxController,
        written: string[],
        history: string,
        stateStr: string = STATE_LINE,
    ): Promise<void> {
        await answerAttachDiscoveryRaw(
            controller,
            written,
            stateStr,
            `%begin 1 3 1\n${history}\n%end 3\n`,
        )
    }

    /**
     * Same as above, but with an explicit capture-pane response payload — used
     * to reproduce tmux's real byte shape (one line per captured ROW, with the
     * block terminator newline before %end).
     */
    async function answerAttachDiscoveryRaw(
        controller: TmuxController,
        written: string[],
        stateStr: string,
        historyPayload: string,
    ): Promise<void> {
        await waitForWrite(written, (w) => w.some((x) => x.startsWith('list-windows')))
        controller.gateway.executeData(
            Buffer.from('%begin 1 1 1\n@0 main 0 1 aa,80x24,0,0,1 * aa,80x24,0,0,1\n%end 1\n'),
        )
        await waitForWrite(written, (w) => w.some((x) => x.startsWith('list-panes')))
        controller.gateway.executeData(Buffer.from('%begin 1 2 1\n%1 @0 1\n%end 2\n'))
        await waitForWrite(written, (w) => w.some((x) => x.startsWith('capture-pane -peqJN -S-')))
        controller.gateway.executeData(Buffer.from(historyPayload))
        controller.gateway.executeData(Buffer.from('%begin 1 4 1\n%end 4\n'))
        controller.gateway.executeData(Buffer.from(`%begin 1 5 1\n${stateStr}\n%end 5\n`))

        // Discovery ends with the hostname query. Answer it so the response
        // queue stays aligned for the commands issued afterwards (a stale slot
        // would shift every later response by one).
        await waitForWrite(written, (w) =>
            w.some((x) => x.startsWith('display-message -p "#{host}"')),
        )
        controller.gateway.executeData(Buffer.from('%begin 1 6 1\nprobe.local\n%end 6\n'))
    }

    /**
     * Faithful `capture-pane` response: one line per captured row, each
     * terminated by CRLF, plus the block terminator newline before %end
     * (captured from tmux 3.4 via a control-mode client).
     */
    function captureRowsPayload(rows: string[]): string {
        return `%begin 1 3 1\r\n${rows.map((r) => `${r}\r\n`).join('')}\r\n%end 3\r\n`
    }

    /** `list-panes -F` state response with the given cursor/height. */
    function stateLine(cursorX: number, cursorY: number, rows = 24): string {
        return (
            `pane_id=%1\talternate_on=0\tcursor_x=${cursorX}\tcursor_y=${cursorY}\t` +
            `scroll_region_upper=0\tscroll_region_lower=0\tcursor_flag=1\twrap_flag=1\t` +
            `pane_height=${rows}`
        )
    }

    /** Answer the three capture commands of one snapshot, in queue order. */
    function answerSnapshot(
        controller: TmuxController,
        history: string,
        {
            altHistory = '',
            stateLine: stateStr = STATE_LINE,
        }: { altHistory?: string; stateLine?: string } = {},
    ): void {
        controller.gateway.executeData(Buffer.from(`%begin 1 3 1\n${history}\n%end 3\n`))
        controller.gateway.executeData(Buffer.from(`%begin 1 4 1\n${altHistory}\n%end 4\n`))
        controller.gateway.executeData(Buffer.from(`%begin 1 5 1\n${stateStr}\n%end 5\n`))
    }

    it('delivers output produced after the snapshot capture (issue #10)', async () => {
        const { controller, written } = createController()
        controller.setClientSizePushed()

        // Attach redraw, received before any pane tab (session) exists.
        controller.gateway.executeData(Buffer.from('%output %1 attach-screen\r\n'))

        const discover = controller.refreshPanes()
        await answerAttachDiscovery(controller, written, 'prompt$ ls')
        await discover

        // The pane keeps producing output while its window is NOT displayed:
        // the pane is only mounted when the user switches to that window.
        controller.gateway.executeData(Buffer.from('%output %1 POST-CAPTURE\r\n'))

        const session = new TmuxPaneSession(createLoggerMock(), controller, 1)
        const emitted: string[] = []
        session.output$.subscribe((d) => emitted.push(d.toString()))
        const startPromise = session.start()
        session.gridApplied()
        await startPromise

        const rendered = emitted.join('')
        // Snapshot content is restored ...
        expect(rendered).toContain('prompt$ ls')
        // ... and the output produced after the capture is NOT lost.
        expect(rendered).toContain('POST-CAPTURE')
        // ... while the chunks the snapshot already covers are not replayed.
        expect(rendered).not.toContain('attach-screen')
    })

    it('captures a fresh snapshot when the pre-loaded one is gone (issue #10)', async () => {
        const { controller, written } = createController()
        controller.setClientSizePushed()

        const discover = controller.refreshPanes()
        await answerAttachDiscovery(controller, written, 'stale-screen')
        await discover

        // First mount consumes the pre-loaded snapshot.
        const first = new TmuxPaneSession(createLoggerMock(), controller, 1)
        const firstStart = first.start()
        first.gridApplied()
        await firstStart
        await first.destroy()
        expect(controller.hasPendingSnapshot(1)).toBe(false)

        // Output produced between teardown and re-mount is buffered again.
        controller.gateway.executeData(Buffer.from('%output %1 LIVE-DURING-GAP\r\n'))

        // Re-mount: without a capture the pane would stay blank.
        const second = new TmuxPaneSession(createLoggerMock(), controller, 1)
        const emitted: string[] = []
        second.output$.subscribe((d) => emitted.push(d.toString()))
        const secondStart = second.start()
        second.gridApplied()
        await waitForWrite(
            written,
            (w) => w.filter((x) => x.startsWith('capture-pane -peqJN -S-')).length === 2,
        )
        answerSnapshot(controller, 'fresh-screen')
        await secondStart

        const rendered = emitted.join('')
        expect(rendered).toContain('fresh-screen')
        // The gap output is contained in the fresh snapshot: not replayed twice.
        expect(rendered).not.toContain('LIVE-DURING-GAP')
    })

    it("restores the pane's blank bottom row and tmux's cursor row", async () => {
        const { controller, written } = createController()
        controller.setClientSizePushed()

        // Real tmux 3.4 shape for a pane showing "a"/"b"/"c" and idling: the
        // capture returns all 24 screen rows (the trailing 21 blank) and the
        // pane's cursor sits on the blank row below "c" (cursor_x=0 cursor_y=3).
        const rows = ['a', 'b', 'c', ...Array.from({ length: 21 }, () => '')]
        const discover = controller.refreshPanes()
        await answerAttachDiscoveryRaw(
            controller,
            written,
            stateLine(0, 3),
            captureRowsPayload(rows),
        )
        await discover

        const session = new TmuxPaneSession(createLoggerMock(), controller, 1)
        const emitted: string[] = []
        session.output$.subscribe((d) => emitted.push(d.toString()))
        const startPromise = session.start()
        session.gridApplied()
        await startPromise

        const rendered = emitted.join('')
        // Every captured row is written — including the trailing blank one,
        // which is a real screen row (not a trailing-newline artifact).
        const text = rendered.slice(0, rendered.indexOf('\x1b'))
        expect(text.endsWith('\r\n')).toBe(true)
        expect(text.split('\r\n')).toHaveLength(rows.length + 1)
        // The cursor is placed on tmux's own row (blank row 4), not at the end
        // of "c" — otherwise the next output would be appended to it ("c…").
        expect(rendered.endsWith('\x1b[4;1H')).toBe(true)
    })

    it('does not merge replayed output into the last snapshot line', async () => {
        const { controller, written } = createController()
        controller.setClientSizePushed()

        // Streaming pane captured mid-run: 3 history rows + 24 screen rows
        // whose last content row is "896" and whose bottom row is blank
        // (tmux scrolls, so cursor_y stays on row 23 with cursor_x=0).
        const history = ['0', '1', '2']
        const screen = [...Array.from({ length: 23 }, (_, i) => String(874 + i)), '']
        const discover = controller.refreshPanes()
        await answerAttachDiscoveryRaw(
            controller,
            written,
            stateLine(0, 23),
            captureRowsPayload([...history, ...screen]),
        )
        await discover

        // Output produced after the capture; replayed when the pane is mounted.
        // tmux octal-escapes newlines inside %output (\015\012 = CR LF); the
        // real newline terminates the protocol line itself.
        controller.gateway.executeData(Buffer.from('%output %1 897\\015\\012\n'))

        const session = new TmuxPaneSession(createLoggerMock(), controller, 1)
        const emitted: string[] = []
        session.output$.subscribe((d) => emitted.push(d.toString()))
        const startPromise = session.start()
        session.gridApplied()
        await startPromise

        const rendered = emitted.join('')
        const text = rendered.slice(0, rendered.indexOf('\x1b'))
        expect(text.split('\r\n')).toHaveLength(history.length + screen.length + 1)

        // The replayed "897" must start on tmux's cursor row (the blank bottom
        // row 24). Restoring it at the end of the "896" line instead produces
        // "896897" on screen.
        const marker = '\x1b[24;1H'
        const markerIndex = rendered.lastIndexOf(marker)
        expect(markerIndex).toBeGreaterThan(-1)
        expect(rendered.slice(markerIndex + marker.length)).toBe('897\r\n')
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
