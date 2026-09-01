import type { PiSettings } from '@app/contracts/settings';
import { Activity, AlertTriangle, Check, ChevronDown, CircleAlert, RefreshCw, Server, Sparkles } from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/card';
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from './ui/popover';
import { Progress } from './ui/progress';
import { cn } from '../lib/utils';
import {
  aggregateServiceState,
  serviceCheckStateLabel,
  serviceStateLabel,
  type ServiceCheck,
  type ServiceCheckState,
  type ServiceState,
  type ServiceStatus,
  type ServiceStatuses,
} from '../services/service-status';

export interface ServiceStatusPopoverProps {
  statuses: ServiceStatuses;
  onRefresh?: (() => void) | undefined;
  refreshing?: boolean | undefined;
  piSettings?: PiSettings | undefined;
  privacyAcknowledged?: boolean | undefined;
  connected?: boolean | undefined;
  onConnect?: (() => void) | undefined;
  microphoneGranted?: boolean | undefined;
  onEnableMicrophone?: (() => void | Promise<void>) | undefined;
}

const stateTone = {
  ready: { dot: 'bg-emerald-500', icon: Check, badge: 'default', animate: false },
  starting: { dot: 'bg-amber-500', icon: RefreshCw, badge: 'secondary', animate: true },
  degraded: { dot: 'bg-amber-500', icon: AlertTriangle, badge: 'secondary', animate: false },
  unavailable: { dot: 'bg-destructive', icon: CircleAlert, badge: 'destructive', animate: false },
  login_required: { dot: 'bg-destructive', icon: CircleAlert, badge: 'destructive', animate: false },
  rate_limited: { dot: 'bg-amber-500', icon: AlertTriangle, badge: 'secondary', animate: false },
  incompatible: { dot: 'bg-destructive', icon: CircleAlert, badge: 'destructive', animate: false },
} satisfies Record<
  ServiceState,
  { dot: string; icon: typeof Check; badge: 'default' | 'secondary' | 'destructive'; animate?: boolean }
>;

const checkTone = {
  ready: 'bg-emerald-500',
  starting: 'bg-amber-500 animate-pulse',
  warming: 'bg-amber-500 animate-pulse',
  needs_action: 'bg-amber-500',
  unavailable: 'bg-destructive',
} satisfies Record<ServiceCheckState, string>;

function StatusLed({ state, className }: { state: ServiceState; className?: string }) {
  const tone = stateTone[state];
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-2 rounded-full', tone.dot, tone.animate && 'animate-pulse', className)}
    />
  );
}

