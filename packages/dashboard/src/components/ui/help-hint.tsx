import { Slot } from '@radix-ui/react-slot'
import { Info } from 'lucide-react'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollArea } from './scroll-area.js'

let dismissActive: (() => void) | undefined
let keyboardFocus = false
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (event) => { keyboardFocus = event.key === 'Tab' || event.key.startsWith('Arrow') }, true)
  document.addEventListener('pointerdown', () => { keyboardFocus = false }, true)
}

/** Explanatory help only. Required warnings and unavailable reasons belong in the page. */
export function HelpHint({ label, children, trigger, testId }: {
  label: string
  children: ReactNode
  /** Passive help on an existing navigation trigger; clicking still only navigates. */
  trigger?: ReactElement
  testId?: string
}): JSX.Element {
  const { t } = useTranslation()
  const id = useId()
  const anchor = useRef<HTMLElement>(null)
  const popup = useRef<HTMLSpanElement>(null)
  const opening = useRef<ReturnType<typeof setTimeout>>()
  const closing = useRef<ReturnType<typeof setTimeout>>()
  const focusFrame = useRef<number>()
  const pinned = useRef(false)
  const [open, setOpen] = useState(false)
  const clearTimers = useCallback(() => {
    clearTimeout(opening.current)
    clearTimeout(closing.current)
    if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current)
    focusFrame.current = undefined
  }, [])
  const close = useCallback(() => {
    clearTimers()
    pinned.current = false
    setOpen(false)
    if (dismissActive === close) dismissActive = undefined
  }, [clearTimers])
  const show = () => {
    clearTimers()
    if (dismissActive !== close) dismissActive?.()
    dismissActive = close
    setOpen(true)
  }
  const leave = () => {
    clearTimers()
    if (!pinned.current) closing.current = setTimeout(close, 150)
  }
  useEffect(() => () => {
    clearTimers()
    if (dismissActive === close) dismissActive = undefined
  }, [clearTimers, close])
  useLayoutEffect(() => {
    if (!open || !popup.current || !anchor.current) return
    const element = popup.current
    // Native top layer escapes clipping/transforms while keeping DOM ownership
    // inside Radix's focus scope and dismissable layer.
    element.setAttribute('popover', 'manual')
    element.showPopover?.()
    const rect = anchor.current.getBoundingClientRect()
    const width = Math.min(320, window.innerWidth - 24)
    const below = window.innerHeight - rect.bottom - 20
    const above = rect.top - 20
    const useBelow = below >= Math.min(220, above)
    element.style.width = `${width}px`
    element.style.maxHeight = `${Math.max(48, useBelow ? below : above)}px`
    element.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`
    element.style.top = `${useBelow ? rect.bottom + 8 : Math.max(12, rect.top - element.getBoundingClientRect().height - 8)}px`
    const outside = (event: Event) => {
      const target = event.target as Node
      if (!element.contains(target) && !anchor.current?.contains(target)) close()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      keyboardFocus = false
      if (element.contains(document.activeElement)) anchor.current?.focus()
      close()
    }
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !element.contains(event.target)) close()
    }
    window.addEventListener('keydown', escape, true)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', close)
    window.addEventListener('popstate', close)
    window.addEventListener('hashchange', close)
    return () => {
      element.hidePopover?.()
      window.removeEventListener('keydown', escape, true)
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('popstate', close)
      window.removeEventListener('hashchange', close)
    }
  }, [open, close])
  const events = {
    'aria-describedby': open ? id : undefined,
    onMouseEnter: () => { clearTimers(); opening.current = setTimeout(show, 300) },
    onMouseLeave: leave,
    // Radix autofocus on dialog open is not a request for explanatory help.
    onFocus: () => {
      if (!keyboardFocus) return
      clearTimers()
      // Let focus scroll its trigger into view before mounting scroll dismissal.
      focusFrame.current = requestAnimationFrame(() => {
        focusFrame.current = requestAnimationFrame(() => {
          focusFrame.current = undefined
          if (anchor.current === document.activeElement) show()
        })
      })
    },
    onBlur: leave,
    onClick: () => {
      if (trigger || pinned.current) close()
      else { show(); pinned.current = true }
    },
  }
  return (
    <>
      {trigger ? <Slot {...events} ref={anchor}>{trigger}</Slot> : (
        <button
          {...events}
          ref={anchor as React.RefObject<HTMLButtonElement>}
          type="button"
          aria-label={t('common.aboutLabel', { label })}
          aria-expanded={open}
          data-testid={testId}
          className="inline-flex h-6 w-6 flex-none items-center justify-center rounded text-muted-foreground/70 align-middle hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-8 [@media(pointer:coarse)]:w-8"
        ><Info className="h-3.5 w-3.5" aria-hidden="true" /></button>
      )}
      {open ? (
        <span
          ref={popup}
          onMouseEnter={clearTimers}
          onMouseLeave={leave}
          onFocus={clearTimers}
          onBlur={leave}
          className="fixed z-[100] m-0 block max-w-[calc(100vw-24px)] overflow-hidden rounded-lg border border-border/50 bg-popover text-left text-xs font-normal normal-case leading-5 tracking-normal text-popover-foreground shadow-lg [overflow-wrap:anywhere] select-text"
        ><ScrollArea className="max-h-[inherit]" viewportClassName="overscroll-contain" viewportProps={{ id, role: 'tooltip', tabIndex: 0 }} contentClassName="p-3">{children}</ScrollArea></span>
      ) : null}
    </>
  )
}
