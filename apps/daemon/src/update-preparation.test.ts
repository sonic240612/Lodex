import { describe, expect, it } from 'vitest';
import { UpdatePreparation } from './update-preparation';

describe('update installation lease', () => {
  it('blocks new work throughout backup and releases only the matching lease', async () => {
    const gate = new UpdatePreparation();
    let complete!: (value: string) => void;
    const pending = gate.prepare(
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
    );
    expect(() => gate.assertAvailable()).toThrow('업데이트');
    await expect(gate.prepare(async () => 'other')).rejects.toThrow('업데이트');
    complete('backup');
    const result = await pending;
    expect(result.backup).toBe('backup');
    gate.release('stale');
    expect(gate.blocked).toBe(true);
    gate.release(result.token);
    expect(gate.blocked).toBe(false);
  });
  it('unlocks after a failed backup or a crashed installer lease expires', async () => {
    let now = 1;
    const gate = new UpdatePreparation(() => now);
    await expect(
      gate.prepare(async () => {
        throw new Error('disk full');
      }),
    ).rejects.toThrow('disk full');
    expect(gate.blocked).toBe(false);
    await gate.prepare(async () => 'backup');
    now += 120_000;
    expect(gate.blocked).toBe(false);
  });
});
