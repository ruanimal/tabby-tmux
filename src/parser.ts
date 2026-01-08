/**
 * Layout Parser - Parse tmux layout strings into tree structure
 *
 * Layout format: WIDTHxHEIGHT,OFFSET_X,OFFSET_Y,PANE_ID
 * Containers use: {children} for horizontal split, [children] for vertical split
 *
 * Example: "89x24,0,0{44x24,0,0,0,44x24,45,0,1}"
 */

export interface LayoutNode {
    type: 'leaf' | 'hsplit' | 'vsplit'
    width: number
    height: number
    xOffset: number
    yOffset: number
    paneId?: number
    children?: LayoutNode[]
}

export class TmuxLayoutParser {
    private pos = 0
    private layout = ''

    /**
     * Parse a tmux layout string
     */
    parse(layout: string): LayoutNode | null {
        this.pos = 0
        this.layout = layout

        try {
            return this.parseNode()
        } catch (e) {
            console.error('Failed to parse layout:', e)
            return null
        }
    }

    private parseNode(): LayoutNode {
        // Parse dimensions: WIDTHxHEIGHT,OFFSET_X,OFFSET_Y
        const dims = this.parseDimensions()

        // Check for container or leaf
        const nextChar = this.layout[this.pos]

        if (nextChar === '{') {
            // Horizontal split container
            this.pos++ // skip '{'
            const children = this.parseChildren()
            this.expect('}')

            return {
                type: 'hsplit',
                ...dims,
                children
            }
        } else if (nextChar === '[') {
            // Vertical split container
            this.pos++ // skip '['
            const children = this.parseChildren()
            this.expect(']')

            return {
                type: 'vsplit',
                ...dims,
                children
            }
        } else {
            // Leaf node with pane ID
            const paneId = this.parsePaneId()
            return {
                type: 'leaf',
                ...dims,
                paneId
            }
        }
    }

    private parseDimensions(): { width: number; height: number; xOffset: number; yOffset: number } {
        const width = this.parseNumber()
        this.expect('x')
        const height = this.parseNumber()
        this.expect(',')
        const xOffset = this.parseNumber()
        this.expect(',')
        const yOffset = this.parseNumber()

        return { width, height, xOffset, yOffset }
    }

    private parsePaneId(): number {
        // Pane ID follows after a comma
        this.expect(',')
        return this.parseNumber()
    }

    private parseChildren(): LayoutNode[] {
        const children: LayoutNode[] = []

        while (true) {
            children.push(this.parseNode())

            // Check if there are more children
            if (this.layout[this.pos] === ',') {
                this.pos++ // skip ','
            } else {
                break
            }
        }

        return children
    }

    private parseNumber(): number {
        let numStr = ''
        while (this.pos < this.layout.length && /[0-9]/.test(this.layout[this.pos])) {
            numStr += this.layout[this.pos]
            this.pos++
        }

        if (numStr === '') {
            throw new Error(`Expected number at position ${this.pos}`)
        }

        return parseInt(numStr, 10)
    }

    private expect(char: string): void {
        if (this.layout[this.pos] !== char) {
            throw new Error(`Expected '${char}' at position ${this.pos}, got '${this.layout[this.pos]}'`)
        }
        this.pos++
    }
}

/**
 * State Parser - Parse pane state from capture-pane output
 */
export interface PaneState {
    cursorX: number
    cursorY: number
    cursorVisible: boolean
    cursorStyle: number
    scrollRegionTop: number
    scrollRegionBottom: number
    alternateScreen: boolean
    insertMode: boolean
    originMode: boolean
    wrapMode: boolean
    charset: number
}

export class TmuxStateParser {
    /**
     * Parse state from tmux show-pane-state output
     *
     * Format: key=value pairs separated by semicolons
     */
    parse(output: string): PaneState {
        const state: PaneState = {
            cursorX: 0,
            cursorY: 0,
            cursorVisible: true,
            cursorStyle: 0,
            scrollRegionTop: 0,
            scrollRegionBottom: 0,
            alternateScreen: false,
            insertMode: false,
            originMode: false,
            wrapMode: true,
            charset: 0
        }

        // Parse key=value pairs
        const pairs = output.split(/[;\n]/)
        for (const pair of pairs) {
            const [key, value] = pair.split('=')
            if (!key || !value) continue

            switch (key.trim()) {
                case 'cursor_x':
                    state.cursorX = parseInt(value, 10)
                    break
                case 'cursor_y':
                    state.cursorY = parseInt(value, 10)
                    break
                case 'cursor_flag':
                    state.cursorVisible = value !== '0'
                    break
                case 'cursor_style':
                    state.cursorStyle = parseInt(value, 10)
                    break
                case 'scroll_region_upper':
                    state.scrollRegionTop = parseInt(value, 10)
                    break
                case 'scroll_region_lower':
                    state.scrollRegionBottom = parseInt(value, 10)
                    break
                case 'alternate_on':
                    state.alternateScreen = value !== '0'
                    break
                case 'insert_mode':
                    state.insertMode = value !== '0'
                    break
                case 'origin_mode':
                    state.originMode = value !== '0'
                    break
                case 'wrap_mode':
                    state.wrapMode = value !== '0'
                    break
                case 'charset':
                    state.charset = parseInt(value, 10)
                    break
            }
        }

        return state
    }
}

/**
 * Helper to extract pane IDs from a layout tree
 */
export function extractPaneIds(node: LayoutNode | null): number[] {
    if (!node) return []

    if (node.type === 'leaf' && node.paneId !== undefined) {
        return [node.paneId]
    }

    if (node.children) {
        return node.children.flatMap(child => extractPaneIds(child))
    }

    return []
}
