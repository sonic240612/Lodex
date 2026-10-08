type UpdateDraft = (value: string | ((current: string) => string)) => void;

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
