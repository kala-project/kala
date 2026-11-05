import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { saveFile } from './save-file.js'

describe('saveFile', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('writes through the native picker when supported', async () => {
    const write = vi.fn(async () => {})
    const close = vi.fn(async () => {})
    const showSaveFilePicker = vi.fn(async () => ({ createWritable: async () => ({ write, close }) }))
    await expect(saveFile({ suggestedName: 'a.txt', blob: new Blob(['a'], { type: 'text/plain' }) }, { ...window, showSaveFilePicker } as never)).resolves.toBe('saved')
    expect(showSaveFilePicker).toHaveBeenCalledWith({ suggestedName: 'a.txt', types: [{ description: 'text/plain', accept: { 'text/plain': ['.txt'] } }] })
    expect(write).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('treats picker cancellation as a quiet cancellation', async () => {
    const showSaveFilePicker = vi.fn(async () => { throw new DOMException('cancelled', 'AbortError') })
    await expect(saveFile({ suggestedName: 'a.txt', blob: new Blob(['a']) }, { ...window, showSaveFilePicker } as never)).resolves.toBe('cancelled')
  })

  it('falls back to a browser download when unsupported', async () => {
    vi.useFakeTimers()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await expect(saveFile({ suggestedName: 'a.txt', blob: new Blob(['a']) })).resolves.toBe('downloaded')
    expect(click).toHaveBeenCalledOnce()
    const anchor = document.querySelector('a[download="a.txt"]')
    expect(anchor?.getAttribute('href')).toBe('blob:test')
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test')
    expect(document.querySelector('a[download="a.txt"]')).toBeNull()
  })

  it('falls back to a browser download when the picker fails', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const showSaveFilePicker = vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError') })
    const pickerWindow = Object.assign(Object.create(window) as Window, { showSaveFilePicker })
    await expect(saveFile({ suggestedName: 'a.txt', blob: new Blob(['a'], { type: 'text/plain;charset=utf-8' }) }, pickerWindow as never)).resolves.toBe('downloaded')
    expect(showSaveFilePicker).toHaveBeenCalledWith({ suggestedName: 'a.txt', types: [{ description: 'text/plain', accept: { 'text/plain': ['.txt'] } }] })
    expect(click).toHaveBeenCalledOnce()
  })

  it('does not report success or start a second download if writing the selected file fails', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const close = vi.fn(async () => {})
    const write = vi.fn(async () => { throw new Error('disk full') })
    const showSaveFilePicker = vi.fn(async () => ({ createWritable: async () => ({ write, close }) }))
    const pickerWindow = Object.assign(Object.create(window) as Window, { showSaveFilePicker })

    await expect(saveFile({ suggestedName: 'archive.zip', blob: new Blob(['content']) }, pickerWindow as never))
      .rejects.toThrow('disk full')
    expect(close).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('reports a failed flush rather than claiming the selected file was saved', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const close = vi.fn(async () => { throw new Error('flush failed') })
    const showSaveFilePicker = vi.fn(async () => ({ createWritable: async () => ({ write: async () => {}, close }) }))
    const pickerWindow = Object.assign(Object.create(window) as Window, { showSaveFilePicker })

    await expect(saveFile({ suggestedName: 'archive.zip', blob: new Blob(['content']) }, pickerWindow as never))
      .rejects.toThrow('flush failed')
    expect(click).not.toHaveBeenCalled()
  })
})
