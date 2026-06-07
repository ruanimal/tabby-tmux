import { Subject } from 'rxjs'
import { Logger, ConfigService } from 'tabby-core'
import { createConditionalLogger, ConditionalLogger } from './logHelper'

// Command flags
export const TMUX_COMMAND_TOLERATE_ERRORS = 1 << 0
export const TMUX_COMMAND_WANTS_DATA = 1 << 1
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
const DEFAULT_SEND_KEYS_CHUNK_SIZE = 200

interface PendingCommand {
    id: number
    command: string
    resolve: (result: string) => void
    reject: (error: Error) => void
    flags: number
    timestamp: number
}

export interface TmuxGatewayDelegate {
    tmuxReadTask(data: Buffer, paneId: number, latency?: number): void
    tmuxWindowAddedWithId(windowId: number): void
    tmuxWindowClosedWithId(windowId: number): void
    tmuxWindowRenamedWithId(windowId: number, name: string): void
    tmuxSessionChanged(sessionName: string, sessionId: number): void
    tmuxSessionsChanged(): void
    tmuxLayoutChange(windowId: number, layout: string, visibleLayout?: string, zoomed?: boolean): void
    tmuxWriteString(data: string): void
    tmuxHostDisconnected(): void
}

/**
 * TmuxGateway - Protocol layer for tmux control mode
 *
 * Handles:
 * - Command queuing with response matching
 * - Protocol parsing (%begin/%end/%error blocks)
 * - Notification dispatch
 * - Key encoding and sending
 */
export class TmuxGateway {
    private commandQueue: PendingCommand[] = []
    private currentCommand: PendingCommand | null = null
    private currentCommandId: string = ''
    private currentResponse: string[] = []
    private inResponseBlock = false
    private nextCommandId = 1
    private disconnected = false
    private detachSent = false
    private acceptNotifications = false
    private initialized = false
    /** Number of fire-and-forget writes whose %begin/%end responses need consuming */
    private directWritesPending = 0
    /** Incomplete line buffer for byte-level DCS parsing */
    private lineBuffer = ''

    public minimumServerVersion: number | null = null
    public maximumServerVersion: number | null = null
    public pauseModeEnabled = false

    // Events for notifications
    public output$ = new Subject<{ paneId: number; data: Buffer; latency?: number }>()
    public layoutChange$ = new Subject<{ windowId: number; layout: string; visibleLayout?: string; zoomed?: boolean }>()
    public windowAdd$ = new Subject<number>()
    public windowClose$ = new Subject<number>()
    public windowRenamed$ = new Subject<{ windowId: number; name: string }>()
    public sessionChanged$ = new Subject<{ sessionName: string; sessionId: number }>()
    public sessionsChanged$ = new Subject<void>()
    public paneChanged$ = new Subject<{ windowId: number; paneId: number }>()
    public sessionWindowChanged$ = new Subject<{ windowId: number }>()
    public paneClose$ = new Subject<{ windowId: number; paneId: number }>()
    public exit$ = new Subject<string>()
    public initialized$ = new Subject<void>()

    constructor(
        private logger: Logger,
        private writer: (data: string) => void,
        private configService?: ConfigService
    ) { }

    private get log (): ConditionalLogger {
        return createConditionalLogger(this.logger, this.configService)
    }

    private get commandTimeoutMs (): number {
        return this.configService?.store.tmuxPlugin?.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    }

    private get sendKeysChunkSize (): number {
        return this.configService?.store.tmuxPlugin?.sendKeysChunkSize ?? DEFAULT_SEND_KEYS_CHUNK_SIZE
    }

    /**
     * Send a single command and wait for response
     */
    async sendCommand(command: string, flags = 0): Promise<string> {
        if (this.detachSent || this.disconnected) {
            throw new Error('Gateway disconnected')
        }

        const original = new Promise<string>((resolve, reject) => {
            const cmd: PendingCommand = {
                id: this.nextCommandId++,
                command,
                resolve,
                reject,
                flags,
                timestamp: Date.now()
            }
            this.commandQueue.push(cmd)
            this.write(command + '\r')
            this.log.debug(`Sent command: ${command}`)
        })

        // Race against timeout — if tmux never responds, reject instead of hanging
        let timer: ReturnType<typeof setTimeout>
        const timeout = new Promise<string>((_, reject) => {
            timer = setTimeout(() => {
                // Remove the timed-out command from the queue so it won't
                // consume a later response and cause command-id mismatch.
                reject(new Error(`Command timed out after ${this.commandTimeoutMs}ms: ${command}`))
            }, this.commandTimeoutMs)
        })

        // Clean up timer when original settles
        original.then(() => clearTimeout(timer!), () => clearTimeout(timer!))

        return Promise.race([original, timeout])
    }

