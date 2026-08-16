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

    it('provides nested tmuxPlugin hotkey defaults for window actions', () => {
        const provider = new TmuxConfigProvider()
        const hotkeys = provider.defaults.hotkeys
        // Tabby's getHotkeysConfigRecursive flattens nested config into
        // dot-prefixed ids, so `hotkeys.tmuxPlugin.next-window` matches the
        // `tmuxPlugin.next-window` HotkeyDescription id.
        expect(hotkeys.tmuxPlugin).toEqual({
            'previous-window': ['Ctrl-Shift-['],
            'next-window': ['Ctrl-Shift-]'],
            'window-1': ['Ctrl-Shift-1'],
            'window-2': ['Ctrl-Shift-2'],
            'window-3': ['Ctrl-Shift-3'],
            'window-4': ['Ctrl-Shift-4'],
            'window-5': ['Ctrl-Shift-5'],
            'window-6': ['Ctrl-Shift-6'],
            'window-7': ['Ctrl-Shift-7'],
            'window-8': ['Ctrl-Shift-8'],
            'window-9': ['Ctrl-Shift-9'],
            'new-window': ['Ctrl-Shift-B'],
            'toggle-tmux-mode': ['Ctrl-Shift-X'],
        })
    })
})
