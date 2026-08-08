import type { ConversationItem } from '../../session/conversation';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';

export function ConversationRow({ item }: { item: ConversationItem }) {
  if (item.kind === 'continuation') return <p className="continuation-marker">↳ {item.label}</p>;
  if (item.kind === 'notice') return <p className={`conversation-notice ${item.tone}`}>{item.text}</p>;
  if (item.kind === 'user') return <div className="conversation-row user-row"><Card className="conversation-bubble user-bubble"><span className="speaker">You</span><p>{item.text}</p>{item.status === 'control' ? <Badge>Control only</Badge> : null}</Card></div>;
  return <div className="conversation-row assistant-row"><Card className="conversation-bubble assistant-bubble"><span className="speaker">Companion</span><p>{item.text}</p><Badge>{item.playback}</Badge></Card></div>;
}
