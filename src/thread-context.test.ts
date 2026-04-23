import { beforeEach, describe, expect, it } from 'vitest';

import { ASSISTANT_NAME } from './config.js';
import { _initTestDatabase, storeChatMetadata, storeMessage } from './db.js';
import { prependThreadContext } from './thread-context.js';
import { NewMessage } from './types.js';

beforeEach(() => {
  _initTestDatabase();
});

function store(message: NewMessage): void {
  storeMessage(message);
}

describe('prependThreadContext', () => {
  it('prepends prior Slack thread history, including the parent message', () => {
    storeChatMetadata('slack:C0123456789', '2024-01-01T00:00:00.000Z');

    store({
      id: '1704067200.000000',
      chat_jid: 'slack:C0123456789',
      sender: 'U1',
      sender_name: 'Alice',
      content: 'parent message',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
    });
    store({
      id: '1704067205.000000',
      chat_jid: 'slack:C0123456789',
      sender: 'U2',
      sender_name: 'Bob',
      content: 'earlier reply',
      timestamp: '2024-01-01T00:00:02.000Z',
      thread_ts: '1704067200.000000',
      is_from_me: false,
    });
    store({
      id: '1704067210.000000',
      chat_jid: 'slack:C0123456789',
      sender: 'BOT',
      sender_name: ASSISTANT_NAME,
      content: 'assistant reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      thread_ts: '1704067200.000000',
      is_from_me: true,
      is_bot_message: true,
    });

    const result = prependThreadContext([
      {
        id: '1704067220.000000',
        chat_jid: 'slack:C0123456789',
        sender: 'U3',
        sender_name: 'Carol',
        content: 'latest reply',
        timestamp: '2024-01-01T00:00:04.000Z',
        thread_ts: '1704067200.000000',
        is_from_me: false,
      },
    ]);

    expect(result.map((message) => message.id)).toEqual([
      '1704067200.000000',
      '1704067205.000000',
      '1704067210.000000',
      '1704067220.000000',
    ]);
  });

  it('includes recent top-level channel lead-in before thread history', () => {
    storeChatMetadata('slack:C0123456789', '2024-01-01T00:00:00.000Z');

    store({
      id: '1704067190.000000',
      chat_jid: 'slack:C0123456789',
      sender: 'U0',
      sender_name: 'Jim',
      content: 'can you look at DiDi AU again?',
      timestamp: '2024-01-01T00:00:00.500Z',
      is_from_me: false,
    });
    store({
      id: '1704067200.000000',
      chat_jid: 'slack:C0123456789',
      sender: 'BOT',
      sender_name: ASSISTANT_NAME,
      content: 'There are a handful of US market submissions here',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: true,
      is_bot_message: true,
    });
    store({
      id: '1704067205.000000',
      chat_jid: 'slack:C0123456789',
      sender: 'U2',
      sender_name: 'Bob',
      content: 'look again, I am seeing AU market region',
      timestamp: '2024-01-01T00:00:02.000Z',
      thread_ts: '1704067200.000000',
      is_from_me: false,
    });

    const result = prependThreadContext([
      {
        id: '1704067220.000000',
        chat_jid: 'slack:C0123456789',
        sender: 'U3',
        sender_name: 'Jim',
        content: 'did you find US market from their profile or somewhere else?',
        timestamp: '2024-01-01T00:00:04.000Z',
        thread_ts: '1704067200.000000',
        is_from_me: false,
      },
    ]);

    expect(result.map((message) => message.id)).toEqual([
      '1704067190.000000',
      '1704067200.000000',
      '1704067205.000000',
      '1704067220.000000',
    ]);
  });

  it('does not prepend anything for non-thread Slack messages', () => {
    const message: NewMessage = {
      id: '1704067200.000000',
      chat_jid: 'slack:C0123456789',
      sender: 'U1',
      sender_name: 'Alice',
      content: 'top-level message',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
    };

    expect(prependThreadContext([message])).toEqual([message]);
  });
});
