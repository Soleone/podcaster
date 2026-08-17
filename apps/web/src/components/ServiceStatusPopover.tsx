import { AlertTriangle, Check, CircleAlert, RefreshCw, Server, Sparkles } from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from './ui/popover';
import { cn } from '../lib/utils';
import { aggregateServiceState, serviceStateLabel, type ServiceState, type ServiceStatuses } from '../services/service-status';

export interface ServiceStatusPopoverProps {
  statuses: ServiceStatuses;
  onRefresh?: (() => void) | undefined;
  refreshing?: boolean | undefined;
}

const stateTone: Record<ServiceState, { dot: string; icon: typeof Check; badge: 'default' | 'secondary' | 'destructive'; animate?: boolean }> = {
  ready: { dot: 'bg-emerald-500', icon: Check, badge: 'default' },
  starting: { dot: 'bg-amber-500', icon: RefreshCw, badge: 'secondary', animate: true },
  degraded: { dot: 'bg-amber-500', icon: AlertTriangle, badge: 'secondary' },
  unavailable: { dot: 'bg-destructive', icon: CircleAlert, badge: 'destructive' },
  login_required: { dot: 'bg-destructive', icon: CircleAlert, badge: 'destructive' },
  rate_limited: { dot: 'bg-amber-500', icon: AlertTriangle, badge: 'secondary' },
  incompatible: { dot: 'bg-destructive', icon: CircleAlert, badge: 'destructive' },
};

function StatusLed({ state, className }: { state: ServiceState; className?: string }) {
  const tone = stateTone[state];
  return <span aria-hidden="true" className={cn('inline-block size-2 rounded-full', tone.dot, tone.animate && 'animate-pulse', className)} />;
}

function ServiceRow({ status, icon: Icon }: { status: ServiceStatuses['audio']; icon: typeof Server }) {
  const tone = stateTone[status.state];
  const StateIcon = tone.icon;
  return <li className="flex items-start gap-3 border-t py-3 first:border-t-0 first:pt-0 last:pb-0">
    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Icon className="size-4" aria-hidden="true" /></span>
    <div className="min-w-0 flex-1">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{status.label}</span>
        <Badge variant={tone.badge}><StateIcon className="size-3" aria-hidden="true" />{serviceStateLabel(status.state)}</Badge>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{status.detail}</p>
      {status.state !== 'ready' ? <p className="mt-1 text-xs leading-relaxed"><span className="font-medium">Next:</span> {status.correctiveAction}</p> : null}
    </div>
  </li>;
}

export function ServiceStatusPopover({ statuses, onRefresh, refreshing = false }: ServiceStatusPopoverProps) {
  const aggregate = aggregateServiceState(statuses);
  const label = `Service status: audio ${serviceStateLabel(statuses.audio.state)}, Pi ${serviceStateLabel(statuses.pi.state)}`;
  return <Popover>
    <PopoverTrigger render={
      <Button
        variant="ghost"
        size="sm"
        className="h-9 gap-2 rounded-full px-2.5 text-muted-foreground hover:text-foreground"
        aria-label={label}
        title={label}
      >
        <StatusLed state={aggregate} />
        <span className="hidden sm:inline">Services</span>
      </Button>
    } />
    <PopoverContent align="end" className="w-[min(22rem,calc(100vw_-_2rem))] gap-3">
      <PopoverHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <PopoverTitle>Service status</PopoverTitle>
            <PopoverDescription className="mt-1">Live health for the local audio runtime and Pi.</PopoverDescription>
          </div>
          {onRefresh ? <Button variant="ghost" size="icon-xs" aria-label="Refresh service status" title="Refresh service status" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={cn(refreshing && 'animate-spin')} aria-hidden="true" />
          </Button> : null}
        </div>
      </PopoverHeader>
      <ul>
        <ServiceRow status={statuses.audio} icon={Server} />
        <ServiceRow status={statuses.pi} icon={Sparkles} />
      </ul>
      <p className="border-t pt-3 text-xs text-muted-foreground">This indicator updates automatically while Podcaster is open.</p>
    </PopoverContent>
  </Popover>;
}
