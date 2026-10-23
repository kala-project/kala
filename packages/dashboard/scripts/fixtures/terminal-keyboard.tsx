import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { io } from 'socket.io-client'

import '../../src/index.css'
import '../../src/i18n/index.js'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../../src/components/ui/dialog.js'
import { SessionTerminalPanel } from '../../src/features/session-terminal/SessionTerminalPanel.js'
import { TerminalDialogContent } from '../../src/features/session-terminal/TerminalDialogContent.js'
import type { DashboardSocket } from '../../src/session.js'

const socket = io('/dashboard', { transports: ['websocket'] }) as DashboardSocket

function Fixture(): JSX.Element {
  const [terminalOpen, setTerminalOpen] = useState(true)
  const [ordinaryOpen, setOrdinaryOpen] = useState(false)
  return (
    <>
      <button data-testid="ordinary-open" onClick={() => setOrdinaryOpen(true)}>Open ordinary dialog</button>
      <Dialog open={terminalOpen} onOpenChange={setTerminalOpen}>
        <TerminalDialogContent className="flex h-[75vh] max-w-4xl flex-col p-2" data-testid="terminal-dialog" aria-describedby={undefined}>
          <DialogTitle>Isolated terminal</DialogTitle>
          <DialogClose data-testid="terminal-close">Close terminal</DialogClose>
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
