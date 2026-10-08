import { t as localize } from './i18n';
import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { OpenRouterAccount as Account } from '@lodex/contracts';
import { nativeDesktop } from './bridge';

const usd = (value: number | null) =>
  value === null ? localize('확인 불가') : '$' + value.toFixed(4);
export function OpenRouterAccount({ configured }: { configured: boolean }) {
  const [account, setAccount] = useState<Account>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="openrouter-account">
      <button
        type="button"
        className="secondary-button"
        disabled={!nativeDesktop || !configured || busy}
        onClick={() => {
          setBusy(true);
          setError('');
          setAccount(undefined);
          void invoke<Account>('daemon_request', {
            method: 'GET',
            path: '/v1/openrouter/account',
            body: null,
          })
            .then(setAccount)
            .catch((failure) =>
              setError(failure instanceof Error ? failure.message : String(failure)),
            )
            .finally(() => setBusy(false));
        }}
      >
        {busy ? localize('사용량 조회 중…') : localize('키 상태·사용량 조회')}
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {account && (
        <div role="status">
          <p>
            {localize('키 사용량 ')}
            {usd(account.usageUsd)}
            {localize(' · 오늘 ')}
            {usd(account.dailyUsageUsd)}
            {localize(' · 이번 달 ')}
            {usd(account.monthlyUsageUsd)}
          </p>
          <p>
            {localize('키 잔여 한도 ')}
            {account.limitKnown && account.limitUsd === null
              ? localize('별도 한도 없음')
              : usd(account.remainingUsd)}
            {account.limitUsd !== null && ` / ${usd(account.limitUsd)}`}
          </p>
          {account.accountCreditsUsd !== null && (
            <p>
              {localize('계정 잔액 ')}
              {usd(account.accountCreditsUsd)}
            </p>
          )}
          {account.creditsStatus !== 'available' && (
            <p className="field-hint">
              {localize(
                '계정 전체 잔액은 이 키로 확인하지 못했습니다. 키 한도와 계정 잔액은 별개입니다.',
              )}
            </p>
          )}
          {account.expiresAt && (
            <p>
              {localize('키 만료 ')}
              {new Date(account.expiresAt).toLocaleString()}
            </p>
          )}
          <p className="field-hint">
            {localize('조회 시각 ')}
            {new Date(account.checkedAt).toLocaleString()}
            {localize(' · OpenRouter 보고 값')}
          </p>
        </div>
      )}
    </div>
  );
}
