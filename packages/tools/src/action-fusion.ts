/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 * Adapted from NVlabs/SoL-Pi e1a586af0ad8956f42ae5b26bba20e48fbf30e00:
 * action-fusion/file-queue.ts and then-run.ts. See THIRD_PARTY_NOTICES.md.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { AppError } from '@lodex/contracts';

export const THEN_RUN_SUCCEEDED = '[then_run:succeeded]';
export const THEN_RUN_FAILED = '[then_run:failed]';
export const THEN_RUN_SKIPPED = '[then_run:skipped]';
const tails = new Map<string, Promise<void>>();

async function canonicalKey(path: string): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      const key = resolve(await realpath(current), ...missing);
      return process.platform === 'win32' ? key.toLowerCase() : key;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/** Covers mutation, approval, interference checks, and verification. No nested write locks.
 * Sorted multi-file keys avoid deadlocks; external writers are not globally locked.
 */
export async function withFusedFileQueue<T>(
  paths: readonly string[],
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const keys = [...new Set(await Promise.all(paths.map(canonicalKey)))].sort();
  const previous = Promise.all(keys.map((key) => tails.get(key) ?? Promise.resolve())).then(
    () => {},
  );
  let release!: () => void;
  const owned = new Promise<void>((done) => {
    release = done;
  });
  const tail = previous.then(() => owned);
  for (const key of keys) tails.set(key, tail);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    await Promise.race([previous, aborted]);
    signal.throwIfAborted();
    return await work();
  } finally {
    signal.removeEventListener('abort', onAbort);
    release();
    // A cancelled waiter must not let later writers pass an earlier live writer.
    void tail.then(() => {
      for (const key of keys) if (tails.get(key) === tail) tails.delete(key);
    });
  }
}

export interface FusedTarget {
  path: string;
  expectedHash: string;
  expectedPath?: string;
}

async function snapshot(target: FusedTarget) {
  const path = await realpath(target.path);
  if (target.expectedPath && path !== target.expectedPath)
    throw new Error('target path changed after the fused mutation');
  const info = await lstat(path);
  if (!info.isFile() || info.size > 1_048_576)
    throw new Error('target is not a bounded regular file');
  const hash = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
  if (hash !== target.expectedHash)
    throw new Error('target content changed after the fused mutation');
  return `${path}\0${info.dev}:${info.ino}\0${hash}`;
}

/** Original two-pass interference check plus the mutation's expected hash and identity. */
export async function assertUnchangedBeforeCommand(
  targets: readonly FusedTarget[],
  signal: AbortSignal,
  yieldForInterference: () => Promise<void> = () => new Promise((done) => setImmediate(done)),
): Promise<void> {
  try {
    signal.throwIfAborted();
    const before = await Promise.all(targets.map(snapshot));
    await yieldForInterference();
    signal.throwIfAborted();
    const after = await Promise.all(targets.map(snapshot));
    if (before.some((value, index) => value !== after[index]))
      throw new Error('target path or identity changed after the fused mutation');
  } catch (error) {
    signal.throwIfAborted();
    throw new AppError(
      'FUSION_CONFLICT',
      `${THEN_RUN_SKIPPED} ${error instanceof Error ? error.message : 'Target unavailable'}; the command was not run.`,
    );
  }
}
