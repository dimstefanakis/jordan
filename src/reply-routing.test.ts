import { describe, expect, it } from 'vitest';

import { splitMessagesByReplyTarget } from './reply-routing.js';
import { NewMessage } from './types.js';

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: '1',
    chat_jid: 'slack:C0123456789',
    sender: 'U123',
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('splitMessagesByReplyTarget', () => {
  it('keeps top-level channel messages together', () => {
    const batches = splitMessagesByReplyTarget([
      makeMsg({ id: '1' }),
      makeMsg({ id: '2', timestamp: '2024-01-01T00:00:01.000Z' }),
    ]);

    expect(batches).toHaveLength(1);
    expect(batches[0].sendOptions).toBeUndefined();
    expect(batches[0].messages.map((m) => m.id)).toEqual(['1', '2']);
  });

  it('creates a thread batch for Slack thread replies', () => {
    const batches = splitMessagesByReplyTarget([
      makeMsg({ id: '1', thread_ts: '1704067200.000000' }),
      makeMsg({
        id: '2',
        timestamp: '2024-01-01T00:00:01.000Z',
        thread_ts: '1704067200.000000',
      }),
    ]);

    expect(batches).toHaveLength(1);
    expect(batches[0].sendOptions).toEqual({
      threadTs: '1704067200.000000',
    });
    expect(batches[0].messages.map((m) => m.id)).toEqual(['1', '2']);
  });

  it('treats Slack thread parents as top-level channel messages', () => {
    const batches = splitMessagesByReplyTarget([
      makeMsg({
        id: '1704067200.000000',
        thread_ts: '1704067200.000000',
      }),
    ]);

    expect(batches).toHaveLength(1);
    expect(batches[0].sendOptions).toBeUndefined();
  });

  it('splits when reply target changes', () => {
    const batches = splitMessagesByReplyTarget([
      makeMsg({ id: '1' }),
      makeMsg({
        id: '2',
        timestamp: '2024-01-01T00:00:01.000Z',
        thread_ts: '1704067200.000000',
      }),
      makeMsg({
        id: '3',
        timestamp: '2024-01-01T00:00:02.000Z',
        thread_ts: '1704067200.000000',
      }),
      makeMsg({ id: '4', timestamp: '2024-01-01T00:00:03.000Z' }),
    ]);

    expect(batches).toHaveLength(3);
    expect(batches.map((batch) => batch.messages.map((m) => m.id))).toEqual([
      ['1'],
      ['2', '3'],
      ['4'],
    ]);
  });

  it('ignores thread_ts for non-Slack chats', () => {
    const batches = splitMessagesByReplyTarget([
      makeMsg({
        id: '1',
        chat_jid: 'telegram:chat-1',
        thread_ts: 'thread-1',
      }),
      makeMsg({
        id: '2',
        chat_jid: 'telegram:chat-1',
        timestamp: '2024-01-01T00:00:01.000Z',
      }),
    ]);

    expect(batches).toHaveLength(1);
    expect(batches[0].sendOptions).toBeUndefined();
  });
});
