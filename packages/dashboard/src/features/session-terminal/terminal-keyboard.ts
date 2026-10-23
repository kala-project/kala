import type { Terminal } from '@xterm/xterm'

export function installTerminalLineBreakInput(terminal: Terminal): () => void {
  const textarea = terminal.textarea
  if (!textarea) return () => {}
  let composing = false
  let compositionEndTimer: ReturnType<typeof setTimeout> | undefined
  const compositionStart = (): void => {
    clearTimeout(compositionEndTimer)
    composing = true
  }
  const compositionEnd = (): void => {
    // xterm finalizes the textarea's composed text on the next task. The
    // Enter that confirms an IME candidate must not submit ahead of that text.
    compositionEndTimer = setTimeout(() => { composing = false }, 0)
  }
  const beforeInput = (event: InputEvent): void => {
    if (event.defaultPrevented || composing || event.isComposing) return
    if (event.inputType !== 'insertLineBreak' && event.inputType !== 'insertParagraph') return
    // Virtual keyboards can insert a newline without a keydown/keyCode=13.
    // xterm handles insertText, but not these beforeinput operations. Physical
    // Enter is already cancelled by xterm's keydown handler, so it never gets here.
    event.preventDefault()
    terminal.input('\r', true)
  }
  textarea.addEventListener('compositionstart', compositionStart)
  textarea.addEventListener('compositionend', compositionEnd)
  textarea.addEventListener('beforeinput', beforeInput)
  return () => {
    clearTimeout(compositionEndTimer)
    textarea.removeEventListener('compositionstart', compositionStart)
    textarea.removeEventListener('compositionend', compositionEnd)
    textarea.removeEventListener('beforeinput', beforeInput)
  }
}
