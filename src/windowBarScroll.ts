/**
 * Layout math for the tmux window bar.
 *
 * The bar keeps every tmux window in a single horizontally scrolling row:
 * tabs never shrink or wrap, the strip scrolls instead, and the active tab is
 * scrolled into view. All of that is decided by these pure helpers so the
 * behaviour can be tested without a browser.
 */

/** `WheelEvent.deltaMode` values (DOM_DELTA_*). */
export const WHEEL_DELTA_PIXEL = 0
export const WHEEL_DELTA_LINE = 1
export const WHEEL_DELTA_PAGE = 2

/** Pixels per wheel line for browsers that report `deltaMode === WHEEL_DELTA_LINE`. */
export const WHEEL_LINE_HEIGHT = 16

/** Sub-pixel slack so a fully scrolled strip does not keep reporting overflow. */
const EDGE_EPSILON = 1

/** Which directions still have windows hidden off-screen. */
export interface ScrollHints {
    moreLeft: boolean
    moreRight: boolean
}

/** A half-open pixel range `[start, end)`. */
export interface ScrollRange {
    start: number
    end: number
}

/** Largest scrollable offset for a strip with the given metrics. */
export function maxScrollLeft(scrollWidth: number, clientWidth: number): number {
    return Math.max(0, scrollWidth - clientWidth)
}

/** Clamp a scroll offset into the strip's scrollable range. */
export function clampScrollLeft(
    scrollLeft: number,
    scrollWidth: number,
    clientWidth: number,
): number {
    if (Number.isNaN(scrollLeft)) {
        return 0
    }
    return Math.min(Math.max(scrollLeft, 0), maxScrollLeft(scrollWidth, clientWidth))
}

/** Report which edges of the strip still hide content. */
export function computeScrollHints(
    scrollLeft: number,
    scrollWidth: number,
    clientWidth: number,
): ScrollHints {
    const max = maxScrollLeft(scrollWidth, clientWidth)
    const current = clampScrollLeft(scrollLeft, scrollWidth, clientWidth)
    return {
        moreLeft: current > EDGE_EPSILON,
        moreRight: current < max - EDGE_EPSILON,
    }
}

/**
 * Convert a wheel event into a horizontal scroll delta.
 *
 * Vertical wheels scroll the strip horizontally — `overflow-x` containers are
 * useless otherwise — and Shift+wheel keeps working because a non-zero
 * `deltaX` wins over `deltaY`.
 */
export function resolveWheelScrollDelta(
    event: { deltaX: number; deltaY: number; deltaMode: number },
    viewportWidth: number,
): number {
    const raw = event.deltaX !== 0 ? event.deltaX : event.deltaY
    if (!Number.isFinite(raw)) {
        return 0
    }
    switch (event.deltaMode) {
        case WHEEL_DELTA_LINE:
            return raw * WHEEL_LINE_HEIGHT
        case WHEEL_DELTA_PAGE:
            return raw * Math.max(viewportWidth, 0)
        default:
            return raw
    }
}

/**
 * Scroll offset that reveals `item` inside `view`.
 *
 * An item fully in view leaves the offset untouched, an item to the left is
 * aligned to the viewport's left edge, and an item to the right is aligned to
 * its right edge (unless the item is wider than the viewport, in which case
 * its left edge wins — the tab start is what identifies a window).
 *
 * `view` is expected to be the strip's visible range, i.e.
 * `{ start: strip.scrollLeft, end: strip.scrollLeft + strip.clientWidth }`.
 */
export function scrollLeftToReveal(
    item: ScrollRange,
    view: ScrollRange,
    scrollWidth: number,
    clientWidth: number,
): number {
    const width = view.end - view.start
    if (width <= 0) {
        return clampScrollLeft(view.start, scrollWidth, clientWidth)
    }
    if (item.start < view.start) {
        return clampScrollLeft(item.start, scrollWidth, clientWidth)
    }
    if (item.end > view.end) {
        const itemWidth = item.end - item.start
        // An item wider than the viewport is aligned to its left edge — its
        // start is what identifies the window — everything else is aligned to
        // the right edge so the close button stays reachable.
        const target = itemWidth >= width ? item.start : item.end - width
        return clampScrollLeft(target, scrollWidth, clientWidth)
    }
    return clampScrollLeft(view.start, scrollWidth, clientWidth)
}
