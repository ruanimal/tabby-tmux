import { Injectable } from '@angular/core'
import { HotkeyDescription, HotkeyProvider, TranslateService } from 'tabby-core'

/**
 * TmuxHotkeyProvider - hotkeys unique to tmux mode (window-level actions).
 *
 * Registered via HotkeyProvider so the actions appear in Tabby Settings →
 * Hotkeys, which lists every provider's provide() output and lets the user
 * rebind them (see doc/DESIGN_KEYBINDINGS.md for the design rationale).
 * Default bindings live in TmuxConfigProvider's nested `hotkeys.tmuxPlugin.*`
 * config — Tabby's getHotkeysConfigRecursive resolves the emitted id
 * `tmuxPlugin.<action>` against that tree.
 *
 * Pane-level hotkeys (split-*, pane-nav-*, pane-maximize) are NOT declared
 * here: they reuse Tabby's built-in actions and are bound in Tabby itself.
 */
@Injectable()
export class TmuxHotkeyProvider extends HotkeyProvider {
    constructor(private translate: TranslateService) {
        super()
    }

    hotkeys: HotkeyDescription[] = [
        {
            id: 'tmuxPlugin.previous-window',
            name: this.translate.instant('Tmux: Previous window'),
        },
        {
            id: 'tmuxPlugin.next-window',
            name: this.translate.instant('Tmux: Next window'),
        },
        ...Array.from({ length: 9 }, (_, i) => ({
            id: `tmuxPlugin.window-${i + 1}`,
            name: this.translate.instant(`Tmux: Go to window ${i + 1}`),
        })),
        {
            id: 'tmuxPlugin.new-window',
            name: this.translate.instant('Tmux: New window'),
        },
        {
            id: 'tmuxPlugin.toggle-tmux-mode',
            name: this.translate.instant('Tmux: Toggle tmux mode'),
        },
    ]

    async provide(): Promise<HotkeyDescription[]> {
        return this.hotkeys
    }
}
