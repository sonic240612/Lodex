import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  ObservationPack,
  observationIdFromMarker,
  OBSERVATION_THRESHOLD_BYTES,
} from './observations';

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
  it('projects raw history without changing it, previews do not count as sends, and records a ledger', async () => {
    const { root, pack, sessionId } = await setup();
    const original = 'important evidence\n'.repeat(1000);
    const messages = [
      { role: 'tool' as const, toolName: 'run_command', toolCallId: 'raw', content: original },
    ];
    for (let index = 0; index < 5; index++)
      expect((await pack.project(sessionId, messages, { advance: false }))[0]?.content).toBe(
        original,
      );
    expect((await pack.project(sessionId, messages))[0]?.content).toBe(original);
    expect((await pack.project(sessionId, messages))[0]?.content).toBe(original);
    const projected = (await pack.project(sessionId, messages))[0]!;
    expect(projected.content).toContain('large tool result replaced');
    expect(projected.content).toContain('sha256:');
    expect(messages[0]?.content).toBe(original);
    const ledger = (await readFile(join(root, sessionId, 'ledger.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(ledger.map((entry) => entry.event)).toEqual(['full', 'full', 'placeholder']);
    expect(ledger[2].estimatedTokensAvoided).toBeGreaterThan(0);
    const restarted = new ObservationPack(root);
    expect((await restarted.project(sessionId, messages))[0]?.content).toContain(
      'large tool result replaced',
    );
    expect((await restarted.project(sessionId, messages, { enabled: false }))[0]?.content).toBe(
      original,
    );
    const recalled = JSON.parse(
      await restarted.recall(sessionId, JSON.stringify({ id: projected.observationId })),
    );
    expect(recalled.text).toBe(original.slice(0, recalled.text.length));
    await expect(
      restarted.recall(crypto.randomUUID(), JSON.stringify({ id: projected.observationId })),
    ).rejects.toThrow('Unknown observation');
  });
  it('keeps exact-threshold, error results and reducer receipts inline', async () => {
    const { pack, sessionId } = await setup();
    const values = [
      { content: 'x'.repeat(OBSERVATION_THRESHOLD_BYTES) },
      { content: 'failure detail\n'.repeat(2000), isError: true },
      { content: 'sol_pi_evidence_receipt_v1\n' + 'evidence\n'.repeat(2000) },
      {
        content: JSON.stringify({
          content: [
            { type: 'text', text: 'sol_pi_evidence_receipt_v1\n' + 'evidence\n'.repeat(2000) },
          ],
        }),
      },
      {
        content: JSON.stringify({
          isError: true,
          content: [{ type: 'text', text: 'failure\n'.repeat(3000) }],
        }),
      },
      {
        content: JSON.stringify({
          content: [{ type: 'image', data: 'base64'.repeat(3000), mimeType: 'image/png' }],
        }),
      },
    ];
    for (let index = 0; index < 4; index++) {
      for (const value of values) {
        const message = {
          role: 'tool' as const,
          toolCallId: 'inline',
          toolName: 'run_command',
          ...value,
        };
        expect((await pack.project(sessionId, [message]))[0]).toEqual(message);
      }
    }
  });
  it('fails open to original history when storage or its ledger is unavailable', async () => {
    const { root, pack, sessionId } = await setup();
    const content = 'source\n'.repeat(3000);
    const messages = [
      { role: 'tool' as const, toolName: 'read_file', toolCallId: 'read', content },
    ];
    const blocked = join(root, 'blocked');
    await writeFile(blocked, 'not a directory');
    expect((await new ObservationPack(blocked).project(sessionId, messages))[0]?.content).toBe(
      content,
    );
    await pack.project(sessionId, messages);
    await pack.project(sessionId, messages);
    const ledger = join(root, sessionId, 'ledger.jsonl');
    await rm(ledger);
    await mkdir(ledger);
    expect((await pack.project(sessionId, messages))[0]?.content).toBe(content);
  });
  it('refuses corrupted objects on recall and preserves raw history on projection', async () => {
    const { root, pack, sessionId } = await setup();
    const content = 'valid evidence\n'.repeat(2000);
    const packed = await pack.archive(sessionId, 'read_file', 'read', content);
    const id = observationIdFromMarker(packed)!;
    await writeFile(
      join(root, sessionId, 'objects', id + '.txt'),
      content.replace('valid', 'wrong'),
    );
    await expect(pack.recall(sessionId, JSON.stringify({ id }))).rejects.toThrow('hash mismatch');
    const messages = [
      {
        role: 'tool' as const,
        toolName: 'read_file',
        toolCallId: 'read',
        observationId: id,
        content,
      },
    ];
    expect((await pack.project(sessionId, messages))[0]?.content).toBe(content);
  });
  it('bounds the entire serialized recall even with escaped control bytes and rejects split UTF-8 offsets', async () => {
    const { pack, sessionId } = await setup();
    const content = '가😀"\\\r\n\t\x01'.repeat(4000);
    const id = observationIdFromMarker(
      await pack.archive(sessionId, 'read_file', 'read', content),
    )!;
    await expect(pack.recall(sessionId, JSON.stringify({ id, offset: 1 }))).rejects.toThrow(
      'UTF-8',
    );
    let offset = 0,
      restored = '';
    for (;;) {
      const result = await pack.recall(sessionId, JSON.stringify({ id, offset }));
      expect(Buffer.byteLength(result)).toBeLessThanOrEqual(16 * 1024);
      const page = JSON.parse(result);
      expect(page.lines).toBeLessThanOrEqual(398);
      restored += page.text;
      if (page.eof) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(restored).toBe(content);
  });
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
