import { describe, expect, it, vi } from 'vitest'
import type { ConfigService, Logger } from 'tabby-core'
import { TMUX_COMMAND_TOLERATE_ERRORS, TmuxGateway } from './gateway'

function createGateway(options?: { timeoutMs?: number; chunkSize?: number }) {
    const written: string[] = []
    const writer = (data: string) => {
        written.push(data)
    }
    const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    } as unknown as Logger
    const configService = {
        store: {
            tmuxPlugin: {
                commandTimeoutMs: options?.timeoutMs ?? 30_000,
                sendKeysChunkSize: options?.chunkSize ?? 200,
            },
        },
    } as unknown as ConfigService
    const gateway = new TmuxGateway(logger, writer, configService)
    return { gateway, written, logger }
}

async function initGateway(gateway: TmuxGateway): Promise<void> {
    const p = gateway.sendCommand('list-windows')
    gateway.executeData(Buffer.from('%begin 1 1 1\n%end 1\n'))
    await p
}

describe('TmuxGateway sendCommand', () => {
    it('writes the command followed by CR', async () => {
        const { gateway, written } = createGateway()
        const p = gateway.sendCommand('list-windows')
        gateway.executeData(Buffer.from('%begin 1 1 1\nwin\n%end 1\n'))
        await expect(p).resolves.toBe('win')
        expect(written).toEqual(['list-windows\r'])
    })

    it('matches queued commands to responses in order', async () => {
        const { gateway } = createGateway()
        const p1 = gateway.sendCommand('list-windows')
        const p2 = gateway.sendCommand('list-panes')
        gateway.executeData(Buffer.from('%begin 1 1 1\nwin\n%end 1\n'))
        await expect(p1).resolves.toBe('win')
        gateway.executeData(Buffer.from('%begin 1 2 1\npane\n%end 2\n'))
        await expect(p2).resolves.toBe('pane')
    })

    it('rejects on %error without TOLERATE_ERRORS', async () => {
        const { gateway } = createGateway()
        const p = gateway.sendCommand('list-windows')
        gateway.executeData(Buffer.from('%begin 1 1 1\nbad\n%error 1\n'))
        await expect(p).rejects.toThrow('bad')
    })

    it('resolves on %error with TOLERATE_ERRORS', async () => {
        const { gateway } = createGateway()
        const p = gateway.sendCommand('list-windows', TMUX_COMMAND_TOLERATE_ERRORS)
        gateway.executeData(Buffer.from('%begin 1 1 1\nbad\n%error 1\n'))
        await expect(p).resolves.toBe('bad')
    })

    it('rejects when tmux does not respond within commandTimeoutMs', async () => {
        const { gateway } = createGateway({ timeoutMs: 30 })
        const p = gateway.sendCommand('list-windows')
        await expect(p).rejects.toThrow('Command timed out after 30ms')
    })

    it('throws after detach()', async () => {
        const { gateway, written } = createGateway()
        gateway.detach()
        gateway.detach()
        expect(written).toEqual(['detach\r'])
        await expect(gateway.sendCommand('x')).rejects.toThrow('Gateway disconnected')
    })

    it('throws after %exit', async () => {
        const { gateway } = createGateway()
        const exitSpy = vi.fn()
        gateway.exit$.subscribe(exitSpy)
        gateway.executeData(Buffer.from('%exit bye\n'))
        expect(exitSpy).toHaveBeenCalledWith('bye')
        await expect(gateway.sendCommand('x')).rejects.toThrow('Gateway disconnected')
    })

    it('emits initialized$ after the first response block', async () => {
        const { gateway } = createGateway()
        const initSpy = vi.fn()
        gateway.initialized$.subscribe(initSpy)
        const p = gateway.sendCommand('list-windows')
        gateway.executeData(Buffer.from('%begin 1 1 1\nok\n%end 1\n'))
        await p
        expect(initSpy).toHaveBeenCalledTimes(1)
    })

    it('dispatches %output inside a response block without polluting the response', async () => {
        const { gateway } = createGateway()
        await initGateway(gateway)
        const outputs: { paneId: number; data: Buffer }[] = []
        gateway.output$.subscribe((o) => outputs.push(o))
        const p = gateway.sendCommand('capture-pane')
        gateway.executeData(Buffer.from('%begin 1 2 1\n%output %1 \\141\n%end 2\n'))
        await expect(p).resolves.toBe('')
        expect(outputs).toHaveLength(1)
        expect(outputs[0].data.toString()).toBe('a')
    })
})

