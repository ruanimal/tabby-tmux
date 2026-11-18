import { spawn, spawnSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { firstValueFrom } from 'rxjs'
import type { Logger, ConfigService } from 'tabby-core'
import type { Injector } from '@angular/core'
import { TmuxController, TmuxPaneSession } from './session'
import { flattenLayout, parseTmuxLayout } from './layoutParser'

vi.mock('tabby-terminal', async () => import('../test-support/sessionMocks'))

// Explicit opt-in: tests start and clean up only a unique, temporary server.
const binary = process.env.TMUX_TEST_BINARY
const vim = process.env.VIM_TEST_BINARY ?? 'vim'
const htop = process.env.HTOP_TEST_BINARY
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"

describe.skipIf(!binary)('real tmux snapshot restoration', () => {
    it('renders a UTF-8 character split across real tmux output notifications', async () => {
        const root = mkdtempSync(join(tmpdir(), 'tabby-tmux-utf8-'))
        const socket = join(root, 'socket')
        const cli = (...args: string[]) => {
            const result = spawnSync(binary, ['-S', socket, '-f', '/dev/null', ...args], {
                encoding: 'utf8',
            })
            if (result.error) throw result.error
            if (result.status !== 0) throw new Error(result.stderr)
            return result.stdout
        }
        const logger = {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        } as unknown as Logger
        let controller: TmuxController | undefined
        let control: ReturnType<typeof spawn> | undefined
        try {
            cli('new-session', '-d', '-s', 'utf8', '-x', '80', '-y', '24', 'exec /bin/sh')
            const paneId = Number(
                cli('display-message', '-p', '-t', 'utf8', '#{pane_id}').trim().slice(1),
            )
            control = spawn(binary, ['-S', socket, '-C', 'attach', '-t', 'utf8'])
            const transport = control
            controller = new TmuxController(
                logger,
                null as unknown as Injector,
                (data) => transport.stdin.write(data.replace(/\r/g, '\n')),
                () => undefined,
            )
            const owner = controller
            const initialized = firstValueFrom(owner.gateway.initialized$)
            transport.stdout.on('data', (data: Buffer) => owner.handleData(data))
            await initialized
            vi.spyOn(owner, 'hasPendingSnapshot').mockReturnValue(true)
            vi.spyOn(owner, 'restorePaneHistory').mockResolvedValue(undefined)
            const session = new TmuxPaneSession(logger, owner, paneId)
            let output = ''
            const notifications: Buffer[] = []
            session.output$.subscribe((data) => (output += data))
            owner.gateway.output$.subscribe(({ paneId: id, data }) => {
                if (id === paneId) notifications.push(data)
            })
            const starting = session.start()
            session.gridApplied()
            await starting

            cli(
                'send-keys',
                '-t',
                'utf8',
                '-l',
                "printf '\\342\\226'; sleep 0.3; printf '\\210\\n'",
            )
            cli('send-keys', '-t', 'utf8', 'Enter')
            await expect.poll(() => output).toContain('█')
            expect(output).not.toContain('�')
            expect(notifications.some((data) => data.includes(Buffer.from([0xe2, 0x96])))).toBe(
                true,
            )
            expect(notifications.some((data) => data.includes(Buffer.from([0x88])))).toBe(true)
        } finally {
            await controller?.destroy()
            control?.kill()
            spawnSync(binary, ['-S', socket, 'kill-server'])
            rmSync(root, { recursive: true, force: true })
        }
    }, 15000)

    it.each([
        { priorResize: false, resizeAfter: false },
        { priorResize: false, resizeAfter: true },
        { priorResize: true, resizeAfter: false },
        { priorResize: true, resizeAfter: true },
    ])(
        'restores Vim with priorResize=$priorResize, resizeAfter=$resizeAfter, follows edits and exits',
        async ({ priorResize, resizeAfter }) => {
            const root = mkdtempSync(join(tmpdir(), 'tabby-tmux-vim-'))
            const socket = join(root, 'socket')
            const document = join(root, 'buffer.txt')
            writeFileSync(
                document,
                'VIM_BUFFER_MARKER\n' +
                    Array.from({ length: 40 }, (_, i) => `editor line ${i}`).join('\n'),
            )
            const cli = (...args: string[]) => {
                const result = spawnSync(binary, ['-S', socket, '-f', '/dev/null', ...args], {
                    encoding: 'utf8',
                })
                if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`)
                return result.stdout
            }
            const marker = 'SHELL_BEFORE_VIM'
            const history = Array.from({ length: 35 }, (_, i) => `history ${i + 1}`).join('\\n')
            const command =
                `printf '${history}\\n${marker}\\n'; ` +
                `${quote(vim)} -Nu NONE -n -i NONE --noplugin ${quote(document)}; ` +
                "printf 'AFTER_VIM_MARKER'; sleep 300"
            let controller: TmuxController | undefined
            let terminal: Terminal | undefined
            let control: ReturnType<typeof spawn> | undefined
            try {
                cli('new-session', '-d', '-s', 'audit', '-x', '80', '-y', '24', command)
                cli('set-option', '-g', 'status', 'off')
                if (priorResize) {
                    cli('resize-window', '-t', 'audit', '-x', '60', '-y', '12')
                    cli('set-option', '-g', 'default-size', '60x12')
                    cli('set-option', '-w', '-t', 'audit', 'window-size', 'latest')
                }
                await expect
                    .poll(() =>
                        cli('display-message', '-p', '-t', 'audit', '#{alternate_on}').trim(),
                    )
                    .toBe('1')
                await expect
                    .poll(() => cli('capture-pane', '-p', '-t', 'audit'))
                    .toContain('VIM_BUFFER_MARKER')
                const paneId = Number(
                    cli('display-message', '-p', '-t', 'audit', '#{pane_id}').trim().slice(1),
                )
                const logger = {
                    debug: vi.fn(),
                    info: vi.fn(),
                    warn: vi.fn(),
                    error: vi.fn(),
                } as unknown as Logger
                control = spawn(binary, ['-S', socket, '-C', 'attach', '-t', 'audit'])
                controller = new TmuxController(
                    logger,
                    null as unknown as Injector,
                    // -C with pipes uses LF; a -CC PTY translates the plugin's CR.
                    (data) => control.stdin.write(data.replace(/\r/g, '\n')),
                    () => undefined,
                    { store: { tmuxPlugin: { commandTimeoutMs: 2000 } } } as ConfigService,
                )
                controller.setClientSizePushed()
                terminal = new Terminal({
                    cols: priorResize ? 60 : 80,
                    rows: priorResize ? 12 : 24,
                    scrollback: 1000,
                    allowProposedApi: true,
                })
                const term = terminal
                const paneSession: { current?: TmuxPaneSession } = {}
                term.buffer.onBufferChange((buffer) =>
                    paneSession.current?.screenBufferChanged(buffer.type),
                )
                controller.events.subscribe((event) => {
                    if (event.type !== 'layout-change') return
                    const layout = parseTmuxLayout(event.data.layout)
                    const pane =
                        layout && flattenLayout(layout).find((entry) => entry.paneId === paneId)
                    if (pane && (term.cols !== pane.width || term.rows !== pane.height)) {
                        paneSession.current?.gridResized(term.buffer.active.type)
                        term.resize(pane.width, pane.height)
                    }
                })
                // Like the real frontend, wait for attach's unsolicited
                // response before putting commands in the response queue.
                const initialized = firstValueFrom(controller.gateway.initialized$)
                control.stdout.on('data', (data: Buffer) => controller.handleData(data))
                await initialized
                await controller.refreshPanes()
                expect(logger.warn).not.toHaveBeenCalled()
                const session = new TmuxPaneSession(logger, controller, paneId)
                paneSession.current = session
                session.output$.subscribe((data) => term.write(data))
                const starting = session.start()
                session.gridApplied()
                await starting
                const flush = () => new Promise<void>((resolve) => term.write('', resolve))
                const visible = () => {
                    const buffer = term.buffer.active
                    return Array.from(
                        { length: term.rows },
                        (_, row) =>
                            buffer
                                .getLine(buffer.baseY + row)
                                ?.translateToString(true)
                                .trimEnd() ?? '',
                    )
                }
                const assertMatchesTmux = async () => {
                    await expect
                        .poll(async () => {
                            const expected = cli('capture-pane', '-p', '-N', '-S0', '-t', 'audit')
                                .replace(/\r/g, '')
                                .split('\n')
                                .slice(0, -1)
                                .map((line) => line.trimEnd())
                            const cursor = cli(
                                'display-message',
                                '-p',
                                '-t',
                                'audit',
                                '#{cursor_x},#{cursor_y}',
                            ).trim()
                            await flush()
                            const actual = visible()
                            const actualCursor = `${term.buffer.active.cursorX},${term.buffer.active.cursorY}`
                            return JSON.stringify(actual) === JSON.stringify(expected) &&
                                actualCursor === cursor
                                ? true
                                : { expected, actual, cursor, actualCursor }
                        })
                        .toBe(true)
                }

                await expect
                    .poll(async () => {
                        await flush()
                        return term.buffer.active.type
                    })
                    .toBe('alternate')
                await assertMatchesTmux()
                expect(term.buffer.normal.getLine(0)?.translateToString(true).trimEnd()).toBe(
                    'history 1',
                )

                controller.writeToPane(paneId, Buffer.from('\x1bgg0iEDITED_\x1b'))
                await expect
                    .poll(async () => {
                        await flush()
                        return visible().join('\n')
                    })
                    .toContain('EDITED_VIM_BUFFER_MARKER')
                await assertMatchesTmux()

                if (resizeAfter) {
                    const nextCols = priorResize ? 90 : 60
                    const nextRows = priorResize ? 18 : 12
                    controller.resizePane(paneId, nextCols, nextRows)
                    await expect
                        .poll(() => `${term.cols},${term.rows}`)
                        .toBe(`${nextCols},${nextRows}`)
                    await assertMatchesTmux()
                    expect(visible().join('\n')).toContain('EDITED_VIM_BUFFER_MARKER')
                }

                controller.writeToPane(paneId, Buffer.from('\x1b:qa!\r'))
                await expect
                    .poll(async () => {
                        await flush()
                        return term.buffer.active.type
                    })
                    .toBe('normal')
                await expect
                    .poll(async () => {
                        await flush()
                        return visible().join('\n')
                    })
                    .toContain('AFTER_VIM_MARKER')
                await assertMatchesTmux()
                expect(logger.warn).not.toHaveBeenCalled()
            } finally {
                await controller?.destroy()
                terminal?.dispose()
                control?.kill()
                spawnSync(binary, ['-S', socket, 'kill-server'])
                rmSync(root, { recursive: true, force: true })
            }
        },
        15000,
    )

    it.skipIf(!htop)(
        'preserves htop colors during partial redraws and resize',
        async () => {
            const root = mkdtempSync(join(tmpdir(), 'tabby-tmux-htop-'))
            const socket = join(root, 'socket')
            const cli = (...args: string[]) => {
                const result = spawnSync(binary, ['-S', socket, '-f', '/dev/null', ...args], {
                    encoding: 'utf8',
                })
                if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`)
                return result.stdout
            }
            const logger = {
                debug: vi.fn(),
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
            } as unknown as Logger
            let controller: TmuxController | undefined
            let terminal: Terminal | undefined
            let control: ReturnType<typeof spawn> | undefined
            try {
                cli(
                    'new-session',
                    '-d',
                    '-s',
                    'audit',
                    '-x',
                    '80',
                    '-y',
                    '24',
                    `exec env LC_ALL=C HTOPRC=${quote(join(root, 'htoprc'))} ${quote(htop)} -d 600`,
                )
                cli('set-option', '-g', 'status', 'off')
                await expect.poll(() => cli('capture-pane', '-p', '-t', 'audit')).toContain('Help')
                const paneId = Number(
                    cli('display-message', '-p', '-t', 'audit', '#{pane_id}').trim().slice(1),
                )
                control = spawn(binary, ['-S', socket, '-C', 'attach', '-t', 'audit'])
                controller = new TmuxController(
                    logger,
                    null as unknown as Injector,
                    (data) => control.stdin.write(data.replace(/\r/g, '\n')),
                    () => undefined,
                    { store: { tmuxPlugin: { commandTimeoutMs: 2000 } } } as ConfigService,
                )
                controller.setClientSizePushed()
                terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
                const term = terminal
                const mounted: { session?: TmuxPaneSession } = {}
                controller.events.subscribe((event) => {
                    if (event.type !== 'layout-change') return
                    const layout = parseTmuxLayout(event.data.layout)
                    const pane =
                        layout && flattenLayout(layout).find((entry) => entry.paneId === paneId)
                    if (pane && (pane.width !== term.cols || pane.height !== term.rows)) {
                        mounted.session?.gridResized(term.buffer.active.type)
                        term.resize(pane.width, pane.height)
                    }
                })
                const initialized = firstValueFrom(controller.gateway.initialized$)
                control.stdout.on('data', (data: Buffer) => controller.handleData(data))
                await initialized
                await controller.refreshPanes()
                const session = new TmuxPaneSession(logger, controller, paneId)
                mounted.session = session
                session.output$.subscribe((data) => term.write(data))
                const starting = session.start()
                session.gridApplied()
                await starting
                const flush = () => new Promise<void>((resolve) => term.write('', resolve))
                const colors = (target: Terminal) => {
                    const buffer = target.buffer.active
                    return Array.from({ length: target.rows }, (_, row) =>
                        Array.from({ length: target.cols }, (_, col) => {
                            const cell = buffer.getLine(buffer.baseY + row).getCell(col)
                            return [
                                cell.getChars() || ' ',
                                cell.getFgColorMode(),
                                cell.getFgColor(),
                                cell.getBgColorMode(),
                                cell.getBgColor(),
                                Boolean(cell.isInverse()),
                                Boolean(cell.isBold()),
                                Boolean(cell.isDim()),
                            ].join(',')
                        }),
                    )
                }
                const assertColorsMatch = async () => {
                    await expect
                        .poll(async () => {
                            const rows = cli('capture-pane', '-peN', '-S0', '-t', 'audit')
                                .split('\n')
                                .slice(0, -1)
                            const reference = new Terminal({
                                cols: term.cols,
                                rows: term.rows,
                                allowProposedApi: true,
                            })
                            try {
                                await new Promise<void>((resolve) =>
                                    reference.write(
                                        '\x1b[?7l' +
                                            rows.map((row, i) => `\x1b[${i + 1};1H${row}`).join(''),
                                        resolve,
                                    ),
                                )
                                await flush()
                                const expected = colors(reference)
                                const actual = colors(term)
                                const differences: unknown[] = []
                                for (let row = 0; row < term.rows; row++) {
                                    for (let col = 0; col < term.cols; col++) {
                                        if (actual[row][col] !== expected[row][col]) {
                                            differences.push({
                                                row,
                                                col,
                                                expected: expected[row][col],
                                                actual: actual[row][col],
                                            })
                                        }
                                    }
                                }
                                return differences.length
                                    ? {
                                          differences: differences.slice(0, 5),
                                          grid: `${term.cols},${term.rows}`,
                                          buffer: term.buffer.active.type,
                                          warnings: vi.mocked(logger.warn).mock.calls,
                                          text: Array.from({ length: 3 }, (_, row) =>
                                              term.buffer.active
                                                  .getLine(term.buffer.active.baseY + row)
                                                  .translateToString(true),
                                          ),
                                      }
                                    : true
                            } finally {
                                reference.dispose()
                            }
                        })
                        .toBe(true)
                }
                await assertColorsMatch()
                let outputCount = 0
                controller.gateway.output$.subscribe(() => outputCount++)
                for (let i = 0; i < 3; i++) {
                    const before = outputCount
                    await controller.gateway.sendCommand(`send-keys -t %${paneId} Down`)
                    await expect.poll(() => outputCount).toBeGreaterThan(before)
                    await assertColorsMatch()
                }
                controller.resizePane(paneId, 100, 30)
                await expect.poll(() => `${term.cols},${term.rows}`).toBe('100,30')
                await assertColorsMatch()
                expect(logger.warn).not.toHaveBeenCalled()
            } finally {
                await controller?.destroy()
                terminal?.dispose()
                control?.kill()
                spawnSync(binary, ['-S', socket, 'kill-server'])
                rmSync(root, { recursive: true, force: true })
            }
        },
        15000,
    )
})
