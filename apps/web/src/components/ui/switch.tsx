import { Switch as BaseSwitch } from '@base-ui/react/switch';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export function Switch({ className, ...props }: ComponentProps<typeof BaseSwitch.Root>) {
  return (
    <BaseSwitch.Root
      data-slot="switch"
      className={cn(
        'inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-border bg-muted transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 data-[checked]:border-primary data-[checked]:bg-primary',
        className,
      )}
      {...props}
    >
      <BaseSwitch.Thumb className="pointer-events-none block size-5 rounded-full bg-card shadow-sm transition-transform data-[checked]:translate-x-[22px]" />
    </BaseSwitch.Root>
  );
}
