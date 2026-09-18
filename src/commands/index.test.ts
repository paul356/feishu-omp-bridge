import { describe, expect, it } from 'vitest';
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentAdapter } from '../agent/types';
import type { MediaCache } from '../media/cache';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { ActiveRuns } from '../bot/active-runs';
import { tryHandleCommand, type CommandContext, type Controls } from './index';

function msg(content: string, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    chatId: 'oc_test',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'user',
    messageId: 'om_msg1',
    rawContentType: 'text',
    content,
    resources: [],
    ...overrides,
  } as NormalizedMessage;
}

/** Build a CommandContext with a recording channel stub and no active run. */
function makeCtx(
  content: string,
  extra: Partial<CommandContext> = {},
): { ctx: CommandContext; sent: string[] } {
  const sent: string[] = [];
  const ctx: CommandContext = {
    channel: {
      async send(_chatId: unknown, body: { markdown: string }) {
        sent.push(body.markdown);
      },
    } as unknown as LarkChannel,
    msg: msg(content),
    scope: 'oc_test',
    chatMode: 'p2p',
    sessions: {} as SessionStore,
    workspaces: {} as WorkspaceStore,
    agent: {} as AgentAdapter,
    activeRuns: new ActiveRuns(),
    media: {} as MediaCache,
    controls: {
      restart: async () => {},
      exit: async () => {},
      configPath: '/tmp/test.json',
      cfg: {} as Controls['cfg'],
      processId: 'test',
    },
    ...extra,
  };
  return { ctx, sent };
}

describe('handleQueue', () => {
  it('without an active run enqueues the payload as a fresh message', async () => {
    const enqueued: string[] = [];
    const { ctx, sent } = makeCtx('/queue 帮我查一下', {
      enqueueAsMessage: (content) => enqueued.push(content),
    });

    const handled = await tryHandleCommand(ctx);

    expect(handled).toBe(true);
    expect(enqueued).toEqual(['帮我查一下']);
    expect(sent.some((s) => s.includes('已把这条消息作为新请求发出'))).toBe(true);
  });

  it('without an active run and without an enqueue hook falls back to a hint', async () => {
    const { ctx, sent } = makeCtx('/queue 帮我查一下');
    const handled = await tryHandleCommand(ctx);
    expect(handled).toBe(true);
    expect(sent.some((s) => s.includes('直接发送消息即可'))).toBe(true);
  });

  it('with empty args shows usage and does not enqueue', async () => {
    const enqueued: string[] = [];
    const { ctx, sent } = makeCtx('/queue', {
      enqueueAsMessage: (content) => enqueued.push(content),
    });
    const handled = await tryHandleCommand(ctx);
    expect(handled).toBe(true);
    expect(enqueued).toEqual([]);
    expect(sent.some((s) => s.includes('用法'))).toBe(true);
  });
});