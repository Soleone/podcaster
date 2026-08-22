import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export function BubbleActions({
  align = 'end',
  className,
  ...props
}: ComponentProps<'div'> & { align?: 'start' | 'end' }) {
  return (
    <div
      data-slot="bubble-actions"
      data-align={align}
      className={cn(
        'absolute top-1 z-10 flex items-center gap-1 data-[align=start]:left-1 data-[align=end]:right-1',
        className,
      )}
      {...props}
    />
  );
}
