import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const alertVariants = cva('flex items-start gap-3 rounded-lg border p-3 text-sm', {
  variants: {
    variant: {
      default: 'border-border bg-card',
      success: 'border-l-4 border-l-success bg-success/5',
      destructive: 'border-l-4 border-l-destructive bg-destructive/5',
    },
  },
  defaultVariants: { variant: 'default' },
});

export function Alert({ className, variant, ...props }: HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>) {
  return <div role="alert" data-slot="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

export { alertVariants };
