import { z } from 'zod';
import type { Store } from '@lodex/storage';
import type { ModelCatalogSnapshot, ModelDescriptor } from '@lodex/contracts';

const nullableNumber = z.number().nonnegative().nullable();
const descriptor = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(1000),
  contextLength: nullableNumber,
  maxCompletionTokens: nullableNumber,
  defaultTemperature: nullableNumber,
  defaultTopP: nullableNumber,
  tools: z.boolean().nullable(),
  pricing: z
    .object({
      prompt: z.number().nonnegative(),
      completion: z.number().nonnegative(),
      request: z.number().nonnegative(),
    })
    .nullable(),
});
const storedCatalog = z.object({
  fetchedAt: z.iso.datetime(),
  models: z.array(descriptor).max(10000),
});
const freshMs = 6 * 60 * 60 * 1000,
  maximumAgeMs = 30 * 24 * 60 * 60 * 1000;

/** Only the public OpenRouter catalog is cached. Accounts, API keys and local endpoints are not. */
export class OpenRouterCatalog {
  private pending: Promise<ModelCatalogSnapshot> | undefined;
  constructor(
    private store: Pick<Store, 'integration' | 'saveIntegration'>,
    private fetchModels: () => Promise<ModelDescriptor[]>,
    private now = Date.now,
  ) {}
  get(refresh = false) {
    if (this.pending) return this.pending;
    const pending = this.load(refresh).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }
  private async load(refresh: boolean): Promise<ModelCatalogSnapshot> {
    const previous = await this.store.integration('model_catalog');
    const parsed = storedCatalog.safeParse(previous?.document);
    const age = parsed.success ? this.now() - Date.parse(parsed.data.fetchedAt) : Infinity;
    const cached = parsed.success && age >= 0 && age <= maximumAgeMs ? parsed.data : undefined;
    if (!refresh && cached && age < freshMs) return { ...cached, source: 'cache', stale: false };
    try {
      const result = storedCatalog.parse({
        models: await this.fetchModels(),
        fetchedAt: new Date(this.now()).toISOString(),
      });
      let notice: string | undefined;
      try {
        await this.store.saveIntegration('model_catalog', previous?.version ?? 0, result);
      } catch {
        notice = '모델 목록은 조회했지만 저장하지 못했습니다.';
      }
      return { ...result, source: 'live', stale: false, ...(notice ? { notice } : {}) };
    } catch (error) {
      if (!cached) throw error;
      return {
        ...cached,
        source: 'cache',
        stale: true,
        notice:
          '연결하지 못해 저장된 모델 목록을 표시합니다. 가격·기본값이 변경되었을 수 있습니다.',
      };
    }
  }
}
