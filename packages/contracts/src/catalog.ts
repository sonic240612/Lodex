import type { ModelDescriptor } from './index';

export interface ModelCatalogSnapshot {
  models: ModelDescriptor[];
  fetchedAt: string;
  source: 'live' | 'cache';
  stale: boolean;
  notice?: string;
}
export interface OpenRouterAccount {
  checkedAt: string;
  limitUsd: number | null;
  limitKnown: boolean;
  remainingUsd: number | null;
  usageUsd: number | null;
  dailyUsageUsd: number | null;
  monthlyUsageUsd: number | null;
  freeTier: boolean | null;
  expiresAt: string | null;
  accountCreditsUsd: number | null;
  creditsStatus: 'available' | 'management_key_required' | 'unavailable';
}