    /**
     * Send a list of commands atomically (separated by ;)
     */
    async sendCommandList(commands: Array<{ command: string; flags?: number }>): Promise<string[]> {
        if (this.detachSent || this.disconnected || commands.length === 0) {
            return []
        }

        const promises: Promise<string>[] = []
        const combined = commands.map((c) => {
            const promise = new Promise<string>((resolve, reject) => {
                const cmd: PendingCommand = {
                    id: this.nextCommandId++,
                    command: c.command,
                    resolve,
                    reject,
                    flags: c.flags || 0,
                    timestamp: Date.now()
                }
                this.commandQueue.push(cmd)
            })
            promises.push(promise)
            return c.command
        }).join('; ')

        this.write(combined + '\r')
        this.log.debug(`Sent command list: ${combined}`)

        return Promise.all(promises)
    }

    /**
     * Send keystrokes to a specific pane.
     *
     * Writes directly to the PTY — bypasses the command queue for zero-latency
     * input.  tmux will still send %begin/%end for the send-keys command;
     * parseBegin() tracks these via directWritesPending so they are consumed
     * without trying to dequeue a queued command.
     */
    sendKeys(data: Buffer, paneId: number): void {
        if (this.disconnected) return

        const hex = data.toString('hex')
        if (hex.length > 0) {
            // Split into chunks to avoid command length limits
            for (let i = 0; i < hex.length; i += this.sendKeysChunkSize) {
                const chunk = hex.substring(i, i + this.sendKeysChunkSize)
                const hexBytes = chunk.match(/.{2}/g)?.join(' ') || ''
                // Write directly — bypasses command queue for zero-latency input
                this.write(`send-keys -t %${paneId} -H ${hexBytes}\r`)
                this.directWritesPending++
            }
        }
    }

    /**
     * Request detach
     */
    detach(): void {
        if (!this.detachSent) {
            this.write('detach\r')
            this.detachSent = true
        }
    }

    /**
     * Feed raw PTY data.  Buffers incomplete lines across calls so that TCP
     * fragment boundaries never split a protocol line.
     */
    executeData(data: Buffer): void {
        this.lineBuffer += data.toString('utf-8')

        let newlineIdx: number
        while ((newlineIdx = this.lineBuffer.indexOf('\n')) !== -1) {
            const rawLine = this.lineBuffer.substring(0, newlineIdx)
            this.lineBuffer = this.lineBuffer.substring(newlineIdx + 1)
            const line = rawLine.replace(/\r$/, '')
            if (line) {
                this.executeLine(line)
            }
        }
    }

