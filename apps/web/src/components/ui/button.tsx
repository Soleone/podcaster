import { Button as BaseButton } from '@base-ui/react/button';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';
export function Button({ className, ...props }: ComponentProps<typeof BaseButton>) { return <BaseButton className={cn('inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50', className)} {...props} />; }
