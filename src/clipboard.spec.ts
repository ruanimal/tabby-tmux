import { describe, expect, it, vi } from 'vitest'
import { copyTextToClipboard } from './clipboard'

describe('copyTextToClipboard', () => {
    it('uses the Clipboard API when it is available', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        const originalClipboard = navigator.clipboard
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText },
        })

        try {
            await copyTextToClipboard('session title variables')
            expect(writeText).toHaveBeenCalledWith('session title variables')
        } finally {
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: originalClipboard,
            })
        }
    })
})
