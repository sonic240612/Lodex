import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { InferenceMessage, ToolDefinition } from '@lodex/contracts';

export const OBSERVATION_THRESHOLD_BYTES = 10 * 1024;
export const OBSERVATION_FULL_SENDS = 2;
export const OBSERVATION_EXCERPT_BYTES = 1024;
const RECALL_MAX_BYTES = 16 * 1024 - 512;
const RECALL_MAX_LINES = 398;
const MARKER_PREFIX = 'lodex_observation_v1:';
const ID = /^obs_[a-f0-9]{24}$/;

interface ObservationRecord {
  id: string;
  toolName: string;
  toolCallId: string;
  contentHash: string;
  bytes: number;
  lines: number;
  estimatedTokens: number;
  sends: number;
}

interface ObservationState {
  version: 1;
  observations: Record<string, ObservationRecord>;
}

const markerSchema = z.strictObject({
  id: z.string().regex(ID),
  fallback: z.string().max(4096),
});
const recallSchema = z.strictObject({
  id: z.string().regex(ID),
  offset: z.number().int().nonnegative().default(0),
});

export const observationRecallTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'recall_observation',
    description:
      'Read an exact page from a large tool result that Lodex replaced with an observation handle. Use the returned nextOffset to continue until eof is true.',
    parameters: z.toJSONSchema(recallSchema),
  },
};

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const countLines = (value: string) =>
  value.length === 0 ? 0 : value.split('\n').length - (value.endsWith('\n') ? 1 : 0);
const sessionName = (sessionId: string) => {
  if (!/^[a-f0-9-]{16,64}$/i.test(sessionId)) throw new Error('Invalid session id');
  return sessionId.toLowerCase();
};

function completeLineExcerpt(value: string, budget: number, fromEnd: boolean): string {
  const lines = value.split(/(?<=\n)/);
  const selected: string[] = [];
  let bytes = 0;
  for (
    let index = fromEnd ? lines.length - 1 : 0;
    index >= 0 && index < lines.length;
    index += fromEnd ? -1 : 1
  ) {
    const line = lines[index]!;
    const size = Buffer.byteLength(line);
    if (bytes + size > budget) break;
    if (fromEnd) selected.unshift(line);
    else selected.push(line);
    bytes += size;
  }
  return selected.join('');
}

function placeholderFor(record: ObservationRecord, original: string): string {
  const headBudget = Math.floor(OBSERVATION_EXCERPT_BYTES / 2);
  const tailBudget = OBSERVATION_EXCERPT_BYTES - headBudget;
  return [
    `[large tool result replaced after ${OBSERVATION_FULL_SENDS} full provider requests]`,
    `id: ${record.id}`,
    `tool: ${record.toolName}`,
    `originalBytes: ${record.bytes}`,
    `originalLines: ${record.lines}`,
    `estimatedTokens: ${record.estimatedTokens}`,
    `retrieve: call recall_observation with {"id":"${record.id}","offset":0}`,
    '[first complete lines]',
    completeLineExcerpt(original, headBudget, false),
    '[middle omitted; last complete lines]',
    completeLineExcerpt(original, tailBudget, true),
  ].join('\n');
}

function marker(id: string, fallback: string): string {
  return MARKER_PREFIX + JSON.stringify({ id, fallback });
}

function parseMarker(value: string): { id: string; fallback: string } | undefined {
  if (!value.startsWith(MARKER_PREFIX)) return undefined;
  try {
    return markerSchema.parse(JSON.parse(value.slice(MARKER_PREFIX.length)));
  } catch {
    return undefined;
  }
}

export const isObservationMarker = (value: string) => !!parseMarker(value);

export class ObservationPack {
  private states = new Map<string, ObservationState>();
  private queues = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {}

  private directory(sessionId: string) {
    return join(this.root, sessionName(sessionId));
  }

  private statePath(sessionId: string) {
    return join(this.directory(sessionId), 'state.json');
  }

  private objectPath(sessionId: string, id: string) {
    if (!ID.test(id)) throw new Error('Invalid observation id');
    return join(this.directory(sessionId), 'objects', id + '.txt');
  }

  private async state(sessionId: string): Promise<ObservationState> {
    const key = sessionName(sessionId);
    const cached = this.states.get(key);
    if (cached) return cached;
    let state: ObservationState = { version: 1, observations: {} };
    try {
      const parsed = JSON.parse(await readFile(this.statePath(key), 'utf8')) as ObservationState;
      if (parsed.version === 1 && parsed.observations && typeof parsed.observations === 'object')
        state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.states.set(key, state);
    return state;
  }

  private serialize<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const key = sessionName(sessionId);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.queues.set(key, next);
    return next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
  }

