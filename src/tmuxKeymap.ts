/**
 * tmuxKeymap - Map Tabby native pane-action parameters to tmux command flags.
 *
 * Pure functions, no side effects. Used by TmuxSessionTabComponent when it
 * overrides SplitTabComponent's layout-operation methods (splitTab / navigate /
 * maximize / resizePane) to re-route the native hotkeys (split-*, pane-nav-*,
 * pane-maximize, pane-increase/decrease-*) to tmux control-mode commands.
 *
 * The direction/action semantics of the two systems align:
 * - split  'r'/'b'/'l'/'t'  = pane to the right / bottom / left / top
 * - nav    'l'/'r'/'t'/'b'  = nearest pane in that direction (select-pane -L/R/U/D)
 * - resize 'v'/'h'          = increase vertical/horizontal size
 *          'dv'/'dh'        = decrease vertical/horizontal size
 */

/** Tabby SplitTabComponent split/navigate direction (SplitDirection). */
export type SplitDirection = 'r' | 't' | 'b' | 'l'

/** Tabby SplitTabComponent resizePane action (ResizeDirection). */
export type ResizeDirection = 'v' | 'dv' | 'h' | 'dh'

/**
 * Split direction → `split-window` flags.
 * Mirrors the flag map used by the pane context menu (tabContextMenu.ts):
 * right = `-h`, down = `-v`, left = `-h -b`, up = `-v -b`.
 */
export function splitWindowFlags(dir: SplitDirection): string {
    switch (dir) {
        case 'r':
            return '-h'
        case 'l':
            return '-h -b'
        case 'b':
            return '-v'
        case 't':
            return '-v -b'
    }
}

/**
 * Navigation direction → `select-pane` flag.
 * tmux semantics: -L/-R/-U/-D select the nearest pane in that direction,
 * matching Tabby's getNearestPaneInDirection().
 */
export function selectPaneFlag(dir: SplitDirection): string {
    switch (dir) {
        case 'l':
            return '-L'
        case 'r':
            return '-R'
        case 't':
            return '-U'
        case 'b':
            return '-D'
    }
}

/**
 * Tabby resizePane action → `resize-pane` flag.
 * tmux semantics: -U grows the pane upward (taller), -L grows it leftward
 * (wider); -D / -R shrink it in the respective direction.
 */
export function resizePaneFlag(action: ResizeDirection): string {
    switch (action) {
        case 'v':
            return '-U'
        case 'dv':
            return '-D'
        case 'h':
            return '-L'
        case 'dh':
            return '-R'
    }
}
