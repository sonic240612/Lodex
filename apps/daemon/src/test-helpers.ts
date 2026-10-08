import { expect, vi } from 'vitest';
import type { Store } from '@lodex/storage';

export async function waitForCompletedRun(store: Store, sessionId: string) {
  // Real SQLite workers and file operations can exceed Vitest's default 1s wait
  // on CI. Wait for termination, then fail immediately if the run did not succeed.
  const session = await vi.waitFor(
    async () => {
      const current = await store.session(sessionId);
      expect(['completed', 'failed', 'cancelled', 'interrupted']).toContain(current.run?.status);
      return current;
    },
    { timeout: 10000 },
  );
  expect(session.run?.status, session.messages.at(-1)?.error ?? undefined).toBe('completed');
  return session;
}
