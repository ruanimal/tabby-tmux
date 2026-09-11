import { describe, expect, it } from 'vitest'
import {
    WHEEL_DELTA_LINE,
    WHEEL_DELTA_PAGE,
    WHEEL_DELTA_PIXEL,
    WHEEL_LINE_HEIGHT,
    clampScrollLeft,
    computeScrollHints,
    maxScrollLeft,
    resolveWheelScrollDelta,
    scrollLeftToReveal,
} from './windowBarScroll'

describe('windowBarScroll', () => {
    describe('maxScrollLeft / clampScrollLeft', () => {
        it('reports the hidden width and never goes negative', () => {
            expect(maxScrollLeft(300, 100)).toBe(200)
            expect(maxScrollLeft(80, 100)).toBe(0)
        })

        it('clamps offsets into the scrollable range', () => {
            expect(clampScrollLeft(-40, 300, 100)).toBe(0)
            expect(clampScrollLeft(120, 300, 100)).toBe(120)
            expect(clampScrollLeft(999, 300, 100)).toBe(200)
        })

        it('falls back to zero for non-finite offsets', () => {
            expect(clampScrollLeft(Number.NaN, 300, 100)).toBe(0)
            expect(clampScrollLeft(Number.POSITIVE_INFINITY, 300, 100)).toBe(200)
        })
    })

    describe('computeScrollHints', () => {
        it('reports more content on both sides while scrolled to the middle', () => {
            expect(computeScrollHints(100, 300, 100)).toEqual({
                moreLeft: true,
                moreRight: true,
            })
        })

        it('reports a single direction at the edges', () => {
            expect(computeScrollHints(0, 300, 100)).toEqual({ moreLeft: false, moreRight: true })
            expect(computeScrollHints(200, 300, 100)).toEqual({
                moreLeft: true,
                moreRight: false,
            })
        })

        it('reports no overflow when everything fits', () => {
            expect(computeScrollHints(0, 80, 100)).toEqual({ moreLeft: false, moreRight: false })
        })

        it('ignores sub-pixel scroll noise at the edges', () => {
            expect(computeScrollHints(0.4, 300, 100).moreLeft).toBe(false)
            expect(computeScrollHints(199.6, 300, 100).moreRight).toBe(false)
        })
    })

    describe('resolveWheelScrollDelta', () => {
        it('scrolls horizontally from a vertical wheel', () => {
            expect(
                resolveWheelScrollDelta(
                    { deltaX: 0, deltaY: 40, deltaMode: WHEEL_DELTA_PIXEL },
                    200,
                ),
            ).toBe(40)
        })

        it('prefers a horizontal delta when the device provides one', () => {
            expect(
                resolveWheelScrollDelta(
                    { deltaX: 25, deltaY: 40, deltaMode: WHEEL_DELTA_PIXEL },
                    200,
                ),
            ).toBe(25)
        })

        it('scales line and page deltas into pixels', () => {
            expect(
                resolveWheelScrollDelta({ deltaX: 0, deltaY: 3, deltaMode: WHEEL_DELTA_LINE }, 200),
            ).toBe(3 * WHEEL_LINE_HEIGHT)
            expect(
                resolveWheelScrollDelta(
                    { deltaX: 0, deltaY: -1, deltaMode: WHEEL_DELTA_PAGE },
                    200,
                ),
            ).toBe(-200)
        })

        it('treats a missing delta as no scroll', () => {
            expect(
                resolveWheelScrollDelta(
                    { deltaX: 0, deltaY: 0, deltaMode: WHEEL_DELTA_PIXEL },
                    200,
                ),
            ).toBe(0)
        })
    })

    describe('scrollLeftToReveal', () => {
        const strip = { scrollWidth: 900, clientWidth: 300 }

        it('keeps the offset when the tab is fully visible', () => {
            expect(
                scrollLeftToReveal(
                    { start: 120, end: 200 },
                    { start: 100, end: 400 },
                    strip.scrollWidth,
                    strip.clientWidth,
                ),
            ).toBe(100)
        })

        it('aligns a tab on the right to the viewport edge', () => {
            expect(
                scrollLeftToReveal(
                    { start: 500, end: 572 },
                    { start: 0, end: 300 },
                    strip.scrollWidth,
                    strip.clientWidth,
                ),
            ).toBe(272)
        })

        it('aligns a tab on the left to the viewport start', () => {
            expect(
                scrollLeftToReveal(
                    { start: 60, end: 132 },
                    { start: 200, end: 500 },
                    strip.scrollWidth,
                    strip.clientWidth,
                ),
            ).toBe(60)
        })

        it('keeps the left edge of a tab wider than the viewport', () => {
            expect(
                scrollLeftToReveal({ start: 500, end: 1000 }, { start: 0, end: 300 }, 1200, 300),
            ).toBe(500)
        })

        it('clamps the reveal to the strip bounds', () => {
            expect(
                scrollLeftToReveal(
                    { start: 850, end: 950 },
                    { start: 500, end: 800 },
                    strip.scrollWidth,
                    strip.clientWidth,
                ),
            ).toBe(600)
        })

        it('leaves the offset alone when the strip has no width yet', () => {
            expect(scrollLeftToReveal({ start: 40, end: 100 }, { start: 0, end: 0 }, 900, 0)).toBe(
                0,
            )
        })
    })
})
