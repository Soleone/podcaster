import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

export function BubbleGroup({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="bubble-group" className={cn('flex min-w-0 flex-col gap-2', className)} {...props} />;
}

const bubbleVariants = cva('group/bubble relative flex w-fit max-w-[80%] min-w-0 flex-col gap-1 group-data-[align=end]/message:self-end data-[variant=ghost]:max-w-full', {
  variants: {
    variant: {
      default: '*:data-[slot=bubble-content]:bg-primary *:data-[slot=bubble-content]:text-primary-foreground',
      secondary: '*:data-[slot=bubble-content]:bg-muted *:data-[slot=bubble-content]:text-foreground',
      muted: '*:data-[slot=bubble-content]:bg-muted',
      tinted: '*:data-[slot=bubble-content]:bg-primary/10 *:data-[slot=bubble-content]:text-foreground',
      outline: '*:data-[slot=bubble-content]:border-border *:data-[slot=bubble-content]:bg-background',
      ghost: 'border-none *:data-[slot=bubble-content]:rounded-none *:data-[slot=bubble-content]:bg-transparent *:data-[slot=bubble-content]:p-0',
      destructive: '*:data-[slot=bubble-content]:bg-destructive/10 *:data-[slot=bubble-content]:text-destructive',
    },
  },
  defaultVariants: { variant: 'default' },
});

export function Bubble({ variant = 'default', align = 'start', className, ...props }: ComponentProps<'div'> & VariantProps<typeof bubbleVariants> & { align?: 'start' | 'end' }) {
  return <div data-slot="bubble" data-variant={variant} data-align={align} className={cn(bubbleVariants({ variant }), className)} {...props} />;
}

export function BubbleContent({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="bubble-content" className={cn('w-fit max-w-full min-w-0 overflow-hidden rounded-xl border border-transparent px-3 py-2 text-sm leading-relaxed wrap-break-word group-data-[align=end]/bubble:self-end', className)} {...props} />;
}

export function BubbleReactions({ side = 'bottom', align = 'end', className, ...props }: ComponentProps<'div'> & { side?: 'top' | 'bottom'; align?: 'start' | 'end' }) {
  return <div data-slot="bubble-reactions" data-side={side} data-align={align} className={cn('absolute z-10 flex w-fit items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-sm data-[side=top]:top-0 data-[side=top]:-translate-y-3/4 data-[side=bottom]:bottom-0 data-[side=bottom]:translate-y-3/4 data-[align=start]:left-3 data-[align=end]:right-3', className)} {...props} />;
}