  private async save(sessionId: string, state: ObservationState) {
    const directory = this.directory(sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, '.state-' + randomUUID() + '.tmp');
    await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.statePath(sessionId));
  }

  async archive(
    sessionId: string,
    toolName: string,
    toolCallId: string,
    content: string,
  ): Promise<string> {
    if (Buffer.byteLength(content) <= OBSERVATION_THRESHOLD_BYTES) return content;
    return this.serialize(sessionId, async () => {
      const state = await this.state(sessionId);
      const contentHash = hash(content);
      const id = `obs_${hash(`${toolName}\0${toolCallId}\0${contentHash}`).slice(0, 24)}`;
      const path = this.objectPath(sessionId, id);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      try {
        const handle = await open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await handle.writeFile(content, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || hash(await readFile(path)) !== contentHash)
          throw new Error('Stored observation does not match its content hash');
      }
      state.observations[id] ??= {
        id,
        toolName,
        toolCallId,
        contentHash,
        bytes: Buffer.byteLength(content),
        lines: countLines(content),
        estimatedTokens: Math.ceil(content.length / 4),
        sends: 0,
      };
      await this.save(sessionId, state);
      return marker(id, placeholderFor(state.observations[id]!, content));
    });
  }

  async project(
    sessionId: string,
    messages: readonly InferenceMessage[],
  ): Promise<InferenceMessage[]> {
    return this.serialize(sessionId, async () => {
      let state: ObservationState;
      try {
        state = await this.state(sessionId);
      } catch {
        return messages.map((message) => {
          const packed = message.role === 'tool' ? parseMarker(message.content) : undefined;
          return packed ? { ...message, content: packed.fallback } : message;
        });
      }
      let changed = false;
      const projected: InferenceMessage[] = [];
      for (const message of messages) {
        const packed = message.role === 'tool' ? parseMarker(message.content) : undefined;
        const record = packed ? state.observations[packed.id] : undefined;
        if (!record) {
          projected.push(packed ? { ...message, content: packed.fallback } : message);
          continue;
        }
        let original: string;
        try {
          original = await readFile(this.objectPath(sessionId, record.id), 'utf8');
          if (hash(original) !== record.contentHash)
            throw new Error('Observation content hash mismatch');
        } catch {
          projected.push({ ...message, content: packed!.fallback });
          continue;
        }
        let content = original;
        if (record.sends >= OBSERVATION_FULL_SENDS) content = placeholderFor(record, original);
        record.sends += 1;
        changed = true;
        projected.push({ ...message, content });
      }
      if (changed) await this.save(sessionId, state).catch(() => undefined);
      return projected;
    });
  }

  async recall(sessionId: string, argumentsJson: string): Promise<string> {
    const input = recallSchema.parse(JSON.parse(argumentsJson));
    const state = await this.state(sessionId);
    const record = state.observations[input.id];
    if (!record) throw new Error(`Unknown observation id: ${input.id}`);
    const handle = await open(
      this.objectPath(sessionId, record.id),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || input.offset > stats.size)
        throw new Error(`Offset ${input.offset} exceeds observation size ${stats.size}`);
      const available = Math.max(0, stats.size - input.offset);
      const buffer = Buffer.alloc(Math.min(available, RECALL_MAX_BYTES + 4));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, input.offset);
      let end = Math.min(bytesRead, RECALL_MAX_BYTES);
      let lines = 0;
      for (let index = 0; index < end; index++) {
        if (buffer[index] === 0x0a && ++lines === RECALL_MAX_LINES) {
          end = index + 1;
          break;
        }
      }
      while (end > 0 && end < bytesRead && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--;
      const nextOffset = input.offset + end;
      const text = buffer.subarray(0, end).toString('utf8');
      return JSON.stringify({
        id: record.id,
        offset: input.offset,
        nextOffset,
        eof: nextOffset >= stats.size,
        bytes: end,
        lines: countLines(text),
        text,
      });
    } finally {
      await handle.close();
    }
  }

  async removeSession(sessionId: string): Promise<void> {
    const key = sessionName(sessionId);
    await this.serialize(key, async () => {
      this.states.delete(key);
      await rm(this.directory(key), { recursive: true, force: true });
    });
  }
}
