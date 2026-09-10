export const DEFAULT_TMUX_SESSION_TITLE_FORMAT = '#{window_name} - #{host}'

export interface TmuxTitleContext {
    sessionName?: string | null
    windowName?: string | null
    windowId?: number | string | null
    windowIndex?: number | string | null
    paneName?: string | null
    paneTitle?: string | null
    paneId?: number | string | null
    hostName?: string | null
}

const TITLE_VARIABLES = new Set([
    'session_name',
    'window_name',
    'window_id',
    'window_index',
    'pane_name',
    'pane_title',
    'pane_id',
    'host',
])

function normalizeValue(value: string | number | null | undefined): string | undefined {
    if (value === null || value === undefined) {
        return undefined
    }
    const normalized = String(value).trim()
    return normalized || undefined
}

function normalizeId(
    value: number | string | null | undefined,
    prefix: '@' | '%',
): string | undefined {
    const normalized = normalizeValue(value)
    if (!normalized) {
        return undefined
    }
    return normalized.startsWith(prefix) ? normalized : `${prefix}${normalized}`
}

/**
 * Build a top-level tmux session title from a user-configurable format.
 *
 * Supported variables intentionally mirror tmux's format syntax, but are
 * resolved locally and never passed to tmux as a command:
 * #{session_name}, #{window_name}, #{window_id}, #{window_index},
 * #{pane_name}, #{pane_title}, #{pane_id}, and #{host}.
 *
 * Unknown variables are preserved so a misspelling is visible. If a known
 * variable used by the format is not available yet, the fallback title is
 * retained instead of displaying a partial title during discovery.
 */
export function formatTmuxTitle(
    fallbackTitle: string,
    format: string | null | undefined,
    context: TmuxTitleContext,
): string {
    const template = normalizeValue(format) ?? DEFAULT_TMUX_SESSION_TITLE_FORMAT
    const values: Record<string, string | undefined> = {
        session_name: normalizeValue(context.sessionName),
        window_name: normalizeValue(context.windowName),
        window_id: normalizeId(context.windowId, '@'),
        window_index: normalizeValue(context.windowIndex),
        pane_name: normalizeValue(context.paneName ?? context.paneTitle),
        pane_title: normalizeValue(context.paneTitle ?? context.paneName),
        pane_id: normalizeId(context.paneId, '%'),
        host: normalizeValue(context.hostName),
    }

    let missingValue = false
    const rendered = template.replace(/#\{([a-z_][a-z0-9_]*)\}/g, (variable, name) => {
        if (!TITLE_VARIABLES.has(name)) {
            return variable
        }
        const value = values[name]
        if (value === undefined) {
            missingValue = true
            return variable
        }
        return value
    })

    if (missingValue) {
        return fallbackTitle
    }

    return rendered.trim() || fallbackTitle
}

/**
 * Backward-compatible wrapper for callers using the original fixed title API.
 */
export function formatTmuxSessionTitle(
    fallbackTitle: string,
    windowName: string | null | undefined,
    hostName: string | null | undefined,
): string {
    return formatTmuxTitle(fallbackTitle, DEFAULT_TMUX_SESSION_TITLE_FORMAT, {
        windowName,
        hostName,
    })
}
