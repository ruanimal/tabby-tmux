/**
 * Copy text using the Clipboard API with a browser fallback for older Tabby
 * environments where navigator.clipboard is unavailable.
 */
export async function copyTextToClipboard(text: string): Promise<void> {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        return
    }

    if (typeof document === 'undefined' || !document.body) {
        throw new Error('Clipboard is unavailable')
    }

    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand('copy')
    textarea.remove()

    if (!copied) {
        throw new Error('Clipboard copy failed')
    }
}
