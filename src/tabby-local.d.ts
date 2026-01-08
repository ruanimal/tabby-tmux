declare module "tabby-local" {
    export interface ChildProcess {
        pid: number
        ppid: number
        command: string
    }

    export abstract class PTYProxy {
        abstract getID(): string
        abstract getPID(): Promise<number>
        abstract resize(columns: number, rows: number): Promise<void>
        abstract write(data: Buffer): Promise<void>
        abstract kill(signal?: string): Promise<void>
        abstract ackData(length: number): void
        abstract subscribe(event: string, handler: (..._: any[]) => void): void
        abstract unsubscribeAll(): void
        abstract getChildProcesses(): Promise<ChildProcess[]>
        abstract getTruePID(): Promise<number>
        abstract getWorkingDirectory(): Promise<string | null>
    }

    export abstract class PTYInterface {
        abstract spawn(...options: any[]): Promise<PTYProxy>
        abstract restore(id: string): Promise<PTYProxy | null>
    }
}
