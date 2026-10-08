import { expect, it, vi } from 'vitest';
import { openRouterAccount } from './account';

it('returns only key usage fields and does not query account credits for a normal key', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      data: {
        limit: 20,
        limit_remaining: 13,
        usage: 7,
        usage_daily: 2,
        usage_monthly: 7,
        is_management_key: false,
        is_free_tier: false,
        label: 'sk-or-v1-secret',
        creator_user_id: 'private-user',
      },
    }),
  );
  const result = await openRouterAccount('fixture-secret', new AbortController().signal, fetcher);
  expect(result.remainingUsd).toBe(13);
  expect(result.creditsStatus).toBe('management_key_required');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toMatch(/secret|private-user/);
  expect(fetcher.mock.calls[0]![1]?.redirect).toBe('error');
});
it('distinguishes an unlimited key from unknown values and reads management-key credits', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        data: {
          limit: null,
          usage: 0,
          is_management_key: true,
        },
      }),
    )
    .mockResolvedValueOnce(Response.json({ data: { total_credits: 100, total_usage: 35 } }));
  const result = await openRouterAccount('fixture', new AbortController().signal, fetcher);
  expect(result.limitKnown).toBe(true);
  expect(result.limitUsd).toBeNull();
  expect(result.remainingUsd).toBeNull();
  expect(result.accountCreditsUsd).toBe(65);
});
it('keeps key usage when account credits cannot be fetched and hides raw errors', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        data: {
          limit: 10,
          usage: 2,
          is_management_key: true,
        },
      }),
    )
    .mockResolvedValueOnce(new Response('secret-error', { status: 403 }));
  const result = await openRouterAccount('fixture', new AbortController().signal, fetcher);
  expect(result.usageUsd).toBe(2);
  expect(result.creditsStatus).toBe('unavailable');
  const rejected = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response('secret-error', { status: 401 }));
  await expect(
    openRouterAccount('fixture', new AbortController().signal, rejected),
  ).rejects.toThrow('HTTP 401');
  await expect(openRouterAccount(null, new AbortController().signal, rejected)).rejects.toThrow(
    '먼저 연결',
  );
});
