import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogTitle,
  dialogMobileSheetClassName,
  dialogTouchCloseClassName,
} from './dialog.js'

describe('Dialog motion classes', () => {
  it('uses shared motion classes for overlay and content', () => {
    render(
      <Dialog open>
        <DialogContent data-testid="dialog-content">
          <DialogTitle>Dialog title</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    expect(screen.getByTestId('dialog-content').className).toContain('ak-motion-dialog')
    const overlay = document.querySelector('.ak-drawer-overlay')
    expect(overlay?.className ?? '').toContain('ak-drawer-overlay')
  })

  it('exports one mobile sheet and touch-close contract for feature dialogs', () => {
    expect(dialogMobileSheetClassName).toContain('var(--ak-viewport-h,100dvh)')
    expect(dialogMobileSheetClassName).toContain('env(safe-area-inset-bottom)')
    expect(dialogMobileSheetClassName).toContain('!top-[calc(var(--ak-viewport-offset-top,0px)+var(--ak-viewport-h,100dvh))]')
    expect(dialogMobileSheetClassName).toContain('!translate-y-[-100%]')
    expect(dialogTouchCloseClassName).toContain('h-11 w-11')
  })

  it('provides a dedicated internally scrolling body region', () => {
    render(<DialogBody data-testid="dialog-body">Body</DialogBody>)
    expect(screen.getByTestId('dialog-body').className).toContain('overflow-y-auto')
    expect(screen.getByTestId('dialog-body').className).toContain('min-h-0')
  })
})