describe('TmuxGateway sendKeys', () => {
    it('encodes keystrokes as hex and writes directly', () => {
        const { gateway, written } = createGateway()
        gateway.sendKeys(Buffer.from('ab'), 5)
        expect(written).toEqual(['send-keys -t %5 -H 61 62\r'])
    })

    it('chunks long input by sendKeysChunkSize', () => {
        const { gateway, written } = createGateway({ chunkSize: 4 })
        gateway.sendKeys(Buffer.from([0x61, 0x62, 0x63]), 5)
        expect(written).toEqual(['send-keys -t %5 -H 61 62\r', 'send-keys -t %5 -H 63\r'])
    })

    it('does not write for empty input', () => {
        const { gateway, written } = createGateway()
        gateway.sendKeys(Buffer.alloc(0), 5)
        expect(written).toEqual([])
    })

    it('consumes %begin/%end of direct writes without a queued command', async () => {
        const { gateway } = createGateway()
        gateway.sendKeys(Buffer.from('a'), 1)
        gateway.executeData(Buffer.from('%begin 1 3 1\n%end 3\n'))
        // A subsequent queued command still matches its own response.
        const p = gateway.sendCommand('list-windows')
        gateway.executeData(Buffer.from('%begin 1 4 1\nwin\n%end 4\n'))
        await expect(p).resolves.toBe('win')
    })
})

