/**
 * TmuxLayoutParser - Parse tmux layout strings to extract pane positions
 *
 * Tmux layout string format:
 * - Checksum,WxH,X,Y<content>
 * - Content can be:
 *   - Just a pane ID: "93x52,0,0,185"
 *   - Vertical split [...]: contains comma-separated panes stacked top-to-bottom
 *   - Horizontal split {...}: contains comma-separated panes arranged left-to-right
 *
 * Example: "41e9,279x71,0,0[279x40,0,0,71,279x30,0,41{147x30,0,41,72,131x30,148,41,73}]"
 */

export interface TmuxPane {
    paneId: number
    x: number
    y: number
    width: number
    height: number
}

export interface TmuxLayoutNode {
    type: 'pane' | 'horizontal' | 'vertical'
    x: number
    y: number
    width: number
    height: number
    paneId?: number
    children?: TmuxLayoutNode[]
}

/**
 * Parse a tmux layout string into a tree structure
 */
export function parseTmuxLayout(layoutStr: string): TmuxLayoutNode | null {
    if (!layoutStr) return null

    // Remove checksum if present (4 hex chars followed by comma)
    const checksumMatch = layoutStr.match(/^[0-9a-f]{4},/)
    if (checksumMatch) {
        layoutStr = layoutStr.substring(5)
    }

    try {
        return parseNode(layoutStr, 0).node
    } catch (e) {
        console.error('Failed to parse tmux layout:', e)
        return null
    }
}

interface ParseResult {
    node: TmuxLayoutNode
    consumed: number
}

/**
 * Parse a single node from the layout string
 */
function parseNode(str: string, start: number): ParseResult {
    // Parse dimension: WxH,X,Y
    const dimMatch = str.substring(start).match(/^(\d+)x(\d+),(\d+),(\d+)/)
    if (!dimMatch) {
        throw new Error(
            `Invalid dimension at position ${start}: ${str.substring(start, start + 20)}`,
        )
    }

    const width = parseInt(dimMatch[1])
    const height = parseInt(dimMatch[2])
    const x = parseInt(dimMatch[3])
    const y = parseInt(dimMatch[4])
    let pos = start + dimMatch[0].length

    // Check what follows
    if (pos >= str.length) {
        // End of string - this shouldn't happen for a complete layout
        throw new Error('Unexpected end of layout string')
    }

    const nextChar = str[pos]

    if (nextChar === '[') {
        // Vertical split (top-to-bottom) — tmux [...] = panes stacked vertically
        pos++ // skip '['
        const children: TmuxLayoutNode[] = []
        while (str[pos] !== ']') {
            const result = parseNode(str, pos)
            children.push(result.node)
            pos = result.consumed
            if (str[pos] === ',') {
                pos++ // skip comma between children
            }
        }
        pos++ // skip ']'
        return {
            node: { type: 'vertical', x, y, width, height, children },
            consumed: pos,
        }
    } else if (nextChar === '{') {
        // Horizontal split (left-to-right) — tmux {...} = panes side by side
        pos++ // skip '{'
        const children: TmuxLayoutNode[] = []
        while (str[pos] !== '}') {
            const result = parseNode(str, pos)
            children.push(result.node)
            pos = result.consumed
            if (str[pos] === ',') {
                pos++ // skip comma between children
            }
        }
        pos++ // skip '}'
        return {
            node: { type: 'horizontal', x, y, width, height, children },
            consumed: pos,
        }
    } else if (nextChar === ',' || nextChar === ']' || nextChar === '}' || pos >= str.length) {
        // This is a pane - the next number is the pane ID
        // But wait, we need to check if there's a pane ID
        // The format is WxH,X,Y,PaneID for a simple pane
        if (nextChar === ',') {
            pos++ // skip comma
            const paneIdMatch = str.substring(pos).match(/^(\d+)/)
            if (paneIdMatch) {
                const paneId = parseInt(paneIdMatch[1])
                pos += paneIdMatch[0].length
                return {
                    node: { type: 'pane', x, y, width, height, paneId },
                    consumed: pos,
                }
            }
        }
        // No pane ID found, this might be a container
        return {
            node: { type: 'pane', x, y, width, height },
            consumed: pos,
        }
    } else {
        throw new Error(`Unexpected character '${nextChar}' at position ${pos}`)
    }
}

/**
 * Flatten a layout tree into a list of panes
 */
export function flattenLayout(node: TmuxLayoutNode): TmuxPane[] {
    const panes: TmuxPane[] = []

    function traverse(n: TmuxLayoutNode) {
        if (n.type === 'pane' && n.paneId !== undefined) {
            panes.push({
                paneId: n.paneId,
                x: n.x,
                y: n.y,
                width: n.width,
                height: n.height,
            })
        }
        if (n.children) {
            for (const child of n.children) {
                traverse(child)
            }
        }
    }

    traverse(node)
    return panes
}
