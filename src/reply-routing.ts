import { NewMessage, SendMessageOptions } from './types.js';

export interface MessageReplyBatch {
  messages: NewMessage[];
  sendOptions?: SendMessageOptions;
}

function getSendOptions(msg: NewMessage): SendMessageOptions | undefined {
  if (
    msg.chat_jid.startsWith('slack:') &&
    msg.thread_ts &&
    msg.thread_ts !== msg.id
  ) {
    return { threadTs: msg.thread_ts };
  }
  return undefined;
}

function sameReplyTarget(
  left: SendMessageOptions | undefined,
  right: SendMessageOptions | undefined,
): boolean {
  return left?.threadTs === right?.threadTs;
}

export function splitMessagesByReplyTarget(
  messages: NewMessage[],
): MessageReplyBatch[] {
  const batches: MessageReplyBatch[] = [];

  for (const msg of messages) {
    const sendOptions = getSendOptions(msg);
    const current = batches[batches.length - 1];

    if (current && sameReplyTarget(current.sendOptions, sendOptions)) {
      current.messages.push(msg);
      continue;
    }

    batches.push({
      messages: [msg],
      sendOptions,
    });
  }

  return batches;
}
