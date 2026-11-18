import { spawn, spawnSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { performance } from 'perf_hooks'
import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import type { ConfigService, Logger } from 'tabby-core'
import type { Injector } from '@angular/core'
import { TmuxController, TmuxPaneSession } from './session'
import { DEFAULT_HISTORY_RESTORE_LIMIT } from './historyRestore'

vi.mock('tabby-terminal', async () => import('../test-support/sessionMocks'))

// Each run owns its server/socket. Opt in explicitly, also in CI.
const binary = process.env.TMUX_TEST_BINARY
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"

describe.skipIf(!binary)('snapshot performance regression budgets', () => {
    it.each([
        { panes: 1, lines: 1000, workload: 'shell', limit: 100000 },
        { panes: 1, lines: 1000, workload: 'wrapped', limit: 100000 },
        { panes: 1, lines: 50000, workload: 'shell', limit: 100000 },
        { panes: 4, lines: 50000, workload: 'shell', limit: 100000 },
        { panes: 1, lines: 50000, workload: 'busy', limit: 100000 },
        { panes: 1, lines: 50000, workload: 'vim', limit: 100000 },
        { panes: 1, lines: 50000, workload: 'shell', limit: undefined },
        { panes: 4, lines: 50000, workload: 'shell', limit: undefined },
    ])(
        '$panes pane(s), $lines lines each, $workload, limit=$limit, 189x52, 8 MiB/s transport',
        async ({ panes, lines, workload, limit }) => {
            const root = mkdtempSync(join(tmpdir(), 'tabby-tmux-perf-'))
            const socket = join(root, 'socket')
            const config = join(root, 'tmux.conf')
            const content = join(root, 'history.txt')
            writeFileSync(config, 'set -g history-limit 100000\nset -g status off\n')
            writeFileSync(
                content,
                Array.from(
                    { length: lines },
                    (_, n) =>
                        `row ${String(n).padStart(5, '0')} ${'log data '.repeat(workload === 'wrapped' ? 24 : 12)}\n`,
                ).join(''),
            )
            const cli = (...args: string[]) => {
                const result = spawnSync(binary, ['-S', socket, '-f', config, ...args], {
                    encoding: 'utf8',
                    maxBuffer: 32 * 1024 * 1024,
                })
                if (result.error) throw result.error
                if (result.status !== 0) throw new Error(result.stderr)
                return result.stdout
            }
            let control: ReturnType<typeof spawn> | undefined
            let controller: TmuxController | undefined
            const terminals: Terminal[] = []
            let transportTimer: ReturnType<typeof setTimeout> | undefined
            try {
                const tail =
                    workload === 'busy'
                        ? 'i=0; while :; do i=$(( (i + 1) % 17 )); printf "\\r\\033[K%*s" "$i" LIVE; sleep 0.01; done'
                        : workload === 'vim'
                          ? `${quote(process.env.VIM_TEST_BINARY ?? 'vim')} -Nu NONE -n -i NONE --noplugin ${quote(content)}`
                          : 'sleep 300'
                const command = `cat ${quote(content)}; ${tail}`
                cli('new-session', '-d', '-s', 'perf', '-x', '189', '-y', '52', command)
                for (let i = 1; i < panes; i++) cli('new-window', '-d', '-t', 'perf', command)
                await expect
                    .poll(
                        () =>
                            cli('list-panes', '-s', '-F', '#{history_size}')
                                .trim()
                                .split('\n')
                                .every((size) => Number(size) >= lines - 52),
                        { timeout: 10000 },
                    )
                    .toBe(true)
                if (workload === 'vim')
                    await expect
                        .poll(() => cli('display-message', '-p', '#{alternate_on}').trim())
                        .toBe('1')
                const historyLimit = limit ?? DEFAULT_HISTORY_RESTORE_LIMIT
                const historyStarts: string[] = []
                const historyBytes = cli('list-panes', '-s', '-F', '#{pane_id}')
                    .trim()
                    .split('\n')
                    .reduce((sum, id) => {
                        const history = cli(
                            'capture-pane',
                            '-peJN',
                            `-S-${historyLimit}`,
                            '-E-1',
                            '-t',
                            id,
                        )
                        historyStarts.push(history.split('\n')[0].slice(0, 189).trimEnd())
                        return sum + Buffer.byteLength(history)
                    }, 0)
                const logger = {
                    debug: vi.fn(),
                    info: vi.fn(),
                    warn: vi.fn(),
                    error: vi.fn(),
                } as unknown as Logger
                control = spawn(binary, ['-S', socket, '-C', 'attach', '-t', 'perf'])
                let bytes = 0
                let historyReads = 0
                const started = performance.now()
                let firstPaneMs: number | undefined
                let firstRenderedMs: number | undefined
                const restoring: Promise<void>[] = []
                controller = new TmuxController(
                    logger,
                    null as unknown as Injector,
                    (data) => {
                        historyReads += (data.match(/capture-pane[^\r]*-E-1 /g) ?? []).length
                        control.stdin.write(data.replace(/\r/g, '\n'))
                    },
                    () => undefined,
                    {
                        store: {
                            tmuxPlugin: { commandTimeoutMs: 30000, historyRestoreLimit: limit },
                        },
                    } as ConfigService,
                )
                controller.events.subscribe((event) => {
                    if (event.type !== 'pane-add') return
                    firstPaneMs ??= performance.now() - started
                    const term = new Terminal({
                        cols: 189,
                        rows: 52,
                        scrollback: 100000,
                        allowProposedApi: true,
                    })
                    terminals.push(term)
                    const session = new TmuxPaneSession(logger, controller, event.paneId)
                    session.output$.subscribe((data) => term.write(data))
                    const starting = session.start()
                    session.gridApplied()
                    restoring.push(
                        starting.then(
                            () =>
                                new Promise<void>((resolve) =>
                                    term.write('', () => {
                                        firstRenderedMs ??= performance.now() - started
                                        resolve()
                                    }),
                                ),
                        ),
                    )
                })
                controller.setClientSizePushed()
                const owner = controller
                const transport = control
                control.stdout.on('data', (data: Buffer) => {
                    // Bound throughput without changing command processing or mocking tmux.
                    transport.stdout.pause()
                    transportTimer = setTimeout(
                        () => {
                            bytes += data.length
                            owner.handleData(data)
                            transport.stdout.resume()
                        },
                        Math.max(1, (data.length / (8 * 1024 * 1024)) * 1000),
                    )
                })
                // Initialization starts the real discovery path; refresh shares its flight.
                await new Promise<void>((resolve) =>
                    controller.gateway.initialized$.subscribe(() => resolve()),
                )
                await controller.refreshPanes()
                await Promise.all(restoring)
                const totalMs = performance.now() - started
                // Generous CPU allowance in addition to the known wire cost;
                // byte/read budgets below catch regressions without timing noise.
                const totalBudgetMs = 3000 + (historyBytes / (8 * 1024 * 1024)) * 3000
                const metrics = {
                    panes,
                    lines,
                    workload,
                    historyBytes,
                    receivedBytes: bytes,
                    historyReads,
                    historyLimit,
                    firstPaneMs: Math.round(firstPaneMs),
                    firstRenderedMs: Math.round(firstRenderedMs),
                    totalMs: Math.round(totalMs),
                    totalBudgetMs: Math.round(totalBudgetMs),
                }
                console.info('SNAPSHOT_BENCHMARK', JSON.stringify(metrics))
                if (process.env.TMUX_BENCH_OUTPUT)
                    appendFileSync(process.env.TMUX_BENCH_OUTPUT, JSON.stringify(metrics) + '\n')
                expect(terminals).toHaveLength(panes)
                for (const [i, term] of terminals.entries()) {
                    expect(term.buffer.normal.getLine(0)?.translateToString(true).trimEnd()).toBe(
                        historyStarts[i],
                    )
                    if (limit === undefined && workload === 'shell') {
                        expect(term.buffer.normal.baseY).toBe(DEFAULT_HISTORY_RESTORE_LIMIT)
                    }
                    expect(
                        [3, 2, 1]
                            .map((offset) =>
                                term.buffer.normal
                                    .getLine(term.buffer.normal.length - offset)
                                    ?.translateToString(true),
                            )
                            .join('\n'),
                    ).toContain(`row ${String(lines - 1).padStart(5, '0')}`)
                }
                if (workload !== 'busy') {
                    const paneIds = cli('list-panes', '-s', '-F', '#{pane_id}').trim().split('\n')
                    for (const [i, term] of terminals.entries()) {
                        const expected = cli('capture-pane', '-pN', '-S0', '-t', paneIds[i])
                            .split('\n')
                            .slice(0, -1)
                            .map((line) => line.trimEnd())
                        const actual = Array.from(
                            { length: 52 },
                            (_, row) =>
                                term.buffer.active
                                    .getLine(term.buffer.active.baseY + row)
                                    ?.translateToString(true)
                                    .trimEnd() ?? '',
                        )
                        expect(actual).toEqual(expected)
                    }
                }
                expect(logger.warn).not.toHaveBeenCalled()
                // Work budgets are deterministic across CI machines; timing is reported.
                expect(historyReads).toBe(panes)
                expect(bytes).toBeLessThan(historyBytes * 1.15 + panes * 32768)
                expect(totalMs).toBeLessThan(totalBudgetMs)
                if (panes > 1) expect(firstRenderedMs).toBeLessThan(totalMs * 0.7)
            } finally {
                clearTimeout(transportTimer)
                control?.stdout.removeAllListeners('data')
                await controller?.destroy()
                terminals.forEach((term) => term.dispose())
                control?.kill()
                spawnSync(binary, ['-S', socket, 'kill-server'])
                rmSync(root, { recursive: true, force: true })
            }
        },
        60000,
    )
})
