import { AppError, type OpenRouterAccount } from '@lodex/contracts';

const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Read-only metadata; the raw response, key labels and identities never leave this adapter. */
export async function openRouterAccount(
  key: string | null,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<OpenRouterAccount> {
  if (!key) throw new AppError('OPENROUTER_KEY', 'OpenRouter API 키를 먼저 연결하세요.', 403);
  const request = async (path: '/key' | '/credits') => {
    try {
      return await fetcher('https://openrouter.ai/api/v1' + path, {
        method: 'GET',
        headers: { authorization: 'Bearer ' + key },
        redirect: 'error',
        signal,
      });
    } catch {
      signal.throwIfAborted();
      throw new AppError(
        'OPENROUTER_ACCOUNT',
        'OpenRouter 사용량 조회에 실패했습니다. 연결 상태를 확인하세요.',
        502,
      );
    }
  };
  const response = await request('/key');
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new AppError(
      'OPENROUTER_ACCOUNT',
      `OpenRouter 키 조회 실패 (HTTP ${response.status}). 키와 계정 상태를 확인하세요.`,
      502,
    );
  }
  const data = record(record(await response.json()).data);
  if (!Object.hasOwn(data, 'limit') || !Object.hasOwn(data, 'usage'))
    throw new AppError(
      'OPENROUTER_ACCOUNT',
      'OpenRouter 사용량 응답 형식을 확인할 수 없습니다.',
      502,
    );
  const account: OpenRouterAccount = {
    checkedAt: new Date().toISOString(),
    limitUsd: number(data.limit),
    limitKnown: data.limit === null || number(data.limit) !== null,
    remainingUsd: number(data.limit_remaining),
    usageUsd: number(data.usage),
    dailyUsageUsd: number(data.usage_daily),
    monthlyUsageUsd: number(data.usage_monthly),
    freeTier: typeof data.is_free_tier === 'boolean' ? data.is_free_tier : null,
    expiresAt:
      typeof data.expires_at === 'string' && Number.isFinite(Date.parse(data.expires_at))
        ? new Date(data.expires_at).toISOString()
        : null,
    accountCreditsUsd: null,
    creditsStatus: 'management_key_required',
  };
  if (data.is_management_key === true || data.is_provisioning_key === true) {
    account.creditsStatus = 'unavailable';
    try {
      const creditsResponse = await request('/credits');
      if (creditsResponse.ok) {
        const credits = record(record(await creditsResponse.json()).data);
        const total = number(credits.total_credits),
          used = number(credits.total_usage);
        if (total !== null && used !== null) {
          account.accountCreditsUsd = Math.max(0, total - used);
          account.creditsStatus = 'available';
        }
      } else await creditsResponse.body?.cancel().catch(() => undefined);
    } catch {
      signal.throwIfAborted();
    }
  }
  return account;
}
