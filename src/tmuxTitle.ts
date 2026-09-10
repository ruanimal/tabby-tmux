/**
 * Build the top-level tmux session tab title.
 *
 * The legacy title is retained until both dynamic parts are available, so
 * discovery races and unavailable format values do not produce a partial
 * title.
 */
export function formatTmuxSessionTitle(
    fallbackTitle: string,
    windowName: string | null | undefined,
    hostName: string | null | undefined,
): string {
    const normalizedWindowName = windowName?.trim()
    const normalizedHostName = hostName?.trim()

    if (normalizedWindowName && normalizedHostName) {
        return `${normalizedWindowName} - ${normalizedHostName}`
    }

    return fallbackTitle
}
