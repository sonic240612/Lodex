import { afterEach, expect, it, vi } from 'vitest';
import { defaultModelConfig, defaultPlan, type Session } from '@lodex/contracts';
vi.mock('./bridge', () => ({ nativeDesktop: false }));
import { useWorkspace } from './state';
const initial = useWorkspace.getState();
afterEach(() => useWorkspace.setState(initial, true));
it('removes the current chat and ignores late responses and replayed events for it', () => {
  const session: Session = {
    id: crypto.randomUUID(),
    title: 'deleted',
    version: 2,
    createdAt: '2026',
    updatedAt: '2026',
    config: defaultModelConfig(),
    plan: defaultPlan(),
    messages: [],
    run: null,
  };
  const store = useWorkspace.getState();
  store.upsert(session);
  store.select(session.id);
  store.removeSessions([session.id]);
  store.upsert({ ...session, version: 10 });
  store.event({
    seq: 1,
    protocolVersion: 1,
    type: 'session_changed',
    sessionId: session.id,
    session,
    createdAt: '2026',
  });
  expect(useWorkspace.getState().sessions).toEqual([]);
  expect(useWorkspace.getState().selectedId).toBeNull();
  expect(useWorkspace.getState().lastSeq).toBe(1);
});
