import { RotateCcw, XIcon } from 'lucide-react';
import type { ConversationItem } from '../../session/conversation';
import type { RecordingSessionViewState, RecordingTrimTarget, RecordingTrimTargetId } from '../../recording/trim-state';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Bubble, BubbleActions, BubbleContent } from '../ui/bubble';
import { Button } from '../ui/button';
import { Marker, MarkerContent } from '../ui/marker';
import { Message, MessageContent, MessageFooter, MessageHeader } from '../ui/message';

export function conversationItemStartsTurn(item: ConversationItem): boolean {
  return item.kind === 'user';
}

export interface ConversationTrimProps {
  recording: RecordingSessionViewState;
  onToggleBubbleTrim: (targetId: RecordingTrimTargetId, trimmed: boolean) => Promise<boolean>;
}

export interface ConversationRowProps extends ConversationTrimProps {
  item: ConversationItem;
  agentName?: string;
}

interface TrimAction {
  setTrimmed: boolean;
  trimmedNow: boolean;
  label: string;
  accessible: string;
}

function trimTargetId(item: ConversationItem): RecordingTrimTargetId | undefined {
  if (item.kind === 'user') return item.id ? `user:${item.id}` : undefined;
  if (item.kind === 'assistant') return item.responseId ? `assistant:${item.responseId}` : undefined;
  return undefined;
}

/**
 * Resolves whether a trim control should appear for a row and which action it
 * performs. Requires a persisted target and never shows for tentative rows.
 * Assistant targets group persisted parts under one response message. New
 * Remove actions hide while recording is off, but Undo stays available for
 * already-trimmed messages.
 */
function trimActionFor(item: ConversationItem, target: RecordingTrimTarget | undefined, enabled: boolean): TrimAction | null {
  if (!target) return null;
  if (item.kind === 'assistant' && item.tentative) return null;
  const who = item.kind === 'assistant' ? "Assistant's response" : 'your message';
  if (target.state === 'included') {
    if (!enabled) return null;
    return { setTrimmed: true, trimmedNow: false, label: 'Remove from recording', accessible: `Remove ${who} from recording` };
  }
  if (target.state === 'trimmed') {
    return { setTrimmed: false, trimmedNow: true, label: 'Undo remove', accessible: `Undo removal of ${who}` };
  }
  // Defensive mixed state: normalize every member together rather than leave a
  // partially trimmed bubble.
  if (!enabled) return null;
  return { setTrimmed: true, trimmedNow: false, label: 'Remove remainder from recording', accessible: `Remove remainder of ${who} from recording` };
}

function TrimControl({ action, targetId, pending, onToggleBubbleTrim, onPrimary }: {
  action: TrimAction;
  targetId: RecordingTrimTargetId;
  pending: boolean;
  onToggleBubbleTrim: (targetId: RecordingTrimTargetId, trimmed: boolean) => Promise<boolean>;
  onPrimary?: boolean;
}) {
  const Icon = action.trimmedNow ? RotateCcw : XIcon;
  return <Button
    variant="ghost"
    size="icon-xs"
    className={cn('trim-action', onPrimary && 'trim-action-on-primary')}
    data-trimmed={action.trimmedNow || undefined}
    aria-label={action.accessible}
    disabled={pending}
    onClick={() => void onToggleBubbleTrim(targetId, action.setTrimmed)}
  ><Icon data-icon="inline-start" aria-hidden="true" /></Button>;
}

export function ConversationRow({ item, agentName, recording, onToggleBubbleTrim }: ConversationRowProps) {
  if (item.kind === 'continuation') return <Marker variant="separator" className="continuation-marker"><MarkerContent>{item.label}</MarkerContent></Marker>;
  if (item.kind === 'notice') return <Marker className={`conversation-notice ${item.tone}`}><MarkerContent>{item.text}</MarkerContent></Marker>;
  if (item.kind === 'user') {
    const target = item.id ? recording.targets.get(`user:${item.id}`) : undefined;
    const trimmed = target?.state === 'trimmed';
    const action = trimActionFor(item, target, recording.enabled);
    return <Message align="end" className="conversation-message user-row">
      <MessageContent>
        <MessageHeader>You</MessageHeader>
        <Bubble variant="default" className="conversation-bubble-shell">
          <BubbleContent className={cn('conversation-bubble user-bubble', action && 'relative pr-9', trimmed && 'trimmed')} data-trimmed={trimmed || undefined}>
            <p>{item.text}</p>
            {action ? <BubbleActions><TrimControl action={action} targetId={target!.targetId} pending={recording.pendingTargetId === target!.targetId} onToggleBubbleTrim={onToggleBubbleTrim} onPrimary /></BubbleActions> : null}
          </BubbleContent>
        </Bubble>
        {item.status === 'control' || trimmed ? <MessageFooter>
          {item.status === 'control' ? <Badge>Control only</Badge> : null}
          {trimmed ? <span className="trim-state-note">Not included in recording</span> : null}
        </MessageFooter> : null}
      </MessageContent>
    </Message>;
  }
  const target = item.responseId ? recording.targets.get(`assistant:${item.responseId}`) : undefined;
  const trimmed = target?.state === 'trimmed';
  const action = trimActionFor(item, target, recording.enabled);
  return <Message className="conversation-message assistant-row">
    <MessageContent>
      <MessageHeader>{(agentName ?? '').trim() || 'Assistant'}</MessageHeader>
      <Bubble variant="secondary" className="conversation-bubble-shell">
        <BubbleContent className={cn('conversation-bubble assistant-bubble', action && 'relative pr-9', item.tentative && 'tentative', trimmed && 'trimmed')} data-trimmed={trimmed || undefined}>
          {item.parts && item.parts.length > 1
            ? item.parts.map((part, index) => <p key={index} className={cn(index > 0 && 'assistant-part', part.tentative && 'assistant-part-tentative')}>{part.text}</p>)
            : <p>{item.text}</p>}
          {action ? <BubbleActions><TrimControl action={action} targetId={target!.targetId} pending={recording.pendingTargetId === target!.targetId} onToggleBubbleTrim={onToggleBubbleTrim} /></BubbleActions> : null}
        </BubbleContent>
      </Bubble>
      {trimmed ? <MessageFooter><span className="trim-state-note">Not included in recording</span></MessageFooter> : null}
    </MessageContent>
  </Message>;
}
