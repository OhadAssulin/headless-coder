import { randomUUID } from 'node:crypto';
import type { SessionRecord, ProviderId } from './types';

class SessionStore {
  private readonly map = new Map<string, SessionRecord>();

  set(sessionId: string, record: SessionRecord): void {
    this.map.set(sessionId, record);
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.map.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.map.has(sessionId);
  }

  delete(sessionId: string): boolean {
    return this.map.delete(sessionId);
  }

  entries(): IterableIterator<[string, SessionRecord]> {
    return this.map.entries();
  }
}

export const sessions = new SessionStore();

export function buildSessionId(provider: ProviderId, threadId?: string): string {
  const suffix = threadId ?? randomUUID();
  return `${provider}:${suffix}`;
}
