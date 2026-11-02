import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from './alert-dialog.js'

describe('AlertDialog responsive surface', () => {
  it('uses the visible viewport, safe area, and bounded internal scrolling', () => {
    render(
      <AlertDialog open>
        <AlertDialogContent data-testid="alert-dialog-content">
          <AlertDialogTitle>Confirm action</AlertDialogTitle>
          <AlertDialogDescription>Long confirmation content</AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>,
    )

    const content = screen.getByTestId('alert-dialog-content')
    expect(content.className).toContain('var(--ak-viewport-h,100dvh)')
    expect(content.className).toContain('env(safe-area-inset-top)')
    expect(content.className).toContain('env(safe-area-inset-bottom)')
    expect(content.className).toContain('overflow-hidden')
    const viewport = content.querySelector('[data-radix-scroll-area-viewport]')
    expect(viewport?.className).toContain('overscroll-contain')
    expect(viewport?.contains(screen.getByText('Long confirmation content'))).toBe(true)
    expect(content.className).toContain('w-[calc(100vw-1rem)]')
  })
})
