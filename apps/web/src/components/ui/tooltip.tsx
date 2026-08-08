import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
export const TooltipProvider = BaseTooltip.Provider;
export const Tooltip = BaseTooltip.Root;
export const TooltipTrigger = BaseTooltip.Trigger;
export function TooltipContent(props: React.ComponentProps<typeof BaseTooltip.Popup>) { return <BaseTooltip.Portal><BaseTooltip.Positioner sideOffset={6}><BaseTooltip.Popup className="rounded bg-foreground px-2 py-1 text-xs text-background" {...props} /></BaseTooltip.Positioner></BaseTooltip.Portal>; }
