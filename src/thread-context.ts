import {
  getRecentTopLevelMessagesBefore,
  getThreadMessagesBefore,
} from './db.js';
import { NewMessage } from './types.js';

const MAX_THREAD_CONTEXT_MESSAGES = 100;
const MAX_MAIN_CHANNEL_LEAD_IN_MESSAGES = 6;

export function prependThreadContext(messages: NewMessage[]): NewMessage[] {
  const firstMessage = messages[0];
  if (!firstMessage) return messages;

  if (
    !firstMessage.chat_jid.startsWith('slack:') ||
    !firstMessage.thread_ts ||
    firstMessage.thread_ts === firstMessage.id
  ) {
    return messages;
  }

  const recentMainChannelMessages = getRecentTopLevelMessagesBefore(
    firstMessage.chat_jid,
    firstMessage.timestamp,
    MAX_MAIN_CHANNEL_LEAD_IN_MESSAGES,
    firstMessage.thread_ts,
  );
  const priorThreadMessages = getThreadMessagesBefore(
    firstMessage.chat_jid,
    firstMessage.thread_ts,
    firstMessage.timestamp,
    MAX_THREAD_CONTEXT_MESSAGES,
  );

  if (
    recentMainChannelMessages.length === 0 &&
    priorThreadMessages.length === 0
  ) {
    return messages;
  }

  const seenIds = new Set<string>();
  return [
    ...recentMainChannelMessages,
    ...priorThreadMessages,
    ...messages,
  ].filter((message) => {
    if (seenIds.has(message.id)) return false;
    seenIds.add(message.id);
    return true;
  });
}

export function prepareMessageContext(messages: NewMessage[]): NewMessage[] {
  return prependThreadContext(messages);
}
