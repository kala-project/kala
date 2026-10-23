import * as React from 'react'

import { DialogContent } from '../../components/ui/dialog.js'

export const TerminalDialogContent = React.forwardRef<
  React.ElementRef<typeof DialogContent>,
  React.ComponentPropsWithoutRef<typeof DialogContent>
>(({ onEscapeKeyDown, ...props }, ref) => (
  <DialogContent
    {...props}
    ref={ref}
    onEscapeKeyDown={(event) => {
      // Radix listens on document capture, before xterm can consume Escape.
      // Cancel dismissal only; leave propagation and xterm's own input intact.
      if (event.target instanceof HTMLTextAreaElement && event.target.classList.contains('xterm-helper-textarea')) {
        event.preventDefault()
      }
      onEscapeKeyDown?.(event)
    }}
  />
))
TerminalDialogContent.displayName = 'TerminalDialogContent'
