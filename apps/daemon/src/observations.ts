import { constants } from 'node:fs';
/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 * Adapted from NVlabs/SoL-Pi e1a586af0ad8956f42ae5b26bba20e48fbf30e00:
 * observation-pack/observation.ts, index.ts and ledger.ts. See THIRD_PARTY_NOTICES.md.
 */
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { InferenceMessage, Session, ToolDefinition } from '@lodex/contracts';

export const OBSERVATION_THRESHOLD_BYTES = 10 * 1024;
export const OBSERVATION_FULL_SENDS = 2;
export const OBSERVATION_EXCERPT_BYTES = 1024;
const RECALL_MAX_BYTES = 16 * 1024 - 512;
const RECALL_MAX_LINES = 398;
const MARKER_PREFIX = 'lodex_observation_v1:';
const ID = /^obs_[a-f0-9]{24}$/;
const stateSchema = z.strictObject({
  version: z.literal(1),
  observations: z.record(
    z.string().regex(ID),
    z.strictObject({
      id: z.string().regex(ID),
      toolName: z.string(),
      toolCallId: z.string(),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      bytes: z.number().int().nonnegative(),
      lines: z.number().int().nonnegative(),
      estimatedTokens: z.number().int().nonnegative(),
      sends: z.number().int().nonnegative(),
    }),
  ),
});

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
    `sha256: ${record.contentHash}`,
    `retrieve: call recall_observation with {"id":"${record.id}","offset":0}; continue with nextOffset`,
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
export const observationIdFromMarker = (value: string) => parseMarker(value)?.id;

