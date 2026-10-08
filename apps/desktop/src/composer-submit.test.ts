import { expect, it } from 'vitest';
import { submitComposerDraft } from './composer-submit';

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
