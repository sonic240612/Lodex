import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertUnchangedBeforeCommand, withFusedFileQueue } from './action-fusion';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('Unsafe test directory');
    await rm(root, { recursive: true, force: true });
  }
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'lodex-fusion-'));
  roots.push(root);
  const path = join(root, '한글 file.txt');
  await writeFile(path, 'after\r\n');
  return { root, path, expectedHash: createHash('sha256').update('after\r\n').digest('hex') };
}
const signal = () => new AbortController().signal;
describe('SoL-Pi Action Fusion guard and queue', () => {
  it('accepts the exact mutation result', async () => {
    const target = await setup();
    await expect(assertUnchangedBeforeCommand([target], signal())).resolves.toBeUndefined();
  });
  it('skips a command when content changed before or between checks', async () => {
    const target = await setup();
    await expect(
      assertUnchangedBeforeCommand([target], signal(), () =>
        writeFile(target.path, 'external edit'),
      ),
    ).rejects.toMatchObject({ code: 'FUSION_CONFLICT' });
    await expect(assertUnchangedBeforeCommand([target], signal())).rejects.toThrow(
      '[then_run:skipped]',
    );
  });
  it('detects same-byte replacement and deletion', async () => {
    const target = await setup();
    await expect(
      assertUnchangedBeforeCommand([target], signal(), async () => {
        await rename(target.path, join(target.root, 'old.txt'));
        await writeFile(target.path, 'after\r\n');
      }),
    ).rejects.toMatchObject({ code: 'FUSION_CONFLICT' });
    await expect(
      assertUnchangedBeforeCommand([target], signal(), () => rm(target.path)),
    ).rejects.toMatchObject({ code: 'FUSION_CONFLICT' });
  });
  it('holds the same-file queue through validation while unrelated files proceed', async () => {
    const { path, root } = await setup();
    let release!: () => void;
    const blocker = new Promise<void>((done) => {
      release = done;
    });
    const order: string[] = [];
    const first = withFusedFileQueue([path], signal(), async () => {
      order.push('edit');
      await blocker;
      order.push('verify');
    });
    await vi.waitFor(() => expect(order).toEqual(['edit']));
    const second = withFusedFileQueue([join(root, '.', '한글 file.txt')], signal(), async () => {
      order.push('second');
    });
    await withFusedFileQueue([join(root, 'other.txt')], signal(), async () => {
      order.push('other');
    });
    expect(order).toEqual(['edit', 'other']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['edit', 'other', 'verify', 'second']);
  });
  it('cancels a queued operation without letting a later writer bypass the owner', async () => {
    const { path } = await setup();
    let release!: () => void;
    const blocker = new Promise<void>((done) => {
      release = done;
    });
    let entered = false;
    const first = withFusedFileQueue([path], signal(), async () => {
      entered = true;
      await blocker;
    });
    await vi.waitFor(() => expect(entered).toBe(true));
    const controller = new AbortController();
    const mutate = vi.fn(async () => {});
    const waiting = withFusedFileQueue([path], controller.signal, mutate);
    const rejected = expect(waiting).rejects.toThrow('stopped');
    controller.abort(new Error('stopped'));
    await rejected;
    let later = false;
    const last = withFusedFileQueue([path], signal(), async () => {
      later = true;
    });
    await new Promise((done) => setImmediate(done));
    expect(later).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
    release();
    await Promise.all([first, last]);
    expect(later).toBe(true);
  });
  it('releases failed mutations and acquires overlapping multi-file sets without deadlock', async () => {
    const { path, root } = await setup();
    await expect(
      withFusedFileQueue([path], signal(), async () => {
        throw new Error('mutation failed');
      }),
    ).rejects.toThrow('mutation failed');
    const other = join(root, 'created.txt');
    await Promise.all([
      withFusedFileQueue([path, other], signal(), async () => {}),
      withFusedFileQueue([other, path], signal(), async () => {}),
    ]);
    expect(await readFile(path, 'utf8')).toBe('after\r\n');
  });
});
