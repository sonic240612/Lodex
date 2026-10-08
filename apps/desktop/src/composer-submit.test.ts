import { expect, it } from 'vitest';
import {
  submitComposerDraft,
  composerDraftKey,
  updateComposerDraft,
  moveComposerDraft,
  type ComposerDrafts,
} from './composer-submit';

it.each([false, true])(
  'preserves typing while a submission is pending (failure=%s)',
  async (fails) => {
    let draft = 'Original instruction';
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const result = submitComposerDraft(
      draft,
      (value) => {
        draft = typeof value === 'function' ? value(draft) : value;
      },
      () => pending,
    );
    expect(draft).toBe('');
    draft = 'Additional instruction typed before acknowledgment';
    if (fails) {
      const failure = new Error('Connection lost');
      reject(failure);
      await expect(result).rejects.toBe(failure);
      expect(draft).toBe(
        'Original instruction\n\nAdditional instruction typed before acknowledgment',
      );
    } else {
      resolve();
      await result;
      expect(draft).toBe('Additional instruction typed before acknowledgment');
    }
  },
);

it('restores a failed send to its original conversation after navigating and typing elsewhere', async () => {
  const first = composerDraftKey('first');
  const second = composerDraftKey('second');
  let drafts: ComposerDrafts = { [first]: 'Original instruction' };
  let selected = first;
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, no) => {
    reject = no;
  });
  const result = submitComposerDraft(
    drafts[first]!,
    (value) => {
      drafts = updateComposerDraft(drafts, first, value);
    },
    () => pending,
  );
  drafts = updateComposerDraft(drafts, first, 'Follow-up for first');
  selected = second;
  drafts = updateComposerDraft(drafts, selected, 'Private instruction for second');
  reject(new Error('Disconnected'));
  await expect(result).rejects.toThrow('Disconnected');
  expect(drafts[selected]).toBe('Private instruction for second');
  selected = first;
  expect(drafts[selected]).toBe('Original instruction\n\nFollow-up for first');
});

it('keeps project drafts separate and carries unsent typing to a newly created conversation on failure', async () => {
  const source = composerDraftKey(null, 'project-one');
  const other = composerDraftKey(null, 'project-two');
  const target = composerDraftKey('created-session');
  let drafts: ComposerDrafts = { [source]: 'Start work', [other]: 'Other project' };
  let destination = source;
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_yes, no) => {
    reject = no;
  });
  const result = submitComposerDraft(
    drafts[source]!,
    (value) => {
      drafts = updateComposerDraft(drafts, destination, value);
    },
    async () => {
      await pending;
    },
  );
  drafts = updateComposerDraft(drafts, source, 'Keep existing styles');
  drafts = moveComposerDraft(drafts, source, target);
  destination = target;
  reject(new Error('Message failed after creation'));
  await expect(result).rejects.toThrow('Message failed after creation');
  expect(drafts[target]).toBe('Start work\n\nKeep existing styles');
  expect(drafts[source]).toBeUndefined();
  expect(drafts[other]).toBe('Other project');
});
