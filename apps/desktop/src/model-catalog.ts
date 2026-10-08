import type { ModelConfig, ModelDescriptor } from '@lodex/contracts';

export const modelCatalogSource = (config: Pick<ModelConfig, 'provider' | 'baseUrl'>) =>
  JSON.stringify([config.provider, config.provider === 'openrouter' ? '' : config.baseUrl]);

export const automaticOutputTokens = (context: number, descriptor?: ModelDescriptor) =>
  Math.max(
    1,
    Math.min(
      Math.floor(context * 0.2),
      descriptor?.maxCompletionTokens ?? Number.POSITIVE_INFINITY,
      1048576,
    ),
  );

/** Catalog metadata never changes a saved config; selecting a different model does. */
export function selectCatalogModel(config: ModelConfig, descriptor: ModelDescriptor): ModelConfig {
  if (config.model === descriptor.id) return config;
  const context = Math.min(descriptor.contextLength ?? config.contextBudgetTokens, 2097152);
  return {
    ...config,
    model: descriptor.id,
    contextBudgetTokens: context,
    temperature: descriptor.defaultTemperature ?? 0.7,
    topP: descriptor.defaultTopP ?? 0.95,
    maxTokens: config.autoMaxTokens
      ? automaticOutputTokens(context, descriptor)
      : Math.min(config.maxTokens, descriptor.maxCompletionTokens ?? 1048576),
  };
}

/** One automatic attempt per source. Failures can only be retried explicitly. */
export class ModelCatalogLoader<T = ModelDescriptor[]> {
  private requests = new Map<string, Promise<T>>();

  load(source: string, fetch: () => Promise<T>, refresh = false) {
    if (!refresh && this.requests.has(source)) return this.requests.get(source)!;
    const request = fetch();
    this.requests.set(source, request);
    return request;
  }

  isCurrent(source: string, request: Promise<T>) {
    return this.requests.get(source) === request;
  }
}
