import { Subject } from 'rxjs'

/** Small byte-preserving stand-in for Tabby's session middleware in Node tests. */
export class SessionMiddleware {
    protected outputToTerminal = new Subject<Buffer>()
    outputToTerminal$ = this.outputToTerminal.asObservable()

    feedFromSession(data: Buffer): void {
        this.outputToTerminal.next(data)
    }

    close(): void {
        this.outputToTerminal.complete()
    }
}

export class BaseSession {
    open = true
    protected output = new Subject<string>()
    protected binaryOutput = new Subject<Buffer>()
    output$ = this.output.asObservable()
    binaryOutput$ = this.binaryOutput.asObservable()
    private stages: SessionMiddleware[] = []
    middleware = {
        push: (stage: SessionMiddleware) => {
            this.stages.push(stage)
            stage.outputToTerminal$.subscribe((data) =>
                this.deliver(data, this.stages.indexOf(stage) + 1),
            )
        },
        feedFromSession: (data: Buffer) => this.deliver(data, 0),
    }

    constructor(protected logger: unknown) {}

    private deliver(data: Buffer, index: number): void {
        const stage = this.stages[index]
        if (stage) {
            stage.feedFromSession(data)
        } else {
            this.output.next(data.toString())
            this.binaryOutput.next(data)
        }
    }

    protected emitOutput(data: Buffer): void {
        this.middleware.feedFromSession(data)
    }

    async destroy(): Promise<void> {
        for (const stage of this.stages) stage.close()
        this.output.complete()
        this.binaryOutput.complete()
    }
}
