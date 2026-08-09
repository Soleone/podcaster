import type { ConversationItem } from '../../session/conversation';
import { Badge } from '../ui/badge';
import { Bubble, BubbleContent } from '../ui/bubble';
import { Marker, MarkerContent } from '../ui/marker';
import { Message, MessageContent, MessageFooter, MessageHeader } from '../ui/message';

export function conversationItemStartsTurn(item: ConversationItem): boolean {
  return item.kind === 'user';
}

export function ConversationRow({ item }: { item: ConversationItem }) {
  if (item.kind === 'continuation') return <Marker variant="separator" className="continuation-marker"><MarkerContent>{item.label}</MarkerContent></Marker>;
  if (item.kind === 'notice') return <Marker className={`conversation-notice ${item.tone}`}><MarkerContent>{item.text}</MarkerContent></Marker>;
  if (item.kind === 'user') return <Message align="end" className="conversation-message user-row">
    <MessageContent>
      <MessageHeader>You</MessageHeader>
      <Bubble variant="default"><BubbleContent className="conversation-bubble user-bubble"><p>{item.text}</p></BubbleContent></Bubble>
      {item.status === 'control' ? <MessageFooter><Badge>Control only</Badge></MessageFooter> : null}
    </MessageContent>
  </Message>;
  return <Message className="conversation-message assistant-row">
    <MessageContent>
      <MessageHeader>Companion</MessageHeader>
      <Bubble variant="secondary"><BubbleContent className="conversation-bubble assistant-bubble"><p>{item.text}</p></BubbleContent></Bubble>
      <MessageFooter><Badge>{item.playback}</Badge></MessageFooter>
    </MessageContent>
  </Message>;
}
