import { z } from 'zod';

export const editFields = {
  path: z.string().min(1).max(4096).describe('Existing project-relative path.'),
  expectedHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .describe('Current whole-file sha256 from read or confirmed applied files[].sha256.'),
  oldText: z
    .string()
    .describe(
      'Unique lines[].text joined with newline; keep whitespace, omit numbering. Empty ONLY for an empty file.',
    ),
  newText: z
    .string()
    .describe('Replacement block; retain anchors for insertion. Empty deletes the match.'),
};

export const newFileContent = z
  .string()
  .describe('Complete UTF-8 content, at most 1 MiB; no fences.');
