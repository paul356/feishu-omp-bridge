import { describe, expect, it } from 'vitest';
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentRun } from '../agent/types';
import type { MediaCache } from '../media/cache';
import { ActiveRuns } from './active-runs';
import { submitMessageToRun } from './submit';

async function* emptyEvents() {
  return;
}

function msg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    chatId: 'oc_test',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'user',
    messageId: 'om_msg1',
    rawContentType: 'text',
    content: 'hello',
    resources: [],
    ...overrides,
  } as NormalizedMessage;
}

function fakeMedia(count: number): Pick<MediaCache, 'resolve'> {
  const paths = Array.from({ length: count }, (_, i) => `/tmp/img-${i}.png`);
  return {
    async resolve() {
      return paths.map((path) => ({ kind: 'image', path, originalName: undefined }));
    },
  } as Pick<MediaCache, 'resolve'>;
}

function runHarness() {
  const activeRuns = new ActiveRuns();
  const prompts: Array<{ kind: string; message: string; imagePaths?: string[]; streamingBehavior?: string }> = [];
  const run: AgentRun = {
    events: emptyEvents(),
    stop: async () => {},
    waitForExit: async () => true,
    async submitPrompt(kind, message, imagePaths, streamingBehavior) {
      prompts.push({ kind, message, imagePaths, streamingBehavior });
      return true;
    },
  };
  const handle = activeRuns.register('scope-1', run);
  return { activeRuns, run, prompts, handle };
}

describe('submitMessageToRun', () => {
  it('returns false when no active run exists for the scope', async () => {
    const activeRuns = new ActiveRuns();
    const ok = await submitMessageToRun(
      {
        channel: {} as LarkChannel,
        activeRuns,
        media: fakeMedia(0) as MediaCache,
        msg: msg(),
        scope: 'scope-1',
      },
      'steer',
    );
    expect(ok).toBe(false);
  });

  it('submits with the given kind, prompt text, and queues the reply target', async () => {
    const { activeRuns, prompts, handle } = runHarness();
    const ok = await submitMessageToRun(
      { channel: {} as LarkChannel, activeRuns, media: fakeMedia(0) as MediaCache, msg: msg(), scope: 'scope-1' },
      'follow_up',
    );
    expect(ok).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.kind).toBe('follow_up');
    expect(prompts[0]!.message).toContain('<bridge_context>');
    expect(prompts[0]!.message).toContain('hello');
    expect(handle.pendingReplyTargets).toEqual(['om_msg1']);
  });

  it('uses textOverride as the message body (e.g. /queue payload)', async () => {
    const { activeRuns, prompts, handle } = runHarness();
    const ok = await submitMessageToRun(
      { channel: {} as LarkChannel, activeRuns, media: fakeMedia(0) as MediaCache, msg: msg(), scope: 'scope-1' },
      'follow_up',
      'do the thing',
    );
    expect(ok).toBe(true);
    expect(prompts[0]!.message).toContain('do the thing');
    expect(prompts[0]!.message).not.toContain('hello');
    // The new reply window still threads to the /queue message itself.
    expect(handle.pendingReplyTargets).toEqual(['om_msg1']);
  });

  it('passes image paths for attachment-bearing messages', async () => {
    const { activeRuns, prompts } = runHarness();
    const m = msg({ resources: [{ fileKey: 'file-key-1' } as never] });
    const ok = await submitMessageToRun(
      { channel: {} as LarkChannel, activeRuns, media: fakeMedia(1) as MediaCache, msg: m, scope: 'scope-1' },
      'steer',
    );
    expect(ok).toBe(true);
    expect(prompts[0]!.kind).toBe('steer');
    expect(prompts[0]!.imagePaths).toEqual(['/tmp/img-0.png']);
    expect(prompts[0]!.message).toContain('附件（本地路径）');
  });

  it('routes slash text via the prompt frame verbatim (steer semantics)', async () => {
    const { activeRuns, prompts, handle } = runHarness();
    const m = msg({ content: '/compact' });
    const ok = await submitMessageToRun(
      { channel: {} as LarkChannel, activeRuns, media: fakeMedia(0) as MediaCache, msg: m, scope: 'scope-1' },
      'steer',
    );
    expect(ok).toBe(true);
    expect(prompts[0]!.kind).toBe('prompt');
    expect(prompts[0]!.message).toBe('/compact');
    expect(prompts[0]!.streamingBehavior).toBe('steer');
    expect(handle.pendingReplyTargets).toEqual(['om_msg1']);
  });

  it('routes /queue payload starting with / via followUp semantics', async () => {
    const { activeRuns, prompts } = runHarness();
    const ok = await submitMessageToRun(
      { channel: {} as LarkChannel, activeRuns, media: fakeMedia(0) as MediaCache, msg: msg(), scope: 'scope-1' },
      'follow_up',
      '/compact keep',
    );
    expect(ok).toBe(true);
    expect(prompts[0]!.kind).toBe('prompt');
    expect(prompts[0]!.message).toBe('/compact keep');
    expect(prompts[0]!.streamingBehavior).toBe('followUp');
  });
});