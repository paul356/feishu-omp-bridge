import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';

/** One resumable OMP session slot, keyed by its cwd inside `ChatSession.slots`. */
export interface SessionSlot {
  /** May be absent only in legacy data; `resumeFor` treats absence as "no resumable session". */
  sessionId?: string;
  updatedAt: number;
}

/**
 * All resumable sessions for one chat (scope), split per working directory.
 * A chat keeps one slot per workspace it has ever worked in, so switching
 * back to a previous cwd resumes that workspace's session instead of
 * starting fresh. `idleTimeoutMinutes` is a chat-wide preference and is
 * deliberately stored outside the slots.
 */
export interface ChatSession {
  /** Absolute cwd → slot. */
  slots: Record<string, SessionSlot>;
  idleTimeoutMinutes?: number;
}

type SessionMap = Record<string, ChatSession>;

export class SessionStore {
  private data: SessionMap = {};
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string = paths.sessionsFile) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const raw = JSON.parse(text) as Record<string, unknown>;
      this.data = {};
      let migrated = false;
      for (const [chatId, value] of Object.entries(raw)) {
        const entry = value as Record<string, unknown>;
        if (!entry || typeof entry !== 'object') continue;
        if (entry.slots && typeof entry.slots === 'object' && !('cwd' in entry)) {
          // Current format: ChatSession { slots, idleTimeoutMinutes? }.
          const slots = this.parseSlots(entry.slots as Record<string, unknown>);
          const idleTimeoutMinutes =
            typeof entry.idleTimeoutMinutes === 'number' ? entry.idleTimeoutMinutes : undefined;
          if (Object.keys(slots).length === 0 && idleTimeoutMinutes === undefined) continue;
          this.data[chatId] = {
            slots,
            ...(idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes } : {}),
          };
        } else {
          // Legacy flat entry: { sessionId?, cwd?, updatedAt?, idleTimeoutMinutes? }.
          migrated = true;
          const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : undefined;
          const cwd = typeof entry.cwd === 'string' ? entry.cwd : undefined;
          const updatedAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : undefined;
          const idleTimeoutMinutes =
            typeof entry.idleTimeoutMinutes === 'number' ? entry.idleTimeoutMinutes : undefined;
          const hasSession = sessionId !== undefined && cwd !== undefined;
          if (!hasSession && idleTimeoutMinutes === undefined) continue;
          const slots = hasSession
            ? { [resolve(cwd)]: { sessionId: sessionId as string, updatedAt: updatedAt ?? Date.now() } }
            : {};
          this.data[chatId] = {
            slots,
            ...(idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes } : {}),
          };
        }
      }
      // Persist the migration once so the on-disk file adopts the new
      // format without waiting for the next write.
      if (migrated) this.schedulePersist();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  /**
   * Return the session id for this chat working in the given cwd.
   * Sessions recorded in a different cwd are another workspace's slot;
   * OMP resumes a session from the cwd it was created in, so lookups must
   * match the exact cwd.
   */
  resumeFor(chatId: string, cwd: string): string | undefined {
    return this.data[chatId]?.slots[resolve(cwd)]?.sessionId;
  }

  /** The current cwd's slot for this chat (for status display). */
  getSlot(chatId: string, cwd: string): SessionSlot | undefined {
    return this.data[chatId]?.slots[resolve(cwd)];
  }

  set(chatId: string, sessionId: string, cwd: string): void {
    const chat = this.data[chatId] ?? { slots: {} };
    chat.slots[resolve(cwd)] = { sessionId, updatedAt: Date.now() };
    this.data[chatId] = chat;
    this.schedulePersist();
  }

  /**
   * Drop only the given working directory's session slot for this chat
   * (/new, /reset). Other directories' slots and the chat-wide idle-timeout
   * override are kept — sessions are per-directory, so resetting one
   * workspace must not disturb the others. Returns true if a slot was
   * actually removed.
   */
  clearSlot(chatId: string, cwd: string): boolean {
    const chat = this.data[chatId];
    if (!chat) return false;
    const key = resolve(cwd);
    if (!(key in chat.slots)) return false;
    delete chat.slots[key];
    // Prune the chat entry once it holds nothing but an idle-timeout
    // override — `load` treats such entries as absent anyway, so keep the
    // file in that shape.
    if (Object.keys(chat.slots).length === 0 && chat.idleTimeoutMinutes === undefined) {
      delete this.data[chatId];
    }
    this.schedulePersist();
    return true;
  }

  /** Per-chat idle-timeout override. `undefined` means no override set. */
  getIdleTimeoutMinutes(chatId: string): number | undefined {
    return this.data[chatId]?.idleTimeoutMinutes;
  }

  setIdleTimeoutMinutes(chatId: string, minutes: number): void {
    const clamped = Math.min(Math.max(Math.floor(minutes), 0), 120);
    const prev = this.data[chatId];
    this.data[chatId] = {
      slots: prev?.slots ?? {},
      idleTimeoutMinutes: clamped,
    };
    this.schedulePersist();
  }

  /** Remove the override so this scope falls back to the global default.
   * Returns true if something was actually removed. */
  clearIdleTimeoutOverride(chatId: string): boolean {
    const prev = this.data[chatId];
    if (!prev || prev.idleTimeoutMinutes === undefined) return false;
    const { idleTimeoutMinutes: _ignored, ...rest } = prev;
    void _ignored;
    this.data[chatId] = rest;
    this.schedulePersist();
    return true;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private parseSlots(raw: Record<string, unknown>): Record<string, SessionSlot> {
    const slots: Record<string, SessionSlot> = {};
    for (const [cwd, value] of Object.entries(raw)) {
      const slot = value as Record<string, unknown>;
      if (!slot || typeof slot.updatedAt !== 'number') continue;
      const sessionId = typeof slot.sessionId === 'string' ? slot.sessionId : undefined;
      if (!sessionId) continue;
      slots[resolve(cwd)] = { sessionId, updatedAt: slot.updatedAt };
    }
    return slots;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(this.path, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      })
      .catch((err: unknown) => {
        log.fail('session', err, { step: 'persist' });
      });
  }
}