import { t as localize } from './i18n';
import type { ModelConfig } from '@lodex/contracts';
import { defaultProviderBaseUrl, providerLabel } from '@lodex/contracts';
import { useId } from 'react';
import { useModelCatalog } from './useModelCatalog';
import { selectCatalogModel } from './model-catalog';
import { nativeDesktop } from './bridge';

/** External servers own their processes and memory; this form changes connection settings only. */
export function LocalModelFields({
  config,
  onChange,
}: {
  config: ModelConfig;
  onChange: (next: ModelConfig) => void;
}) {
  const id = useId();
  const { catalog, catalogError, catalogLoading, refreshCatalog } = useModelCatalog(
    config,
    nativeDesktop,
  );
  return (
    <>
      <label>
        {localize('서버 주소')}
        <input
          value={config.baseUrl}
          placeholder={defaultProviderBaseUrl(config.provider)}
          onChange={(event) => onChange({ ...config, baseUrl: event.target.value })}
        />
      </label>
      <label>
        {localize('모델 ID')}
        <div className="input-action">
          <input
            value={config.model}
            required
            list={id}
            onChange={(event) => {
              const descriptor = catalog.find((item) => item.id === event.target.value);
              onChange(
                descriptor
                  ? selectCatalogModel(config, descriptor)
                  : { ...config, model: event.target.value },
              );
            }}
          />
          <button
            type="button"
            className="secondary-button"
            disabled={!nativeDesktop || catalogLoading}
            onClick={() => void refreshCatalog()}
          >
            {catalogLoading ? localize('조회 중…') : localize('목록 조회')}
          </button>
        </div>
      </label>
      <datalist id={id}>
        {catalog.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </datalist>
      {catalogError && (
        <p className="form-error" role="alert">
          {catalogError}
        </p>
      )}
      {config.provider === 'ollama' && (
        <label>
          {localize('응답 후 모델 유지 시간 (초)')}
          <input
            type="number"
            min={0}
            max={86400}
            value={config.keepAliveSeconds ?? ''}
            placeholder={localize('서버 기본값')}
            onChange={(event) => {
              const next = { ...config };
              if (event.target.value === '') delete next.keepAliveSeconds;
              else next.keepAliveSeconds = Number(event.target.value);
              onChange(next);
            }}
          />
          <small>{localize('0은 응답 후 즉시 해제, 빈칸은 Ollama 기본값입니다.')}</small>
        </label>
      )}
      <p className="field-hint">
        {providerLabel(config.provider)}
        {localize(
          '의 실행 중인 로컬·사설·Tailscale 서버에 연결합니다. 프로세스와 메모리는 해당 서버에서 관리합니다.',
        )}
      </p>
    </>
  );
}
