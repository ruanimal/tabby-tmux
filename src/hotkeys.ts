import { Injectable } from '@angular/core'
import { HotkeyDescription, HotkeyProvider } from 'tabby-core'
import { TmuxI18nService } from './services/tmuxI18n.service'

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
    hotkeys: HotkeyDescription[] = []

    constructor(private i18n: TmuxI18nService) {
        super()
        this.updateHotkeys()
        this.i18n.languageChange$.subscribe(() => this.updateHotkeys())
    }

    async provide(): Promise<HotkeyDescription[]> {
        return this.hotkeys
    }

    private updateHotkeys(): void {
        const hotkeys: HotkeyDescription[] = [
            {
                id: 'tmuxPlugin.previous-window',
                name: this.i18n.t('hotkey.previousWindow'),
            },
            {
                id: 'tmuxPlugin.next-window',
                name: this.i18n.t('hotkey.nextWindow'),
            },
            ...Array.from({ length: 9 }, (_, i) => ({
                id: `tmuxPlugin.window-${i + 1}`,
                name: this.i18n.t('hotkey.goToWindow', { index: i + 1 }),
            })),
            {
                id: 'tmuxPlugin.new-window',
                name: this.i18n.t('hotkey.newWindow'),
            },
            {
                id: 'tmuxPlugin.toggle-tmux-mode',
                name: this.i18n.t('hotkey.toggleMode'),
            },
        ]
        this.hotkeys.splice(0, this.hotkeys.length, ...hotkeys)
    }
}