    /**
     * Process a single complete line from tmux control mode
     */
    executeLine(line: string): void {
        // Strip DCS artifacts
        line = line.replace(/^\x1bP\d+p/, '').replace(/^P\d+p/, '').replace(/\x1b\\$/, '')
        if (!line) return

        this.log.info(`Received: ${line.substring(0, 100)}${line.length > 100 ? '...' : ''}`)

        // Handle response blocks
        if (this.inResponseBlock) {
            if (line.startsWith(`%end ${this.currentCommandId}`) ||
                line.startsWith(`%end `)) {
                this.stripLastNewline()
                this.finishCurrentCommand(false)
                return
            } else if (line.startsWith(`%error ${this.currentCommandId}`) ||
                line.startsWith(`%error `)) {
                this.stripLastNewline()
                this.finishCurrentCommand(true)
                return
            } else if (line.startsWith('%exit')) {
                // Tmux 1.8 bug workaround
                this.stripLastNewline()
                this.finishCurrentCommand(false)
                // Fall through to handle %exit
            } else if (line.startsWith('%output ') || line.startsWith('%extended-output ')) {
                // Dispatch pane output notifications even during response blocks.
                // Otherwise they get accumulated as garbage text in the command
                // response (e.g. capture-pane) and the live output is lost.
                if (this.acceptNotifications) {
                    if (line.startsWith('%output ')) {
                        this.parseOutput(line)
                    } else {
                        this.parseExtendedOutput(line)
                    }
                }
                return
            } else {
                // Accumulate response
                this.currentResponse.push(line)
                return
            }
        }

        // Handle notifications and commands
        if (line.startsWith('%begin')) {
            this.parseBegin(line)
        } else if (line.startsWith('%output ')) {
            if (this.acceptNotifications) {
                this.log.info(`Parsing output line: ${line.substring(0, 50)}...`)
                this.parseOutput(line)
            } else {
                this.log.warn(`Ignored output (not accepting notifications): ${line.substring(0, 50)}...`)
            }
        } else if (line.startsWith('%extended-output ')) {
            if (this.acceptNotifications) {
                this.parseExtendedOutput(line)
            }
        } else if (line.startsWith('%layout-change ')) {
            if (this.acceptNotifications) {
                this.parseLayoutChange(line)
            }
        } else if (line.startsWith('%window-add')) {
            if (this.acceptNotifications) {
                this.parseWindowAdd(line)
            }
        } else if (line.startsWith('%window-close') || line.startsWith('%unlinked-window-close')) {
            if (this.acceptNotifications) {
                this.parseWindowClose(line)
            }
        } else if (line.startsWith('%window-renamed') || line.startsWith('%unlinked-window-renamed')) {
            if (this.acceptNotifications) {
                this.parseWindowRenamed(line)
            }
        } else if (line.startsWith('%session-changed')) {
            this.parseSessionChanged(line)
        } else if (line.startsWith('%sessions-changed')) {
            if (this.acceptNotifications) {
                this.sessionsChanged$.next()
            }
        } else if (line.startsWith('%session-window-changed')) {
            if (this.acceptNotifications) {
                this.parseSessionWindowChanged(line)
            }
        } else if (line.startsWith('%window-pane-changed')) {
            if (this.acceptNotifications) {
                this.parsePaneChanged(line)
            }
        } else if (line.startsWith('%pane-close') || line.startsWith('%unlinked-pane-close')) {
            if (this.acceptNotifications) {
                this.parsePaneClose(line)
            }
        } else if (line.startsWith('%pause') || line.startsWith('%continue')) {
            // Flow control notifications (tmux 3.2+) — acknowledged
            this.log.debug(`Flow control: ${line}`)
        } else if (line.startsWith('%no-output')) {
            // Empty response block — no action needed
        } else if (line.startsWith('%exit')) {
            this.parseExit(line)
        } else if (line.startsWith('%')) {
            // Unknown notification, ignore
            this.log.debug(`Unknown notification: ${line}`)
        }
    }

    // --- Protocol Parsing ---

    private parseBegin(line: string): void {
        // %begin timestamp commandId flags
        // Format: %begin 1767853190 875 1
        // tmux Control Mode docs: flags is always 1 for client-originated.
        const parts = line.split(' ')
        if (parts.length < 3) {
            this.logger.warn(`Malformed %begin: ${line}`)
            return
        }

        const commandId = parts[2]
        this.currentCommandId = commandId
        this.currentResponse = []
        this.inResponseBlock = true

        // If this response is for a fire-and-forget write (sendKeys),
        // consume it without dequeuing a queued command.
        if (this.commandQueue.length === 0 && this.directWritesPending > 0) {
            this.directWritesPending--
            this.currentCommand = null
            return
        }

        if (this.commandQueue.length === 0) {
            // Server-initiated or unexpected response block
            this.currentCommand = null
            return
        }

        this.currentCommand = this.commandQueue.shift()!
    }

    private finishCurrentCommand(isError: boolean): void {
        this.inResponseBlock = false
        const response = this.currentResponse.join('\n')

        if (this.currentCommand) {
            if (isError && !(this.currentCommand.flags & TMUX_COMMAND_TOLERATE_ERRORS)) {
                this.currentCommand.reject(new Error(response))
            } else {
                this.currentCommand.resolve(response)
            }
            this.currentCommand = null
        }

        // Mark as initialized after first successful response
        if (!this.initialized) {
            this.initialized = true
            this.acceptNotifications = true
            this.initialized$.next()
        }
    }

    private stripLastNewline(): void {
        if (this.currentResponse.length > 0) {
            const last = this.currentResponse[this.currentResponse.length - 1]
            if (last === '') {
                this.currentResponse.pop()
            }
        }
    }

    private parseOutput(line: string): void {
        // %output %<pane> <data>
        const match = line.match(/^%output %(\d+) (.*)$/)
        if (!match) {
            this.logger.error(`Output regex FAILED for line: <${line}>`)
            return
        }

        const paneId = parseInt(match[1])
        const data = this.decodeOutput(match[2])
        this.log.info(`Parsed output for pane %${paneId}: ${data.length} bytes (match_len=${match[2].length})`)
        this.output$.next({ paneId, data })
    }

