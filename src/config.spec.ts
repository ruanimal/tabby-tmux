import { describe, expect, it, vi } from 'vitest'
import { TmuxConfigProvider } from './config'

// tabby-core is an Angular partially-compiled package; loading it in Node
// requires the Angular linker/JIT compiler, so stub ConfigProvider instead.
vi.mock('tabby-core', () => ({
    ConfigProvider: class {
        defaults: Record<string, unknown> = {}
    },
}))

describe('TmuxConfigProvider', () => {
    it('provides the expected tmuxPlugin defaults', () => {
        const provider = new TmuxConfigProvider()
        expect(provider.defaults.tmuxPlugin).toEqual({
            defaultSessionName: 'default',
            commandTimeoutMs: 30_000,
            sendKeysChunkSize: 200,
            resizeDebounceMs: 150,
            debugLogging: false,
            showWindowCloseButton: true,
        })
    })
})
