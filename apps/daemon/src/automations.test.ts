import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Store } from '@lodex/storage';
import { inspectProject } from '@lodex/tools';
import {
  defaultModelConfig,
  makeCommand,
  type AutomationInput,
  type Command,
} from '@lodex/contracts';
import { Automations, nextAutomationTime } from './automations';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(files = false) {
  const root = await mkdtemp(join(tmpdir(), 'lodex-automation-'));
  cleanup.push(async () => {
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('unsafe');
    await rm(root, { recursive: true, force: true });
  });
  const store = await Store.open(
    join(root, 'state.sqlite'),
    resolve('apps/daemon/dist/worker.cjs'),
  );
  cleanup.push(() => store.close());
  const project = files ? await store.registerProject(await inspectProject(root)) : undefined;
  const session = (
    await store.apply(
      makeCommand({
        type: 'create_session',
        sessionId: crypto.randomUUID(),
        title: 'Scheduled',
        ...(project ? { projectId: project.id } : {}),
        config: { ...defaultModelConfig(), provider: 'demo' },
      }),
    )
  ).session;
  if (files) {
    await writeFile(join(root, 'watched.txt'), 'initial');
  }
  let now = Date.parse('2026-10-08T00:00:00Z');
  let available = true;
  const dispatch = vi.fn((command: Command) => store.apply(command));
  const options = { store, dispatch, available: () => available, now: () => now };
  let manager = await Automations.open(options);
  cleanup.push(() => manager.close());
  const input: AutomationInput = {
    name: 'Fixture',
    sessionId: session.id,
    prompt: 'Check the fixture.',
    enabled: true,
    trigger: files
      ? { kind: 'files', paths: ['watched.txt'], debounceSeconds: 10 }
      : { kind: 'interval', minutes: 1 },
  };
  await manager.configure(input, 0);
  return {
    root,
    store,
    dispatch,
    session,
    input,
    get manager() {
      return manager;
    },
    advance: (ms: number) => {
      now += ms;
    },
    busy: (value: boolean) => {
      available = !value;
    },
    restart: async () => {
      await manager.close();
      manager = await Automations.open(options);
    },
  };
}
describe('durable automations', () => {
  it('starts due work once through the common command path and waits for its completion', async () => {
    const f = await fixture();
    await f.manager.tick();
    expect(f.dispatch).not.toHaveBeenCalled();
    f.advance(60000);
    f.busy(true);
    await f.manager.tick();
    expect(f.dispatch).not.toHaveBeenCalled();
    f.busy(false);
    await Promise.all([f.manager.tick(), f.manager.tick()]);
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.dispatch.mock.calls[0]![0]).toMatchObject({
      actor: 'desktop',
      mode: 'build',
      content: '[예약 실행: Fixture]\nCheck the fixture.',
    });
    f.advance(60000);
    await f.manager.tick();
    expect(f.dispatch).toHaveBeenCalledOnce();
    const current = await f.store.session(f.session.id);
    await f.store.updateRun({
      sessionId: current.id,
      runId: current.run!.id,
      status: 'completed',
      text: 'done',
    });
    await f.manager.tick();
    expect(f.manager.snapshot().records[0]!.lastRun?.status).toBe('completed');
    await f.manager.tick();
    expect(f.dispatch).toHaveBeenCalledTimes(2);
  });
  it('pauses uncertain work after restart and never silently replays it', async () => {
    const f = await fixture();
    f.advance(60000);
    await f.manager.tick();
    await f.restart();
    expect(f.manager.snapshot().records[0]).toMatchObject({
      enabled: false,
      lastRun: { status: 'interrupted' },
    });
    f.advance(3600000);
    await f.manager.tick();
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it('does not replay missed schedules on restart', async () => {
    const f = await fixture();
    f.advance(3600000);
    await f.restart();
    await f.manager.tick();
    expect(f.dispatch).not.toHaveBeenCalled();
    f.advance(60000);
    await f.manager.tick();
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it('debounces exact file changes and ignores writes made during its own run', async () => {
    const f = await fixture(true);
    await writeFile(join(f.root, 'watched.txt'), 'changed');
    await f.manager.tick();
    f.advance(5000);
    await writeFile(join(f.root, 'watched.txt'), 'changed twice');
    await f.manager.tick();
    f.advance(9000);
    await f.manager.tick();
    expect(f.dispatch).not.toHaveBeenCalled();
    f.advance(1000);
    await f.manager.tick();
    expect(f.dispatch).toHaveBeenCalledOnce();
    await writeFile(join(f.root, 'watched.txt'), 'written by task');
    const current = await f.store.session(f.session.id);
    await f.store.updateRun({ sessionId: current.id, runId: current.run!.id, status: 'completed' });
    await f.manager.tick();
    f.advance(60000);
    await f.manager.tick();
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it('rejects secrets and out-of-project watch paths, preserves settings on stale versions', async () => {
    const f = await fixture(true);
    await expect(
      f.manager.configure(
        { ...f.input, trigger: { kind: 'files', paths: ['../outside'], debounceSeconds: 10 } },
        f.manager.snapshot().version,
      ),
    ).rejects.toThrow();
    await expect(
      f.manager.configure(
        { ...f.input, trigger: { kind: 'files', paths: ['.env'], debounceSeconds: 10 } },
        f.manager.snapshot().version,
      ),
    ).rejects.toThrow();
    await expect(f.manager.configure(f.input, 0)).rejects.toThrow('다시');
    expect(f.manager.snapshot().records).toHaveLength(1);
  });
  it('pauses dispatch failures rather than retrying external actions', async () => {
    const f = await fixture();
    f.dispatch.mockRejectedValue(new Error('lost response'));
    f.advance(60000);
    await f.manager.tick();
    f.advance(60000);
    await f.manager.tick();
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.manager.snapshot().records[0]).toMatchObject({
      enabled: false,
      lastRun: { status: 'failed' },
    });
  });
  it('keeps the prior schedule when saving its replacement fails', async () => {
    const f = await fixture();
    const before = f.manager.snapshot();
    const save = vi.spyOn(f.store, 'saveIntegration').mockRejectedValueOnce(new Error('disk full'));
    await expect(
      f.manager.configure(
        { ...f.input, id: before.records[0]!.id, name: 'Unsaved', prompt: 'Must not run.' },
        before.version,
      ),
    ).rejects.toThrow('disk full');
    expect(f.manager.snapshot()).toEqual(before);
    save.mockRestore();
    f.advance(60000);
    await f.manager.tick();
    expect(f.dispatch.mock.calls[0]![0]).toMatchObject({
      content: '[예약 실행: Fixture]\nCheck the fixture.',
    });
  });
  it('keeps a saved schedule when persisting its deletion fails', async () => {
    const f = await fixture();
    const before = f.manager.snapshot();
    const save = vi.spyOn(f.store, 'saveIntegration').mockRejectedValueOnce(new Error('disk full'));
    await expect(f.manager.remove(before.records[0]!.id, before.version)).rejects.toThrow(
      'disk full',
    );
    expect(f.manager.snapshot()).toEqual(before);
    save.mockRestore();
    expect((await f.store.integration('automations'))?.document).toEqual(before.records);
  });
  it('computes daily schedules in the PC timezone and always chooses a future occurrence', () => {
    const time = new Date(2026, 9, 8, 9, 30).getTime();
    const next = new Date(nextAutomationTime({ kind: 'daily', hour: 9, minute: 30 }, time)!);
    expect(next.getDate()).toBe(9);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(30);
  });
});