function ServiceChecks({ checks }: { checks: readonly ServiceCheck[] }) {
  return (
    <ul className="mt-2 flex flex-col gap-1.5 border-t pt-2" aria-label="Service components">
      {checks.map((check) => (
        <li key={check.label} className="flex items-start gap-2 text-xs">
          <span aria-hidden="true" className={cn('mt-1 size-1.5 shrink-0 rounded-full', checkTone[check.state])} />
          <span className="min-w-0 flex-1">
            <span className="font-medium">{check.label}</span>
            <span className="text-muted-foreground"> · {serviceCheckStateLabel(check.state)}</span>
            {check.detail ? <span className="block text-muted-foreground">{check.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ServiceCard({
  status,
  icon: Icon,
  piSettings,
  microphoneGranted,
  onEnableMicrophone,
}: {
  status: ServiceStatus;
  icon: typeof Server;
  piSettings?: PiSettings | undefined;
  microphoneGranted?: boolean | undefined;
  onEnableMicrophone?: (() => void | Promise<void>) | undefined;
}) {
  const tone = stateTone[status.state];
  const StateIcon = tone.icon;
  const detail =
    status.label === 'Pi service' && status.state === 'ready' && piSettings
      ? `Loaded with ${piSettings.model} at ${piSettings.thinkingLevel} thinking.`
      : status.detail;
  return (
    <Card size="sm" className="gap-2 bg-muted/20 shadow-none ring-1 ring-border/70">
      <CardHeader className="gap-2 px-3.5 pb-0">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground ring-1 ring-border/70">
              <Icon aria-hidden="true" />
            </span>
            <CardTitle className="truncate text-sm">{status.label}</CardTitle>
          </div>
          <Badge variant={tone.badge}>
            <StateIcon aria-hidden="true" />
            {serviceStateLabel(status.state)}
          </Badge>
        </div>
        <CardDescription className="text-xs leading-relaxed">{detail}</CardDescription>
        {status.progress !== undefined && status.state !== 'ready' ? (
          <Progress
            value={status.progress}
            aria-label={`${status.label} readiness progress`}
            className="gap-0 [&_[data-slot=progress-track]]:h-1.5 [&_[data-slot=progress-indicator]]:bg-primary"
          />
        ) : null}
        {status.checks?.length ? <ServiceChecks checks={status.checks} /> : null}
      </CardHeader>
      {status.state !== 'ready' || (status.label === 'Audio server' && microphoneGranted === false) ? (
        <CardFooter className="flex flex-col items-start gap-2 border-t px-3.5 pt-2.5 pb-3.5 text-xs leading-relaxed">
          <span>
            <span className="font-medium text-foreground">Next:</span>{' '}
            {status.label === 'Audio server' && microphoneGranted === false
              ? 'Enable microphone permission before starting a voice session.'
              : status.correctiveAction}
          </span>
          {status.label === 'Audio server' && microphoneGranted === false && onEnableMicrophone ? (
            <Button variant="outline" size="sm" onClick={() => void onEnableMicrophone()}>
              Enable microphone
            </Button>
          ) : null}
        </CardFooter>
      ) : null}
    </Card>
  );
}

export function ServiceStatusPopover({
  statuses,
  onRefresh,
  refreshing = false,
  piSettings,
  privacyAcknowledged = true,
  connected = true,
  onConnect,
  microphoneGranted,
  onEnableMicrophone,
}: ServiceStatusPopoverProps) {
  const aggregate = aggregateServiceState(statuses);
  const needsConnection = !privacyAcknowledged || !connected;
  const label = `Service status: audio ${serviceStateLabel(statuses.audio.state)}, Pi ${serviceStateLabel(statuses.pi.state)}`;
  return (
    <Popover>
      <PopoverTrigger
        render={
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
        }
      />
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw_-_2rem))] gap-3">
        <PopoverHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <PopoverTitle>Service status</PopoverTitle>
              <PopoverDescription className="mt-1">Live readiness for audio and Pi.</PopoverDescription>
            </div>
            {onRefresh ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Refresh service status"
                title="Refresh service status"
                onClick={onRefresh}
                disabled={refreshing}
              >
                <RefreshCw className={cn(refreshing && 'animate-spin')} aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        </PopoverHeader>
        <div className="flex flex-col gap-2">
          {needsConnection ? (
            <div className="rounded-lg border bg-muted/20 p-3 text-sm leading-relaxed">
              <p>
                {privacyAcknowledged
                  ? 'Services need to reconnect before a live session can start.'
                  : 'Connect services to check local audio and Pi. You can create and edit a session before connecting.'}
              </p>
              {onConnect ? (
                <Button className="mt-3 w-full" size="sm" onClick={onConnect}>
                  {privacyAcknowledged ? 'Reconnect services' : 'Review privacy & connect'}
                </Button>
              ) : null}
            </div>
          ) : null}
          <ServiceCard
            status={statuses.audio}
            icon={Server}
            microphoneGranted={microphoneGranted}
            onEnableMicrophone={onEnableMicrophone}
          />
          <ServiceCard status={statuses.pi} icon={Sparkles} piSettings={piSettings} />
        </div>
        <p className="border-t pt-3 text-xs text-muted-foreground">
          A session stays Not started until its required services are ready and live capture begins.
        </p>
      </PopoverContent>
    </Popover>
  );
}
