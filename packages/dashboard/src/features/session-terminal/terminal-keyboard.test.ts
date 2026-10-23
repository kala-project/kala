import type { Terminal as XTerm } from '@xterm/xterm'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { installTerminalLineBreakInput } from './terminal-keyboard.js'

describe('xterm newline input', () => {
  let Terminal: typeof XTerm
  let terminal: XTerm
  let dispose: () => void
  let host: HTMLDivElement
  const input = vi.fn()

  beforeAll(async () => {
    const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    ;({ Terminal } = await import('@xterm/xterm'))
    canvas.mockRestore()
  })

  beforeEach(() => {
    input.mockClear()
    host = document.createElement('div')
    document.body.append(host)
    terminal = new Terminal()
    terminal.onData(input)
    terminal.open(host)
    dispose = installTerminalLineBreakInput(terminal)
  })

  afterEach(() => {
    dispose()
    terminal.dispose()
    host.remove()
  })

  it('lets xterm encode physical Enter as exactly one CR', () => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true })
    terminal.textarea!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(input.mock.calls).toEqual([['\r']])
  })

  it.each(['insertLineBreak', 'insertParagraph'])('encodes virtual-keyboard %s as one CR', (inputType) => {
    const event = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true })
    terminal.textarea!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(input.mock.calls).toEqual([['\r']])
  })

  it('preserves xterm text input and does not send physical Enter while composing', () => {
    terminal.textarea!.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '你', bubbles: true }))
    expect(input.mock.calls).toEqual([['你']])
    input.mockClear()
    terminal.textarea!.dispatchEvent(new CompositionEvent('compositionstart'))
    terminal.textarea!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }))
    expect(input).not.toHaveBeenCalled()
  })

  it('does not hijack text, composition, previously handled input, or a disposed terminal', () => {
    const textarea = terminal.textarea!
    const dispatch = (options: InputEventInit): InputEvent => {
      const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, ...options })
      textarea.dispatchEvent(event)
      return event
    }
    expect(dispatch({ inputType: 'insertText', data: 'a' }).defaultPrevented).toBe(false)
    expect(dispatch({ inputType: 'insertLineBreak', isComposing: true }).defaultPrevented).toBe(false)
    textarea.dispatchEvent(new CompositionEvent('compositionstart'))
    expect(dispatch({ inputType: 'insertLineBreak' }).defaultPrevented).toBe(false)
    textarea.dispatchEvent(new CompositionEvent('compositionend'))
    expect(dispatch({ inputType: 'insertLineBreak' }).defaultPrevented).toBe(false)
    const handled = new InputEvent('beforeinput', { inputType: 'insertLineBreak', cancelable: true })
    handled.preventDefault()
    textarea.dispatchEvent(handled)
    expect(input).not.toHaveBeenCalled()
    dispose()
    expect(dispatch({ inputType: 'insertLineBreak' }).defaultPrevented).toBe(false)
    expect(input).not.toHaveBeenCalled()
  })

  it('resumes virtual Enter after composition has settled', async () => {
    terminal.textarea!.dispatchEvent(new CompositionEvent('compositionstart'))
    terminal.textarea!.dispatchEvent(new CompositionEvent('compositionend'))
    await new Promise((resolve) => setTimeout(resolve, 1))
    input.mockClear()
    terminal.textarea!.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertLineBreak', cancelable: true }))
    expect(input.mock.calls).toEqual([['\r']])
  })
})
