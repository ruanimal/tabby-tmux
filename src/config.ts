import { ConfigProvider } from 'tabby-core'

// eslint-disable-next-line new-cap
export class TmuxConfigProvider extends ConfigProvider {
    defaults = {
        tmuxPlugin: {
            defaultSessionName: 'default',
            commandTimeoutMs: 30_000,
            sendKeysChunkSize: 200,
            resizeDebounceMs: 150,
            debugLogging: false,
            showWindowCloseButton: true,
        },
        // Window-level hotkeys unique to tmux mode (see
        // doc/DESIGN_KEYBINDINGS.md). Tabby's getHotkeysConfigRecursive
        // resolves nested config into flat ids (`tmuxPlugin.next-window`),
        // so the actions can be rebound in Tabby Settings → Hotkeys.
        // All defaults are keys Tabby does NOT bind on Linux/macOS —
        // including tabby-electron's hotkeys (Ctrl-Shift-N is taken by the
        // built-in `new-window`, hence the `Ctrl-Shift-B` choice below).
        hotkeys: {
            tmuxPlugin: {
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
            },
        },
    }
}
