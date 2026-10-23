import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Dialog, DialogClose, DialogContent, DialogTitle } from '../../components/ui/dialog.js'
import { TerminalDialogContent } from './TerminalDialogContent.js'

describe('terminal modal keyboard ownership', () => {
  it('keeps focused xterm Escape available to the terminal without dismissing', async () => {
    const close = vi.fn()
    const capture = vi.fn()
    const input = vi.fn()
    render(
      <Dialog open onOpenChange={close}>
        <TerminalDialogContent onKeyDownCapture={capture}>
          <DialogTitle>Terminal</DialogTitle>
          <textarea className="xterm-helper-textarea" aria-label="Terminal input" onKeyDown={input} />
          <DialogClose>Close terminal</DialogClose>
        </TerminalDialogContent>
      </Dialog>,
    )
    const textarea = screen.getByRole('textbox')
    textarea.focus()
    fireEvent.keyDown(textarea, { key: 'Escape', keyCode: 27 })
    expect(close).not.toHaveBeenCalled()
    expect(capture).toHaveBeenCalledOnce()
    expect(input).toHaveBeenCalledOnce()
    expect(input.mock.calls[0]![0].defaultPrevented).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Close terminal' }))
    expect(close).toHaveBeenCalledWith(false)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
  })

  it('retains Escape dismissal on terminal chrome and ordinary dialogs', () => {
    const close = vi.fn()
    const { unmount } = render(
      <Dialog open onOpenChange={close}>
        <TerminalDialogContent>
          <DialogTitle>Terminal</DialogTitle>
          <button>Terminal toolbar</button>
        </TerminalDialogContent>
      </Dialog>,
    )
    const toolbar = screen.getByRole('button')
    toolbar.focus()
    fireEvent.keyDown(toolbar, { key: 'Escape', keyCode: 27 })
    expect(close).toHaveBeenCalledWith(false)
    unmount()
    close.mockClear()

    render(
      <Dialog open onOpenChange={close}>
        <DialogContent>
          <DialogTitle>Ordinary dialog</DialogTitle>
          <textarea className="xterm-helper-textarea" aria-label="Other input" />
        </DialogContent>
      </Dialog>,
    )
    const input = screen.getByRole('textbox')
    input.focus()
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 27 })
    expect(close).toHaveBeenCalledWith(false)
  })

  it('does not dismiss during terminal IME Escape or capture unrelated keys', () => {
    const close = vi.fn()
    const keyDown = vi.fn()
    render(
      <Dialog open onOpenChange={close}>
        <TerminalDialogContent>
          <DialogTitle>Terminal</DialogTitle>
          <textarea className="xterm-helper-textarea" onKeyDown={keyDown} aria-label="Terminal input" />
        </TerminalDialogContent>
      </Dialog>,
    )
    const input = screen.getByRole('textbox')
    input.focus()
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 229, isComposing: true })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 })
    fireEvent.keyDown(input, { key: 'a', keyCode: 65 })
    expect(close).not.toHaveBeenCalled()
    expect(keyDown.mock.calls.map(([event]) => event.defaultPrevented)).toEqual([true, false, false])
  })
})
