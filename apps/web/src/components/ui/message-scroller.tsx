import { MessageScroller as MessageScrollerPrimitive, useMessageScroller, useMessageScrollerScrollable, useMessageScrollerVisibility } from '@shadcn/react/message-scroller';
import { ArrowDownIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export function MessageScrollerProvider(props: ComponentProps<typeof MessageScrollerPrimitive.Provider>) {
  return <MessageScrollerPrimitive.Provider {...props} />;
}

export function MessageScroller({ className, ...props }: ComponentProps<typeof MessageScrollerPrimitive.Root>) {
  return <MessageScrollerPrimitive.Root data-slot="message-scroller" className={cn('group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden', className)} {...props} />;
}

export function MessageScrollerViewport({ className, ...props }: ComponentProps<typeof MessageScrollerPrimitive.Viewport>) {
  return <MessageScrollerPrimitive.Viewport data-slot="message-scroller-viewport" className={cn('size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain', className)} {...props} />;
}

export function MessageScrollerContent({ className, ...props }: ComponentProps<typeof MessageScrollerPrimitive.Content>) {
  return <MessageScrollerPrimitive.Content data-slot="message-scroller-content" className={cn('flex h-max min-h-full flex-col gap-3', className)} {...props} />;
}

export function MessageScrollerItem({ className, scrollAnchor = false, ...props }: ComponentProps<typeof MessageScrollerPrimitive.Item>) {
  return <MessageScrollerPrimitive.Item data-slot="message-scroller-item" scrollAnchor={scrollAnchor} className={cn('min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]', className)} {...props} />;
}

export function MessageScrollerButton({ direction = 'end', className, children, ...props }: ComponentProps<typeof MessageScrollerPrimitive.Button>) {
  return <MessageScrollerPrimitive.Button
    data-slot="message-scroller-button"
    direction={direction}
    className={cn('absolute bottom-3 left-1/2 z-10 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-foreground shadow transition-opacity data-[active=false]:pointer-events-none data-[active=false]:opacity-0', className)}
    {...props}
  >
    {children ?? <><ArrowDownIcon className="size-4" /><span className="visually-hidden">Jump to latest</span></>}
  </MessageScrollerPrimitive.Button>;
}

export { useMessageScroller, useMessageScrollerScrollable, useMessageScrollerVisibility };
