export interface TmuxPaneTooltipData {
    id: number
    title: string
    active: boolean
}

export interface TmuxWindowTooltipData {
    id: number
    name: string
    panes: TmuxPaneTooltipData[]
}

type TmuxWindowTooltipTranslator = (params: Record<string, string | number>) => string

export function formatTmuxWindowTooltip(
    data: TmuxWindowTooltipData,
    translate: TmuxWindowTooltipTranslator,
): string {
    const panes: Array<{ id: number | null; title: string; active: boolean }> = data.panes.length
        ? data.panes
        : [{ id: null, title: '', active: false }]

    return panes
        .map((pane) =>
            translate({
                marker: pane.active ? '* ' : '  ',
                id: data.id,
                name: data.name || '—',
                paneId: pane.id === null ? '—' : `%${pane.id}`,
                paneTitle: pane.title || '—',
            }),
        )
        .join('\n')
}