describe('TmuxGateway executeLine notifications', () => {
    it('parses %output with octal decoding', async () => {
        const { gateway } = createGateway()
        await initGateway(gateway)
        const outputs: { paneId: number; data: Buffer }[] = []
        gateway.output$.subscribe((o) => outputs.push(o))
        gateway.executeLine('%output %1 \\141\\142')
        expect(outputs).toEqual([{ paneId: 1, data: Buffer.from('ab') }])
    })

    it('decodes multi-byte UTF-8 in %output', async () => {
        const { gateway } = createGateway()
        await initGateway(gateway)
        const outputs: { paneId: number; data: Buffer }[] = []
        gateway.output$.subscribe((o) => outputs.push(o))
        gateway.executeLine('%output %1 \\344\\270\\255')
        expect(outputs[0].data.toString('utf-8')).toBe('中')
    })

    it('parses %extended-output with latency in seconds', async () => {
        const { gateway } = createGateway()
        await initGateway(gateway)
        const outputs: { paneId: number; data: Buffer; latency?: number }[] = []
        gateway.output$.subscribe((o) => outputs.push(o))
        gateway.executeLine('%extended-output %1 250 : \\141')
        expect(outputs).toEqual([{ paneId: 1, data: Buffer.from('a'), latency: 0.25 }])
    })

    it('parses %layout-change with optional visible layout and zoom flag', async () => {
        const { gateway } = createGateway()
        await initGateway(gateway)
        const changes: { windowId: number; layout: string; visibleLayout?: string; zoomed?: boolean }[] =
            []
        gateway.layoutChange$.subscribe((c) => changes.push(c))
        gateway.executeLine('%layout-change @1 41e9,279x71,0,0[279x40,0,0,71]')
        gateway.executeLine('%layout-change @2 aa,80x24,0,0 bb,80x24,0,0 Z')
        expect(changes).toEqual([
            { windowId: 1, layout: '41e9,279x71,0,0[279x40,0,0,71]', visibleLayout: undefined, zoomed: undefined },
            { windowId: 2, layout: 'aa,80x24,0,0', visibleLayout: 'bb,80x24,0,0', zoomed: true },
        ])
    })

    it('parses window add/close/renamed including unlinked variants', async () => {
        const { gateway } = createGateway()
        await initGateway(gateway)
        const adds: number[] = []
        const closes: number[] = []
        const renamed: { windowId: number; name: string }[] = []
        gateway.windowAdd$.subscribe((id) => adds.push(id))
        gateway.windowClose$.subscribe((id) => closes.push(id))
        gateway.windowRenamed$.subscribe((r) => renamed.push(r))
        gateway.executeLine('%window-add @2')
        gateway.executeLine('%window-close @2')
        gateway.executeLine('%unlinked-window-close @3')
        gateway.executeLine('%window-renamed @1 vim')
        gateway.executeLine('%unlinked-window-renamed @2 nvim')
        expect(adds).toEqual([2])
        expect(closes).toEqual([2, 3])
        expect(renamed).toEqual([
            { windowId: 1, name: 'vim' },
            { windowId: 2, name: 'nvim' },
        ])
    })

    it('parses %session-changed and enables notifications', async () => {
        const { gateway } = createGateway()
        const changed: { sessionName: string; sessionId: number }[] = []
        gateway.sessionChanged$.subscribe((s) => changed.push(s))
        gateway.executeLine('%session-changed $1 mysess')
        expect(changed).toEqual([{ sessionId: 1, sessionName: 'mysess' }])
        // Notifications are now accepted without an init round-trip.
        const outputs: { paneId: number; data: Buffer }[] = []
        gateway.output$.subscribe((o) => outputs.push(o))
        gateway.executeLine('%output %1 \\141')
        expect(outputs).toHaveLength(1)
    })

    it('parses sessions-changed, session-window-changed and window-pane-changed', async () => {
        const { gateway } = createGateway()
        await initGateway(gateway)
        const sessions = vi.fn()
        const sessionWindows: { windowId: number }[] = []
        const panes: { windowId: number; paneId: number }[] = []
        gateway.sessionsChanged$.subscribe(sessions)
        gateway.sessionWindowChanged$.subscribe((w) => sessionWindows.push(w))
        gateway.paneChanged$.subscribe((p) => panes.push(p))
        gateway.executeLine('%sessions-changed')
        gateway.executeLine('%session-window-changed $1 @2')
        gateway.executeLine('%window-pane-changed @1 %2')
        expect(sessions).toHaveBeenCalledTimes(1)
        expect(sessionWindows).toEqual([{ windowId: 2 }])
        expect(panes).toEqual([{ windowId: 1, paneId: 2 }])
    })

    it('parses pane-close including unlinked variant', async () => {
        const { gateway } = createGateway()
        await initGateway(gateway)
        const closes: { windowId: number; paneId: number }[] = []
        gateway.paneClose$.subscribe((c) => closes.push(c))
        gateway.executeLine('%pane-close @1 %2')
        gateway.executeLine('%unlinked-pane-close @1 %3')
        expect(closes).toEqual([
            { windowId: 1, paneId: 2 },
            { windowId: 1, paneId: 3 },
        ])
    })

    it('ignores flow-control and no-output lines', async () => {
        const { gateway } = createGateway()
        await initGateway(gateway)
        const spy = vi.fn()
        gateway.output$.subscribe(spy)
        gateway.executeLine('%pause')
        gateway.executeLine('%continue')
        gateway.executeLine('%no-output')
        expect(spy).not.toHaveBeenCalled()
    })
})

describe('TmuxGateway executeData buffering and DCS stripping', () => {
    it('buffers partial lines across executeData calls', async () => {
        const { gateway } = createGateway()
        const p = gateway.sendCommand('list-windows')
        gateway.executeData(Buffer.from('%begin 1 1 1\nok'))
        gateway.executeData(Buffer.from('\n%end 1\n'))
        await expect(p).resolves.toBe('ok')
    })

    it('strips DCS wrapper sequences at line start and end', async () => {
        const { gateway } = createGateway()
        const p = gateway.sendCommand('list-windows')
        gateway.executeData(Buffer.from('\x1bP1000p%begin 1 1 1\nok\x1b\\\n'))
        gateway.executeData(Buffer.from('%end 1\x1b\\\n'))
        await expect(p).resolves.toBe('ok')
    })
})
