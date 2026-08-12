import { TmuxLayoutNode } from './layoutParser'

/**
 * Resize handler invoked when a divider is dragged.
 * `flag` is the tmux resize direction (-L/-R/-U/-D) and `amount` is the
 * number of cells to resize the pane at `paneIdA`.
 */
export type DividerResizeHandler = (
    paneIdA: number,
    flag: '-L' | '-R' | '-U' | '-D',
    amount: number,
) => void

/**
 * Generate independent divider <div> elements for adjacent pane boundaries.
 * Walks the layout tree to find sibling edges and creates draggable lines.
 * Returns the created elements so the caller can track and remove them.
 */
export function renderDividers(
    paneArea: HTMLElement,
    layoutTree: TmuxLayoutNode,
    cell: { width: number; height: number },
    onResize: DividerResizeHandler,
): HTMLElement[] {
    const elements: HTMLElement[] = []
    collectDividers(paneArea, elements, layoutTree, cell, onResize)
    return elements
}

/**
 * Recursively collect divider lines from the layout tree.
 * For each container node, consecutive children share a boundary → divider.
 *
 * tmux layout semantics:
 * - 'vertical' ([...]): children stacked top-to-bottom → horizontal divider line
 * - 'horizontal' ({...}): children side-by-side → vertical divider line
 *
 * Same-level siblings always share the same cross-axis extent (tmux guarantees
 * this for its binary splits), so divider size is simply derived from the parent.
 *
 * For container children (non-leaf), we find the actual pane IDs at the
 * boundary using helper methods so drag-resize works at every level.
 */
function collectDividers(
    paneArea: HTMLElement,
    elements: HTMLElement[],
    node: TmuxLayoutNode,
    cell: { width: number; height: number },
    onResize: DividerResizeHandler,
): void {
    if (!node.children || node.children.length < 2) {
        return
    }

    // Read pane-area padding to offset divider positions (same as applyPixelLayout)
    const cs = getComputedStyle(paneArea)
    const padL = parseFloat(cs.paddingLeft) || 0
    const padT = parseFloat(cs.paddingTop) || 0

    for (let i = 0; i < node.children.length - 1; i++) {
        const left = node.children[i]
        const right = node.children[i + 1]

        if (node.type === 'horizontal') {
            // Children are side-by-side → vertical divider between left and right
            // Divider is 1 cell wide, centered at the shared boundary
            const x = padL + (left.x + left.width) * cell.width
            const top = padT + node.y * cell.height
            const height = node.height * cell.height

            // Find the rightmost pane(s) in `left` and leftmost pane(s) in `right`
            const paneIdA = getRightmostLeafPaneId(left)
            const paneIdB = getLeftmostLeafPaneId(right)

            createDividerElement(
                paneArea,
                elements,
                'v',
                x,
                top,
                cell.width,
                height,
                paneIdA,
                paneIdB,
                cell,
                onResize,
            )
        } else {
            // Children are stacked top-to-bottom → horizontal divider between top and bottom
            // Divider is 1 cell tall, centered at the shared boundary
            const y = padT + (left.y + left.height) * cell.height
            const leftPx = padL + node.x * cell.width
            const width = node.width * cell.width

            // Find the bottommost pane(s) in `left` and topmost pane(s) in `right`
            const paneIdA = getBottommostLeafPaneId(left)
            const paneIdB = getTopmostLeafPaneId(right)

            createDividerElement(
                paneArea,
                elements,
                'h',
                leftPx,
                y,
                width,
                cell.height,
                paneIdA,
                paneIdB,
                cell,
                onResize,
            )
        }
    }

    // Recurse into children
    for (const child of node.children) {
        collectDividers(paneArea, elements, child, cell, onResize)
    }
}

/** Find the rightmost leaf pane in a layout subtree (for vertical divider) */
function getRightmostLeafPaneId(node: TmuxLayoutNode): number | undefined {
    if (node.type === 'pane') return node.paneId
    if (!node.children?.length) return undefined
    return getRightmostLeafPaneId(node.children[node.children.length - 1])
}

/** Find the leftmost leaf pane in a layout subtree (for vertical divider) */
function getLeftmostLeafPaneId(node: TmuxLayoutNode): number | undefined {
    if (node.type === 'pane') return node.paneId
    if (!node.children?.length) return undefined
    return getLeftmostLeafPaneId(node.children[0])
}

/** Find the bottommost leaf pane in a layout subtree (for horizontal divider) */
function getBottommostLeafPaneId(node: TmuxLayoutNode): number | undefined {
    if (node.type === 'pane') return node.paneId
    if (!node.children?.length) return undefined
    return getBottommostLeafPaneId(node.children[node.children.length - 1])
}

/** Find the topmost leaf pane in a layout subtree (for horizontal divider) */
function getTopmostLeafPaneId(node: TmuxLayoutNode): number | undefined {
    if (node.type === 'pane') return node.paneId
    if (!node.children?.length) return undefined
    return getTopmostLeafPaneId(node.children[0])
}

/**
 * Create a single divider DOM element with drag-to-resize behavior.
 */
function createDividerElement(
    paneArea: HTMLElement,
    elements: HTMLElement[],
    orientation: 'v' | 'h',
    x: number,
    y: number,
    w: number,
    h: number,
    paneIdA: number | undefined,
    paneIdB: number | undefined,
    cell: { width: number; height: number },
    onResize: DividerResizeHandler,
): void {
    const div = document.createElement('div')
    div.className = `tmux-divider ${orientation}`
    div.style.left = `${x}px`
    div.style.top = `${y}px`
    div.style.width = `${w}px`
    div.style.height = `${h}px`

    // Divider is already 1 cell wide/tall — natural hit target matches tmux

    if (paneIdA !== undefined && paneIdB !== undefined) {
        const onDown = (e: MouseEvent) => {
            e.preventDefault()
            e.stopPropagation()

            const startX = e.clientX
            const startY = e.clientY
            let lastSentCols = 0
            let lastSentRows = 0

            const onMove = (de: MouseEvent) => {
                document.body.style.cursor = orientation === 'v' ? 'col-resize' : 'row-resize'

                if (orientation === 'v') {
                    const deltaCols = Math.round((de.clientX - startX) / cell.width)
                    if (deltaCols !== lastSentCols) {
                        const diff = deltaCols - lastSentCols
                        const flag = diff > 0 ? '-R' : '-L'
                        onResize(paneIdA, flag, Math.abs(diff))
                        lastSentCols = deltaCols
                    }
                } else {
                    const deltaRows = Math.round((de.clientY - startY) / cell.height)
                    if (deltaRows !== lastSentRows) {
                        const diff = deltaRows - lastSentRows
                        const flag = diff > 0 ? '-D' : '-U'
                        onResize(paneIdA, flag, Math.abs(diff))
                        lastSentRows = deltaRows
                    }
                }
            }

            const onUp = () => {
                document.removeEventListener('mousemove', onMove)
                document.removeEventListener('mouseup', onUp)
                document.body.style.cursor = ''
            }

            document.addEventListener('mousemove', onMove)
            document.addEventListener('mouseup', onUp)
        }
        div.addEventListener('mousedown', onDown)
    }

    paneArea.appendChild(div)
    elements.push(div)
}
