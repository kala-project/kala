import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ReadonlyImageCanvas, ReadonlyImagePreviewDialog } from './ReadonlyImagePreview.js'

function setElementSize(element: HTMLElement, width: number, height: number): void {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height },
  })
}

function loadImage(image: HTMLImageElement, width: number, height: number): void {
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: width },
    naturalHeight: { configurable: true, value: height },
  })
  fireEvent.load(image)
}

describe('ReadonlyImagePreview', () => {
  it('uses real scroll geometry when zooming a fitted image', () => {
    render(<ReadonlyImageCanvas src="data:image/png;base64,test" alt="Test image" imageTestId="preview-image" />)
    const stage = screen.getByTestId('readonly-image-preview-stage').querySelector('[data-radix-scroll-area-viewport]') as HTMLDivElement
    setElementSize(stage, 390, 640)
    window.dispatchEvent(new Event('resize'))

    const image = screen.getByTestId('preview-image') as HTMLImageElement
    loadImage(image, 2400, 1600)

    expect(image.style.width).toBe('374px')
    expect(image.style.height).toBe('249px')
    expect(screen.getByTestId('readonly-image-preview-zoom').textContent).toBe('100%')

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(image.style.width).toBe('468px')
    expect(screen.getByTestId('readonly-image-preview-scroll-content').style.width).toBe('484px')
    expect(screen.getByTestId('readonly-image-preview-zoom').textContent).toBe('125%')

    fireEvent.click(screen.getByRole('button', { name: 'Actual size' }))
    expect(image.style.width).toBe('2400px')
    expect(screen.getByTestId('readonly-image-preview-scroll-content').style.width).toBe('2416px')

    fireEvent.click(screen.getByRole('button', { name: 'Fit image' }))
    expect(image.style.width).toBe('374px')
  })

  it('keeps mobile full-screen and tablet/desktop immersive dialog contracts together', () => {
    render(<ReadonlyImagePreviewDialog open onOpenChange={() => {}} src="data:image/png;base64,test" alt="Preview" title="Preview title" dialogTestId="preview-dialog" closeTestId="preview-close" />)
    const dialog = screen.getByTestId('preview-dialog')
    expect(dialog.className).toContain('w-screen')
    expect(dialog.className).toContain('rounded-none')
    expect(dialog.className).toContain('sm:w-[calc(100vw-1.5rem)]')
    expect(dialog.className).toContain('sm:h-[min(94dvh,64rem)]')
    expect(dialog.className).toContain('lg:h-[min(90dvh,60rem)]')
    expect(screen.getByTestId('preview-close').className).toContain('h-11 w-11')
  })
})
