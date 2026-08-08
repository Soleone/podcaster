import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';
export function Alert({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <div role="alert" className={cn('rounded-lg border border-border bg-card p-3', className)} {...props} />; }
