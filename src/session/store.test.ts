import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from './store';

const tmpDirs: string[] = [];

function makeStore(seed?: Record<string, unknown>): { store: SessionStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-omp-session-'));
  tmpDirs.push(dir);
  const file = join(dir, 'sessions.json');
  if (seed) writeFileSync(file, `${JSON.stringify(seed)}\n`, 'utf8');
  return { store: new SessionStore(file), file };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SessionStore multi-slot', () => {
  it('keeps one slot per cwd for the same chat', async () => {
    const { store } = makeStore();
    await store.load();
    store.set('chat-1', 'sess-a', '/ws/a');
    store.set('chat-1', 'sess-b', '/ws/b');

    expect(store.resumeFor('chat-1', '/ws/a')).toBe('sess-a');
    expect(store.resumeFor('chat-1', '/ws/b')).toBe('sess-b');
    expect(store.getSlot('chat-1', '/ws/a')?.sessionId).toBe('sess-a');
    expect(store.getSlot('chat-1', '/ws/b')?.sessionId).toBe('sess-b');
  });

  it('resumeFor matches the exact cwd only (slots are independent)', async () => {
    const { store } = makeStore();
    await store.load();
    store.set('chat-1', 'sess-a', '/ws/a');

    expect(store.resumeFor('chat-1', '/ws/b')).toBeUndefined();
    expect(store.resumeFor('chat-2', '/ws/a')).toBeUndefined();
    const { store: other } = makeStore();
    await other.load();
    store.set('chat-1', 'sess-a2', '/ws/a');
    expect(store.resumeFor('chat-1', '/ws/a')).toBe('sess-a2');
    expect(store.resumeFor('chat-1', '/ws/a/')).toBe('sess-a2'); // trailing slash normalizes
  });

  it('clear drops every slot and the timeout override', async () => {
    const { store } = makeStore();
    await store.load();
    store.set('chat-1', 'sess-a', '/ws/a');
    store.set('chat-1', 'sess-b', '/ws/b');
    store.setIdleTimeoutMinutes('chat-1', 15);

    store.clear('chat-1');

    expect(store.resumeFor('chat-1', '/ws/a')).toBeUndefined();
    expect(store.resumeFor('chat-1', '/ws/b')).toBeUndefined();
    expect(store.getIdleTimeoutMinutes('chat-1')).toBeUndefined();
  });

  it('idle timeout is chat-wide and survives slot writes', async () => {
    const { store } = makeStore();
    await store.load();
    store.setIdleTimeoutMinutes('chat-1', 20);
    store.set('chat-1', 'sess-a', '/ws/a');

    expect(store.getIdleTimeoutMinutes('chat-1')).toBe(20);
    expect(store.resumeFor('chat-1', '/ws/a')).toBe('sess-a');

    expect(store.clearIdleTimeoutOverride('chat-1')).toBe(true);
    expect(store.getIdleTimeoutMinutes('chat-1')).toBeUndefined();
    expect(store.resumeFor('chat-1', '/ws/a')).toBe('sess-a');
    expect(store.clearIdleTimeoutOverride('chat-1')).toBe(false);
  });

  it('persists and reloads multi-slot data', async () => {
    const { store, file } = makeStore();
    await store.load();
    store.set('chat-1', 'sess-a', '/ws/a');
    store.set('chat-1', 'sess-b', '/ws/b');
    await store.flush();

    const reloaded = new SessionStore(file);
    await reloaded.load();
    expect(reloaded.resumeFor('chat-1', '/ws/a')).toBe('sess-a');
    expect(reloaded.resumeFor('chat-1', '/ws/b')).toBe('sess-b');
  });
});

describe('SessionStore legacy migration', () => {
  it('migrates flat entries into cwd slots', async () => {
    const { store } = makeStore({
      'chat-1': { sessionId: 'sess-legacy', cwd: '/ws/a', updatedAt: 12345, idleTimeoutMinutes: 9 },
      'chat-2': { idleTimeoutMinutes: 3 },
      'chat-3': { cwd: '/ws/x' }, // no sessionId → dropped entirely
    });
    await store.load();

    expect(store.resumeFor('chat-1', '/ws/a')).toBe('sess-legacy');
    expect(store.getIdleTimeoutMinutes('chat-1')).toBe(9);
    expect(store.resumeFor('chat-1', '/ws/b')).toBeUndefined();
    expect(store.getIdleTimeoutMinutes('chat-2')).toBe(3);
    expect(store.resumeFor('chat-3', '/ws/x')).toBeUndefined();
  });

  it('rewrites persisted data in the new format', async () => {
    const { store, file } = makeStore({
      'chat-1': { sessionId: 'sess-legacy', cwd: '/ws/a', updatedAt: 12345 },
    });
    await store.load();
    await store.flush();

    const persisted = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const entry = persisted['chat-1'] as Record<string, unknown>;
    expect(entry.slots).toBeDefined();
    expect((entry.slots as Record<string, unknown>)['/ws/a']).toBeDefined();
    expect(entry.cwd).toBeUndefined();
  });
});