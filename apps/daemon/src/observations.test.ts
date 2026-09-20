import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ObservationPack } from './observations';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('Unsafe test directory');
    await rm(directory, { recursive: true, force: true });
  }
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'lodex-observations-'));
  directories.push(root);
  return { root, pack: new ObservationPack(root), sessionId: crypto.randomUUID() };
}

describe('ObservationPack', () => {
  it('leaves small results inline and projects a large result in full twice before using a handle', async () => {
    const { root, pack, sessionId } = await setup();
    expect(await pack.archive(sessionId, 'read_file', 'small', 'small result')).toBe(
      'small result',
    );
    const original = Array.from({ length: 900 }, (_, index) => `line ${index} payload`).join('\n');
    const packed = await pack.archive(sessionId, 'run_command', 'large', original);
    expect(packed).toMatch(/^lodex_observation_v1:/);
    const source = [{ role: 'tool' as const, toolCallId: 'large', content: packed }];
    expect((await pack.project(sessionId, source))[0]?.content).toBe(original);
    expect((await pack.project(sessionId, source))[0]?.content).toBe(original);
    const projected = (await pack.project(sessionId, source))[0]!.content;
    expect(projected).toContain('large tool result replaced');
    expect(projected).toContain('recall_observation');
    expect(projected.length).toBeLessThan(original.length);

    const restarted = new ObservationPack(root);
    expect((await restarted.project(sessionId, source))[0]?.content).toContain(
      'large tool result replaced',
    );
  });

  it('recalls exact UTF-8 pages and removes the private archive with the session', async () => {
    const { root, pack, sessionId } = await setup();
    const original = '한글😀\n'.repeat(5000);
    const packed = await pack.archive(sessionId, 'run_command', 'call', original);
    const id = JSON.parse(packed.slice(packed.indexOf(':') + 1)).id as string;
    let offset = 0;
    let restored = '';
    for (;;) {
      const page = JSON.parse(await pack.recall(sessionId, JSON.stringify({ id, offset }))) as {
        text: string;
        nextOffset: number;
        eof: boolean;
      };
      restored += page.text;
      if (page.eof) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(restored).toBe(original);
    await pack.removeSession(sessionId);
    await expect(readFile(join(root, sessionId, 'state.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
