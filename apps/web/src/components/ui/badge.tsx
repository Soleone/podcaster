import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';
export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) { return <span className={cn('inline-flex rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground', className)} {...props} />; }
