export type DraftUpdate = string | ((current: string) => string);
type UpdateDraft = (value: DraftUpdate) => void;
export type ComposerDrafts = Record<string, string>;

export const composerDraftKey = (sessionId?: string | null, projectId?: string | null) =>
  sessionId ? `session:${sessionId}` : `new:${projectId ?? 'general'}`;

export function updateComposerDraft(
  drafts: ComposerDrafts,
  key: string,
  update: DraftUpdate,
): ComposerDrafts {
  const value = typeof update === 'function' ? update(drafts[key] ?? '') : update;
  if (value) return { ...drafts, [key]: value };
  const next = { ...drafts };
  delete next[key];
  return next;
}

/** Carry typing made during session creation into that conversation exactly once. */
export function moveComposerDraft(
  drafts: ComposerDrafts,
  source: string,
  target: string,
): ComposerDrafts {
  if (source === target || !drafts[source]) return drafts;
  const next = updateComposerDraft(drafts, target, (value) =>
    value ? `${drafts[source]}\n\n${value}` : drafts[source]!,
  );
  return updateComposerDraft(next, source, '');
}

/** Release the composer immediately; an acknowledgment must never erase a newer draft. */
export async function submitComposerDraft(
  submitted: string,
  update: UpdateDraft,
  send: () => Promise<void>,
): Promise<void> {
  update('');
  try {
    await send();
  } catch (error) {
    update((current) => (current ? `${submitted}\n\n${current}` : submitted));
    throw error;
  }
}
