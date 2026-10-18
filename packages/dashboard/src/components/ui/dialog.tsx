import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'

import { cn } from '../../lib/utils.js'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogPortal = DialogPrimitive.Portal
export const DialogClose = DialogPrimitive.Close

// Shared, concrete contracts used by the mobile Settings and Session Settings
// surfaces. Keep feature-specific grid rows and desktop widths at each caller.
export const dialogMobileSheetClassName =
  '!bottom-auto !top-[calc(var(--ak-viewport-offset-top,0px)+var(--ak-viewport-h,100dvh))] max-h-[calc(var(--ak-viewport-h,100dvh)-env(safe-area-inset-top)-0.5rem)] w-screen max-w-none !translate-y-[-100%] gap-0 overflow-hidden rounded-b-none rounded-t-2xl p-0 pb-[env(safe-area-inset-bottom)] sm:!bottom-auto sm:!top-[calc(50%+(env(safe-area-inset-top)-env(safe-area-inset-bottom))/2)] sm:w-[calc(100vw-2rem)] sm:!translate-y-[-50%] sm:rounded-2xl sm:pb-0'

export const dialogTouchCloseClassName =
  'absolute right-2 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn('ak-drawer-overlay fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px]', className)}
    data-testid="dialog-overlay"
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // Center the dialog inside the safe area rather than the raw
        // viewport: shift the vertical center by half the difference
        // between top and bottom safe-area insets. On iOS PWA with a
        // notch this pushes the dialog down enough that the top edge
        // no longer sits under the status bar / dynamic island.
        'ak-motion-dialog fixed left-[50%] top-[calc(50%+(env(safe-area-inset-top)-env(safe-area-inset-bottom))/2)] z-50 grid max-h-[calc(var(--ak-viewport-h,100dvh)-env(safe-area-inset-top)-env(safe-area-inset-bottom)-1rem)] w-[calc(100vw-1rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 overflow-hidden border border-border/50 bg-background p-6 shadow-2xl sm:w-full sm:rounded-2xl',
        className,
      )}
      {...props}
    />
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

export function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn('flex flex-col space-y-2 text-left', className)} {...props} />
}

export function DialogBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn('min-h-0 overflow-y-auto overscroll-contain', className)} {...props} />
}

export function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)}
      {...props}
    />
  )
}

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold', className)}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName
