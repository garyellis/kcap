// Copying to the clipboard has two failure modes the async API hides: in a
// non-secure context (e.g. the container served over plain http on a LAN
// address) `navigator.clipboard` is undefined and a bare `writeText` call
// throws synchronously, and even in a secure context the returned promise can
// reject (NotAllowedError when the document is not focused). This helper tries
// the async API first, falls back to the hidden-textarea `execCommand('copy')`
// technique, and reports success so callers can show feedback either way.
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Fall through to the legacy path.
    }
  }
  return legacyCopy(text)
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  // Keep the textarea out of view without scrolling the page.
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}
