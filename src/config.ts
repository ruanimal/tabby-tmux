import { ConfigProvider } from 'tabby-core'

// eslint-disable-next-line new-cap
export class TmuxConfigProvider extends ConfigProvider {
    defaults = {
        tmuxPlugin: {
            defaultSessionName: 'default',
            commandTimeoutMs: 30_000,
            sendKeysChunkSize: 200,
            resizeDebounceMs: 150,
        },
    }
}
