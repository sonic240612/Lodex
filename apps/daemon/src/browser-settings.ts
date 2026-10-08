import { browserConfigSchema, type BrowserSettings } from '@lodex/contracts';
import type { Store } from '@lodex/storage';
export async function browserSettings(store: Store): Promise<BrowserSettings> {
  const saved = await store.integration('browser');
  const parsed = browserConfigSchema.safeParse(saved?.document ?? {});
  return {
    version: saved?.version ?? 0,
    config: parsed.success ? parsed.data : browserConfigSchema.parse({}),
  };
}
