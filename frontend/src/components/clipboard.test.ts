import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyTextToClipboard } from './clipboard'

// The vitest environment is node (no jsdom), so `document` is undefined and
// the browser globals are stubbed per test. That is enough to exercise every
// branch of the helper without new test infrastructure.

function fakeDocument(execCommand: (command: string) => boolean) {
  const textarea = {
    value: '',
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    select: vi.fn(),
    remove: vi.fn(),
  }
  const document = {
    createElement: vi.fn(() => textarea),
    body: { appendChild: vi.fn() },
    execCommand: vi.fn(execCommand),
  }
  return { document, textarea }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the original bug', () => {
  it('a bare navigator.clipboard.writeText call throws synchronously when the Clipboard API is missing', () => {
    // navigator.clipboard is undefined outside secure contexts (the app served
    // over plain http on a non-localhost address), so the old handlers threw
    // before any feedback could be shown.
    vi.stubGlobal('navigator', {})
    expect(() => navigator.clipboard.writeText('anything')).toThrow(TypeError)
  })
})

describe('copyTextToClipboard', () => {
  it('resolves true via the async Clipboard API when it is available', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await expect(copyTextToClipboard('payload')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('payload')
  })

  it('resolves false instead of throwing when neither the Clipboard API nor a DOM is available', async () => {
    vi.stubGlobal('navigator', {})
    await expect(copyTextToClipboard('payload')).resolves.toBe(false)
  })

  it('falls back to execCommand("copy") when the Clipboard API is missing', async () => {
    vi.stubGlobal('navigator', {})
    const { document, textarea } = fakeDocument(() => true)
    vi.stubGlobal('document', document)
    await expect(copyTextToClipboard('payload')).resolves.toBe(true)
    expect(textarea.value).toBe('payload')
    expect(document.execCommand).toHaveBeenCalledWith('copy')
    expect(textarea.remove).toHaveBeenCalled()
  })

  it('falls back to execCommand("copy") when writeText rejects (e.g. NotAllowedError)', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('NotAllowedError')))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { document } = fakeDocument(() => true)
    vi.stubGlobal('document', document)
    await expect(copyTextToClipboard('payload')).resolves.toBe(true)
    expect(document.execCommand).toHaveBeenCalledWith('copy')
  })

  it('resolves false when the fallback path fails too', async () => {
    vi.stubGlobal('navigator', {})
    const { document, textarea } = fakeDocument(() => {
      throw new Error('copy blocked')
    })
    vi.stubGlobal('document', document)
    await expect(copyTextToClipboard('payload')).resolves.toBe(false)
    expect(textarea.remove).toHaveBeenCalled()
  })
})
