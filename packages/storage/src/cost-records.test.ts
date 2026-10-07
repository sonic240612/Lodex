import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  autopilotLimitsSchema,
  defaultModelConfig,
  makeCommand,
  type ModelCallRecord,
} from '@lodex/contracts';
import { Store } from './index';

const roots: string[] = [],
  stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lodex-cost-records-'));
  roots.push(root);
  const path = join(root, 'state.sqlite');
  const store = await Store.open(path, resolve('apps/daemon/dist/worker.cjs'));
  stores.push(store);
  let session = (
    await store.apply(
      makeCommand({
        type: 'create_session',
        sessionId: crypto.randomUUID(),
        title: 'Cost fixture',
        config: defaultModelConfig(),
      }),
    )
  ).session;
  session = (
    await store.apply(
      makeCommand({
        type: 'start_goal',
        sessionId: session.id,
        expectedVersion: session.version,
        goal: 'test',
        limits: autopilotLimitsSchema.parse({}),
      }),
    )
  ).session;
  const now = new Date().toISOString();
  const call: ModelCallRecord = {
    id: crypto.randomUUID(),
    budgetId: session.autopilot!.costBudgetId!,
    runId: session.run!.id,
    messageId: session.run!.messageId,
    model: 'fixture',
    reservedCostUsd: 0.01,
    status: 'reserved',
    createdAt: now,
    updatedAt: now,
  };
  return { store, session, call, path };
}
describe('durable request cost records', () => {
  it('upgrades a v14 database without losing a durable request or its budget', async () => {
    const { store, session, call, path } = await fixture();
    await store.recordModelCall(session.id, { ...call, generationId: 'gen-migration' });
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    const old = new DatabaseSync(path);
    old.exec('PRAGMA user_version=14;');
    old.close();
    const reopened = await Store.open(path, resolve('apps/daemon/dist/worker.cjs'));
    stores.push(reopened);
    const upgraded = await reopened.session(session.id);
    expect(upgraded.messages.at(-1)?.costCalls?.[0]).toMatchObject({
      generationId: 'gen-migration',
      reservedCostUsd: 0.01,
    });
    expect(upgraded.autopilot?.costBudgetId).toBe(call.budgetId);
    const check = new DatabaseSync(path);
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(15);
    check.close();
  });
  it('enforces the shared budget atomically and prevents duplicate generation charges', async () => {
    const { store, session, call } = await fixture();
    await store.recordModelCall(session.id, {
      ...call,
      reservedCostUsd: 0.7,
      generationId: 'gen-unique',
    });
    await expect(
      store.recordModelCall(session.id, { ...call, id: crypto.randomUUID(), reservedCostUsd: 0.7 }),
    ).rejects.toMatchObject({ code: 'COST_BUDGET' });
    await expect(
      store.recordModelCall(session.id, {
        ...call,
        id: crypto.randomUUID(),
        generationId: 'gen-unique',
      }),
    ).rejects.toMatchObject({ code: 'COST_RECORD' });
    expect((await store.session(session.id)).messages.at(-1)?.costCalls).toHaveLength(1);
    expect((await store.session(session.id)).autopilot?.reservedCostUsd).toBe(0.7);
  });
  it('recovers in-flight reservations with identity and blocks a resume until settlement', async () => {
    const { store, session, call, path } = await fixture();
    await store.recordModelCall(session.id, { ...call, generationId: 'gen-first' });
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = await Store.open(path, resolve('apps/daemon/dist/worker.cjs'));
    stores.push(reopened);
    const recovered = await reopened.session(session.id);
    expect(recovered.messages.at(-1)?.costCalls?.[0]).toMatchObject({
      status: 'unconfirmed',
      generationId: 'gen-first',
    });
    expect(recovered.autopilot).toMatchObject({
      reservedCostUsd: 0.01,
      costUnconfirmed: true,
      status: 'interrupted',
    });
    await expect(
      reopened.apply(
        makeCommand({
          type: 'resume_goal',
          sessionId: session.id,
          expectedVersion: recovered.version,
        }),
      ),
    ).rejects.toMatchObject({ code: 'COST_UNCONFIRMED' });
    const settled = await reopened.recordModelCall(session.id, {
      ...call,
      generationId: 'gen-first',
      status: 'settled',
      actualCostUsd: 0.004,
    });
    expect(settled.autopilot).toMatchObject({
      reservedCostUsd: 0,
      spentCostUsd: 0.004,
      costUnconfirmed: false,
    });
    const resumed = (
      await reopened.apply(
        makeCommand({
          type: 'resume_goal',
          sessionId: session.id,
          expectedVersion: settled.version,
        }),
      )
    ).session;
    expect(resumed.autopilot?.costBudgetId).toBe(call.budgetId);
    expect(resumed.autopilot?.spentCostUsd).toBe(0.004);
  });
  it('settles once after cancellation without reviving the run or changing a reservation', async () => {
    const { store, session, call } = await fixture();
    const reserved = await store.recordModelCall(session.id, {
      ...call,
      generationId: 'gen-cancel',
    });
    expect(reserved.autopilot?.reservedCostUsd).toBe(0.01);
    await store.apply(
      makeCommand({ type: 'cancel_run', sessionId: session.id, runId: call.runId }),
    );
    const settledCall = {
      ...call,
      generationId: 'gen-cancel',
      status: 'settled' as const,
      actualCostUsd: 0.003,
    };
    const settled = await store.recordModelCall(session.id, settledCall);
    expect(settled.run?.status).toBe('cancelled');
    expect(settled.autopilot).toMatchObject({
      status: 'cancelled',
      spentCostUsd: 0.003,
      reservedCostUsd: 0,
    });
    expect((await store.recordModelCall(session.id, settledCall)).autopilot?.spentCostUsd).toBe(
      0.003,
    );
    await expect(
      store.recordModelCall(session.id, { ...settledCall, actualCostUsd: 0.5 }),
    ).rejects.toMatchObject({ code: 'COST_RECORD' });
    await expect(
      store.recordModelCall(session.id, { ...settledCall, reservedCostUsd: 0.2 }),
    ).rejects.toMatchObject({ code: 'COST_RECORD' });
  });
  it('does not let stale run snapshots erase authoritative cost totals', async () => {
    const { store, session, call } = await fixture();
    await store.recordModelCall(session.id, call);
    await store.recordModelCall(session.id, { ...call, status: 'settled', actualCostUsd: 0.002 });
    const updated = await store.updateRun({
      sessionId: session.id,
      runId: call.runId,
      autopilot: session.autopilot!,
    });
    expect(updated.autopilot).toMatchObject({ spentCostUsd: 0.002, reservedCostUsd: 0 });
    expect(updated.messages.at(-1)?.costCalls?.[0]?.actualCostUsd).toBe(0.002);
  });
});
