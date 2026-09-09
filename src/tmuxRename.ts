/**
 * Normalize user input before sending it as a tmux name/title.
 * Tmux commands are line-oriented, so embedded line breaks are converted to
 * spaces instead of being allowed to terminate or split a command.
 */
export function normalizeRename(value: string | null): string | null {
    if (value === null) return null

    const normalized = value.replace(/[\r\n]+/g, ' ').trim()
    return normalized || null
}

/** Quote one argument for a tmux command sent through Control Mode. */
export function quoteTmuxArgument(value: string): string {
    const escaped = value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\$/g, '\\$')
        .replace(/`/g, '\\`')
    return `"${escaped}"`
}

/** Decode the backslash escaping used by tmux's q: format modifier. */
export function unescapeTmuxValue(value: string): string {
    if (value === "''" || value === '""') return ''
    return value.replace(/\\(.)/g, '$1')
}

export interface TmuxWindowRenameTarget {
    id: number
    name: string
}

interface TmuxWindowLookup {
    getWindowIdForPane(paneId: number): number | null
    getWindowState(windowId: number): { name: string } | undefined
}

/** Find the window rename target for a pane context menu action. */
export function getTmuxWindowRenameTarget(
    controller: TmuxWindowLookup,
    paneId: number,
): TmuxWindowRenameTarget | null {
    const windowId = controller.getWindowIdForPane(paneId)
    if (windowId === null) return null

    const window = controller.getWindowState(windowId)
    if (!window) return null

    return { id: windowId, name: window.name }
}