function eligible(content: string, isError = false): boolean {
  if (isError || Buffer.byteLength(content) <= OBSERVATION_THRESHOLD_BYTES) return false;
  const texts = [content];
  try {
    const result = JSON.parse(content);
    if (result && typeof result === 'object') {
      if (result.isError === true || Object.hasOwn(result, 'error')) return false;
      if (Array.isArray(result.content)) {
        if (
          !result.content.length ||
          result.content.some(
            (block: unknown) =>
              !block ||
              typeof block !== 'object' ||
              !('type' in block) ||
              block.type !== 'text' ||
              !('text' in block) ||
              typeof block.text !== 'string',
          )
        )
          return false;
        texts.push(...result.content.map((block: { text: string }) => block.text));
      }
      for (const value of [result.text, result.output, result.content])
        if (typeof value === 'string') texts.push(value);
    }
  } catch {
    /* Plain text is eligible without a JSON envelope. */
  }
  return !texts.some((text) =>
    text.split('\n').some((line) => line === 'sol_pi_evidence_receipt_v1'),
  );
}

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
      const handle = await open(this.statePath(key), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (
          !info.isFile() ||
          info.size > 16 * 1024 * 1024 ||
          (await lstat(this.statePath(key))).isSymbolicLink()
        )
          throw new Error('Observation state is not a bounded regular file');
        state = stateSchema.parse(JSON.parse(await handle.readFile('utf8')));
      } finally {
        await handle.close();
      }
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
    try {
      await writeFile(temporary, JSON.stringify(state), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporary, this.statePath(sessionId));
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async storage(sessionId: string) {
    for (const directory of [
      this.root,
      this.directory(sessionId),
      join(this.directory(sessionId), 'objects'),
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('Observation directory is not a regular directory');
    }
  }

  private async readObject(sessionId: string, record: ObservationRecord): Promise<Buffer> {
    const path = this.objectPath(sessionId, record.id);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== record.bytes)
      throw new Error('Observation object size or type mismatch');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (info.dev !== before.dev || info.ino !== before.ino || info.size !== record.bytes)
        throw new Error('Observation object identity mismatch');
      const bytes = await handle.readFile();
      if (hash(bytes) !== record.contentHash) throw new Error('Observation content hash mismatch');
      return bytes;
    } finally {
      await handle.close();
    }
  }

  private async ledger(sessionId: string, entry: Record<string, unknown>) {
    const path = join(this.directory(sessionId), 'ledger.jsonl');
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      if (!(await handle.stat()).isFile() || (await lstat(path)).isSymbolicLink())
        throw new Error('Observation ledger is not a regular file');
      await handle.writeFile(
        JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n',
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async failOpen(sessionId: string, id?: string) {
    try {
      await this.storage(sessionId);
      await this.ledger(sessionId, {
        event: 'fail_open',
        id,
        reason: 'Archive or ledger unavailable; original history retained',
      });
    } catch {
      /* Reporting must not hide the original either. */
    }
  }

  async archive(
    sessionId: string,
    toolName: string,
    toolCallId: string,
    content: string,
  ): Promise<string> {
    if (!eligible(content)) return content;
    return this.serialize(sessionId, async () => {
      await this.storage(sessionId);
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
        await this.readObject(sessionId, {
          id,
          contentHash,
          bytes: Buffer.byteLength(content),
        } as ObservationRecord);
      }
      const existed = !!state.observations[id];
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
      if (!existed) await this.save(sessionId, state);
      return marker(id, placeholderFor(state.observations[id]!, content));
    });
  }

  async project(
    sessionId: string,
    messages: readonly InferenceMessage[],
    options: { enabled?: boolean; advance?: boolean; requestId?: string } = {},
  ): Promise<InferenceMessage[]> {
    const enabled = options.enabled ?? true;
    // Archive candidates before taking the projection lock. Stored messages are never edited.
    const prepared: InferenceMessage[] = [];
    const toolNames = new Map(
      messages.flatMap((message) =>
        (message.toolCalls ?? []).map((call) => [call.id, call.name] as const),
      ),
    );
    for (const message of messages) {
      const name = message.toolName ?? toolNames.get(message.toolCallId ?? '');
      if (
        enabled &&
        message.role === 'tool' &&
        name &&
        message.toolCallId &&
        !parseMarker(message.content) &&
        eligible(message.content, message.isError)
      ) {
        try {
          const id = observationIdFromMarker(
            await this.archive(sessionId, name, message.toolCallId, message.content),
          );
          prepared.push(id ? { ...message, toolName: name, observationId: id } : message);
          continue;
        } catch {
          await this.failOpen(sessionId, message.observationId);
        }
      }
      prepared.push(message);
    }
    return this.serialize(sessionId, async () => {
      let state: ObservationState;
      try {
        state = await this.state(sessionId);
      } catch {
        return prepared.map((message) => {
          const packed = message.role === 'tool' ? parseMarker(message.content) : undefined;
          return packed
            ? {
                ...message,
                content:
                  '[legacy observation archive unavailable; excerpt only]\n' + packed.fallback,
              }
            : message;
        });
      }
      const projected: InferenceMessage[] = [];
      const seen = new Set<string>();
      for (const message of prepared) {
        const packed = message.role === 'tool' ? parseMarker(message.content) : undefined;
        const id = packed?.id ?? message.observationId;
        const record = message.role === 'tool' && id ? state.observations[id] : undefined;
        if (!record) {
          projected.push(packed ? { ...message, content: packed.fallback } : message);
          continue;
        }
        let original: string;
        try {
          await this.storage(sessionId);
          original = (await this.readObject(sessionId, record)).toString('utf8');
          if (!packed && original !== message.content)
            throw new Error('Observation history does not match archive');
        } catch {
          await this.failOpen(sessionId, record.id);
          projected.push(
            packed
              ? {
                  ...message,
                  content:
                    '[legacy observation archive unavailable; excerpt only]\n' + packed.fallback,
                }
              : message,
          );
          continue;
        }
        let content = original;
        const replace =
          enabled && eligible(original, message.isError) && record.sends >= OBSERVATION_FULL_SENDS;
        if (replace) content = placeholderFor(record, original);
        if (options.advance !== false && !seen.has(record.id)) {
          try {
            await this.ledger(sessionId, {
              event: replace ? 'placeholder' : 'full',
              id: record.id,
              tool: record.toolName,
              requestId: options.requestId,
              sendNumber: record.sends + 1,
              originalBytes: record.bytes,
              originalLines: record.lines,
              originalTokens: record.estimatedTokens,
              contentHash: record.contentHash,
              projectedBytes: Buffer.byteLength(content),
              estimatedTokensAvoided: Math.max(
                0,
                record.estimatedTokens - Math.ceil(content.length / 4),
              ),
            });
            const next = structuredClone(state);
            next.observations[record.id]!.sends++;
            await this.save(sessionId, next);
            state = next;
            this.states.set(sessionName(sessionId), state);
            seen.add(record.id);
          } catch {
            await this.failOpen(sessionId, record.id);
            content = original;
          }
        }
        projected.push({
          ...message,
          toolName: record.toolName,
          observationId: record.id,
          content,
        });
      }
      return projected;
    });
  }

  /** Preview for budget/compaction without consuming either of the two full sends. */
  async projectHistory(
    session: Session,
  ): Promise<{ session: Session; originals: Map<string, InferenceMessage> }> {
    const originals = new Map<string, InferenceMessage>();
    const messages = [];
    for (const message of session.messages) {
      if (!message.continuation) {
        messages.push(message);
        continue;
      }
      const projected = await this.project(session.id, message.continuation, {
        enabled: session.config.eco,
        advance: false,
      });
      projected.forEach((entry, index) => {
        if (entry.observationId)
          originals.set(entry.observationId, {
            ...entry,
            content: message.continuation![index]!.content,
          });
      });
      messages.push({ ...message, continuation: projected });
    }
    return { session: { ...session, messages }, originals };
  }

  async recall(sessionId: string, argumentsJson: string): Promise<string> {
    const input = recallSchema.parse(JSON.parse(argumentsJson));
    const state = await this.state(sessionId);
    const record = state.observations[input.id];
    if (!record) throw new Error(`Unknown observation id: ${input.id}`);
    await this.storage(sessionId);
    const original = await this.readObject(sessionId, record);
    if (input.offset > original.length) throw new Error('Offset exceeds observation size');
    if (input.offset < original.length && (original[input.offset]! & 0xc0) === 0x80)
      throw new Error('Offset is inside a UTF-8 character; use nextOffset');
    const buffer = original.subarray(input.offset, input.offset + RECALL_MAX_BYTES + 4);
    let end = Math.min(buffer.length, RECALL_MAX_BYTES);
    let lines = 0;
    for (let index = 0; index < end; index++) {
      if (buffer[index] === 0x0a && ++lines === RECALL_MAX_LINES) {
        end = index + 1;
        break;
      }
    }
    while (end > 0 && end < buffer.length && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--;
    const serialize = (length: number) =>
      JSON.stringify({
        id: record.id,
        offset: input.offset,
        nextOffset: input.offset + length,
        eof: input.offset + length >= original.length,
        bytes: length,
        lines: countLines(buffer.subarray(0, length).toString('utf8')),
        text: buffer.subarray(0, length).toString('utf8'),
      });
    let low = 0,
      high = end;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(serialize(middle)) <= 16 * 1024) low = middle;
      else high = middle - 1;
    }
    end = low;
    while (end > 0 && end < buffer.length && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--;
    await this.ledger(sessionId, {
      event: 'recall',
      id: record.id,
      offset: input.offset,
      nextOffset: input.offset + end,
      bytes: end,
    });
    return serialize(end);
  }

  async removeSession(sessionId: string): Promise<void> {
    const key = sessionName(sessionId);
    await this.serialize(key, async () => {
      this.states.delete(key);
      await rm(this.directory(key), { recursive: true, force: true });
    });
  }
}
