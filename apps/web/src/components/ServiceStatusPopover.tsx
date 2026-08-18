import { Activity, AlertTriangle, Check, ChevronDown, CircleAlert, RefreshCw, Server, Sparkles } from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/card';
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

function ServiceCard({ status, icon: Icon }: { status: ServiceStatuses['audio']; icon: typeof Server }) {
  const tone = stateTone[status.state];
  const StateIcon = tone.icon;
  return <Card size="sm" className="gap-2 bg-muted/20 shadow-none ring-1 ring-border/70">
    <CardHeader className="gap-2 px-3.5 pb-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground ring-1 ring-border/70"><Icon aria-hidden="true" /></span>
          <CardTitle className="truncate text-sm">{status.label}</CardTitle>
        </div>
        <Badge variant={tone.badge}><StateIcon aria-hidden="true" />{serviceStateLabel(status.state)}</Badge>
      </div>
      <CardDescription className="text-xs leading-relaxed">{status.detail}</CardDescription>
    </CardHeader>
    {status.state !== 'ready' ? <CardFooter className="border-t px-3.5 pt-2.5 pb-3.5 text-xs leading-relaxed">
      <span><span className="font-medium text-foreground">Next:</span> {status.correctiveAction}</span>
    </CardFooter> : null}
  </Card>;
}

export function ServiceStatusPopover({ statuses, onRefresh, refreshing = false }: ServiceStatusPopoverProps) {
  const aggregate = aggregateServiceState(statuses);
  const label = `Service status: audio ${serviceStateLabel(statuses.audio.state)}, Pi ${serviceStateLabel(statuses.pi.state)}`;
  return <Popover>
    <PopoverTrigger render={
      <Button
        variant="outline"
        size="sm"
        className="h-9 gap-2 rounded-full px-3 text-primary hover:text-primary"
        aria-label={label}
        title={label}
      >
        <Activity data-icon="inline-start" aria-hidden="true" />
        <StatusLed state={aggregate} />
        <span className="hidden sm:inline">Services</span>
        <ChevronDown data-icon="inline-end" aria-hidden="true" />
      </Button>
    } />
    <PopoverContent align="end" className="w-[min(22rem,calc(100vw_-_2rem))] gap-3">
      <PopoverHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <PopoverTitle>Service status</PopoverTitle>
            <PopoverDescription className="mt-1">Live health for audio and Pi.</PopoverDescription>
          </div>
          {onRefresh ? <Button variant="ghost" size="icon-xs" aria-label="Refresh service status" title="Refresh service status" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={cn(refreshing && 'animate-spin')} aria-hidden="true" />
          </Button> : null}
        </div>
      </PopoverHeader>
      <div className="flex flex-col gap-2">
        <ServiceCard status={statuses.audio} icon={Server} />
        <ServiceCard status={statuses.pi} icon={Sparkles} />
      </div>
      <p className="border-t pt-3 text-xs text-muted-foreground">This indicator updates automatically while Podcaster is open.</p>
    </PopoverContent>
  </Popover>;
}
