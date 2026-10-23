import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { io } from 'socket.io-client'

import '../../src/index.css'
import '../../src/i18n/index.js'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../../src/components/ui/dialog.js'
import { SessionTerminalPanel } from '../../src/features/session-terminal/SessionTerminalPanel.js'
import { TerminalDialogContent } from '../../src/features/session-terminal/TerminalDialogContent.js'
import type { DashboardSocket } from '../../src/session.js'
import { useVisualViewportHeight } from '../../src/lib/useVisualViewportHeight.js'

const socket = io('/dashboard', { transports: ['websocket'] }) as DashboardSocket
// Injected from workspaceTerminalDialogSizeClass by the acceptance harness,
// so production sizing changes cannot silently leave this fixture behind.
declare const __TERMINAL_DIALOG_CLASSES__: string[]

function Fixture(): JSX.Element {
  useVisualViewportHeight()
  const [terminalOpen, setTerminalOpen] = useState(true)
  const [ordinaryOpen, setOrdinaryOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      <button data-testid="ordinary-open" onClick={() => setOrdinaryOpen(true)}>Open ordinary dialog</button>
      <Dialog open={terminalOpen} onOpenChange={setTerminalOpen}>
        <TerminalDialogContent className={`${__TERMINAL_DIALOG_CLASSES__[0]} ${__TERMINAL_DIALOG_CLASSES__[expanded ? 1 : 2]}`} data-expanded={String(expanded)} data-testid="terminal-dialog" aria-describedby={undefined}>
          <DialogTitle className="sr-only">Isolated terminal</DialogTitle>
          <button className="absolute right-12 top-1.5 z-20 hidden h-8 sm:inline-flex" data-testid="terminal-expand" onClick={() => setExpanded((value) => !value)}>Size</button>
          <DialogClose className="absolute right-2 top-1 z-20 h-10 w-10" data-testid="terminal-close">Close</DialogClose>
          <div className="min-h-0 flex-1">
            <SessionTerminalPanel socket={socket} workspaceId="keyboard-workspace" sessionId="keyboard-session" autoStart />
          </div>
        </TerminalDialogContent>
      </Dialog>
      <Dialog open={ordinaryOpen} onOpenChange={setOrdinaryOpen}>
        <DialogContent data-testid="ordinary-dialog" aria-describedby={undefined}>
          <DialogTitle>Ordinary dialog</DialogTitle>
          <input aria-label="Ordinary input" />
        </DialogContent>
      </Dialog>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
