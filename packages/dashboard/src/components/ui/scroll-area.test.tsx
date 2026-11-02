import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ScrollArea } from './scroll-area.js'

describe('ScrollArea viewport contract', () => {
  it('keeps imperative refs and scroll events on the actual scroll owner', () => {
    const root = createRef<HTMLDivElement>()
    const viewport = createRef<HTMLDivElement>()
    const onScroll = vi.fn()
    render(<ScrollArea ref={root} viewportRef={viewport} viewportProps={{ onScroll, 'aria-label': 'Transcript' }} className="max-h-24" contentClassName="space-y-2" data-testid="surface"><p>Transcript content</p></ScrollArea>)
    expect(root.current).toBe(screen.getByTestId('surface'))
    expect(viewport.current).toBe(screen.getByLabelText('Transcript'))
    expect(viewport.current).not.toBe(root.current)
    expect(viewport.current?.hasAttribute('data-radix-scroll-area-viewport')).toBe(true)
    expect(viewport.current?.className).toContain('max-h-[inherit]')
    fireEvent.scroll(viewport.current!)
    expect(onScroll).toHaveBeenCalledOnce()
    fireEvent.scroll(root.current!)
    expect(onScroll).toHaveBeenCalledOnce()
  })
})