    private parseExtendedOutput(line: string): void {
        // %extended-output %<pane> <latency> : <data>
        const match = line.match(/^%extended-output %(\d+) (\d+) : (.*)$/)
        if (!match) return

        const paneId = parseInt(match[1])
        const latency = parseInt(match[2]) / 1000 // Convert ms to seconds
        const data = this.decodeOutput(match[3])
        this.output$.next({ paneId, data, latency })
    }

    private parseLayoutChange(line: string): void {
        // %layout-change @<window> <layout> [visible_layout flags]
        const match = line.match(/^%layout-change @(\d+) (.+)$/)
        if (!match) return

        const windowId = parseInt(match[1])
        const parts = match[2].split(' ')
        const layout = parts[0]
        const visibleLayout = parts.length > 1 ? parts[1] : undefined
        const zoomed = parts.length > 2 ? parts[2].includes('Z') : undefined

        this.layoutChange$.next({ windowId, layout, visibleLayout, zoomed })
    }

    private parseWindowAdd(line: string): void {
        // %window-add @<id>
        const match = line.match(/^%window-add @(\d+)$/)
        if (match) {
            this.windowAdd$.next(parseInt(match[1]))
        }
    }

    private parseWindowClose(line: string): void {
        // %window-close @<id> or %unlinked-window-close @<id>
        const match = line.match(/@(\d+)$/)
        if (match) {
            this.windowClose$.next(parseInt(match[1]))
        }
    }

    private parseWindowRenamed(line: string): void {
        // %window-renamed @<id> <name>
        const match = line.match(/^%(?:unlinked-)?window-renamed @(\d+) (.+)$/)
        if (match) {
            this.windowRenamed$.next({
                windowId: parseInt(match[1]),
                name: this.unescapeTmuxWindowName(match[2])
            })
        }
    }

    private parseSessionChanged(line: string): void {
        // %session-changed $<id> <name>
        const match = line.match(/^%session-changed \$(\d+) (.+)$/)
        if (match) {
            this.sessionChanged$.next({
                sessionId: parseInt(match[1]),
                sessionName: match[2]
            })
            // Enable notifications after session change
            this.acceptNotifications = true
        }
    }

    private parseSessionWindowChanged(line: string): void {
        // %session-window-changed $session @window
        const match = line.match(/^%session-window-changed \$\d+ @(\d+)/)
        if (match) {
            this.sessionWindowChanged$.next({
                windowId: parseInt(match[1])
            })
        }
    }

    private parsePaneChanged(line: string): void {
        // %window-pane-changed @<window> %<pane>
        const match = line.match(/^%window-pane-changed @(\d+) %(\d+)$/)
        if (match) {
            this.paneChanged$.next({
                windowId: parseInt(match[1]),
                paneId: parseInt(match[2])
            })
        }
    }

    private parsePaneClose(line: string): void {
        // %pane-close @<window> %<pane>
        const match = line.match(/^%(?:unlinked-)?pane-close @(\d+) %(\d+)$/)
        if (match) {
            this.paneClose$.next({
                windowId: parseInt(match[1]),
                paneId: parseInt(match[2])
            })
        }
    }

    private parseExit(line: string): void {
        // %exit or %exit <reason>
        const reason = line.replace(/^%exit\s*/, '')
        this.exit$.next(reason)
        this.disconnected = true
    }

    // --- Utility Methods ---

    private write(data: string): void {
        this.writer(data)
    }

    /**
     * Decode tmux octal-escaped output to Buffer
     */
    private decodeOutput(str: string): Buffer {
        const bytes: number[] = []
        for (let i = 0; i < str.length; i++) {
            if (str[i] === '\\' && i + 3 < str.length) {
                const octal = str.substring(i + 1, i + 4)
                if (/^[0-7]{3}$/.test(octal)) {
                    bytes.push(parseInt(octal, 8))
                    i += 3
                    continue
                }
            }
            // Handle UTF-8 properly
            const buf = Buffer.from(str[i], 'utf-8')
            for (const byte of buf) {
                bytes.push(byte)
            }
        }
        return Buffer.from(bytes)
    }

    private unescapeTmuxWindowName(name: string): string {
        // Tmux may escape window names
        return name.replace(/\\(.)/g, '$1')
    }

    /**
     * Check if server version is at least the given version
     */
    versionAtLeast(version: number): boolean {
        return this.minimumServerVersion !== null && this.minimumServerVersion >= version
    }
}
