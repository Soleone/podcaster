import { ScrollArea as BaseScrollArea } from '@base-ui/react/scroll-area';
import { forwardRef, type ComponentProps, type Ref } from 'react';
import { cn } from '../../lib/utils';

type ScrollAreaProps = ComponentProps<typeof BaseScrollArea.Root> & {
  viewportRef?: Ref<HTMLDivElement>;
  onViewportScroll?: ComponentProps<typeof BaseScrollArea.Viewport>['onScroll'];
};

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea({ className, children, viewportRef, onViewportScroll, ...props }, ref) {
  return <BaseScrollArea.Root ref={ref} className={cn('relative', className)} {...props}>
    <BaseScrollArea.Viewport ref={viewportRef} onScroll={onViewportScroll} className="h-full overscroll-contain">{children}</BaseScrollArea.Viewport>
    <BaseScrollArea.Scrollbar className="flex w-2 touch-none p-px"><BaseScrollArea.Thumb className="flex-1 rounded bg-muted-foreground/40" /></BaseScrollArea.Scrollbar>
  </BaseScrollArea.Root>;
});
