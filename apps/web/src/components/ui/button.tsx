import { Button as BaseButton } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-muted text-foreground hover:bg-muted/70',
        outline: 'border border-border bg-transparent text-foreground hover:bg-muted/60',
        ghost: 'text-foreground hover:bg-muted/60',
        link: 'text-primary underline-offset-4 hover:underline',
        destructive: 'bg-destructive text-primary-foreground hover:bg-destructive/90',
      },
      size: {
        default: 'min-h-11 px-4 py-2',
        sm: 'min-h-9 rounded-md px-3 text-sm',
        lg: 'min-h-12 rounded-md px-5 text-base',
        xs: 'min-h-7 rounded-md px-2 text-xs',
        icon: 'size-9',
        'icon-sm': 'size-7',
        'icon-xs': 'size-6',
        'icon-lg': 'size-11',
      },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  },
);

export function Button({ className, variant, size, ...props }: ComponentProps<typeof BaseButton> & VariantProps<typeof buttonVariants>) {
  return <BaseButton data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
