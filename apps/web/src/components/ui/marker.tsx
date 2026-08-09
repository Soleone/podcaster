import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const markerVariants = cva("group/marker relative flex min-h-4 w-full items-center gap-2 text-left text-sm text-muted-foreground [&_svg:not([class*='size-'])]:size-4", {
  variants: {
    variant: {
      default: '',
      separator: 'before:mr-1 before:h-px before:min-w-0 before:flex-1 before:bg-border after:ml-1 after:h-px after:min-w-0 after:flex-1 after:bg-border',
      border: 'border-b border-border pb-2',
    },
  },
  defaultVariants: { variant: 'default' },
});

export function Marker({ className, variant = 'default', ...props }: ComponentProps<'div'> & VariantProps<typeof markerVariants>) {
  return <div data-slot="marker" data-variant={variant} className={cn(markerVariants({ variant }), className)} {...props} />;
}

export function MarkerIcon({ className, ...props }: ComponentProps<'span'>) {
  return <span data-slot="marker-icon" aria-hidden="true" className={cn('size-4 shrink-0', className)} {...props} />;
}

export function MarkerContent({ className, ...props }: ComponentProps<'span'>) {
  return <span data-slot="marker-content" className={cn('min-w-0 wrap-break-word group-data-[variant=separator]/marker:flex-none group-data-[variant=separator]/marker:text-center', className)} {...props} />;
}

export { markerVariants };
