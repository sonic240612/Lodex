export type DesignPreference = 'glass' | 'classic';

const key = 'lodex.design.v1';
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function availableStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadDesignPreference(storage = availableStorage()): DesignPreference {
  try {
    return storage?.getItem(key) === 'classic' ? 'classic' : 'glass';
  } catch {
    return 'glass';
  }
}

export function saveDesignPreference(design: DesignPreference, storage = availableStorage()): void {
  try {
    storage?.setItem(key, design);
  } catch {
    // A blocked preference store must not prevent switching the current appearance.
  }
}
