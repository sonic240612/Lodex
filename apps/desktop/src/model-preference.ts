import { modelConfigSchema, type ModelConfig } from '@lodex/contracts';

const key = 'lodex.lastModelConfig.v1';
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function availableStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadLastModelConfig(storage = availableStorage()): ModelConfig | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = modelConfigSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    storage.removeItem(key);
  } catch {
    // A blocked or corrupt preference must not prevent the app from starting.
  }
  return null;
}

export function saveLastModelConfig(config: ModelConfig, storage = availableStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(modelConfigSchema.parse(config)));
  } catch {
    // The current session remains usable when WebView preference storage is unavailable.
  }
}
