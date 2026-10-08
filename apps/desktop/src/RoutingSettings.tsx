import { t as localize } from './i18n';
import { SettingsSurface } from './SettingsSurface';
import { useEffect, useRef, useState } from 'react';
import {
  agentRoutingConfigSchema,
  defaultProviderBaseUrl,
  isLocalProvider,
  type AgentRoutingConfig,
  type ModelConfig,
  type LocalProfile,
  type ModelDescriptor,
} from '@lodex/contracts';
import { nativeDesktop, runtimeSnapshot } from './bridge';
import { useModelCatalog } from './useModelCatalog';
import { selectCatalogModel } from './model-catalog';
import { Icon } from './icons';
import { LocalModelFields } from './LocalModelFields';

function automaticOutputTokens(context: number, descriptor?: ModelDescriptor) {
  return Math.max(
    1,
    Math.min(
      Math.floor(context * 0.2),
      descriptor?.maxCompletionTokens ?? Number.POSITIVE_INFINITY,
      1048576,
    ),
  );
}

export function RoutingSettings({
  embedded = false,
  base,
  routing,
  hasMessages,
  running,
  onClose,
  onSave,
}: {
  embedded?: boolean;
  base: ModelConfig;
  routing?: AgentRoutingConfig | undefined;
  hasMessages: boolean;
  running: boolean;
  onClose: () => void;
  onSave: (value: AgentRoutingConfig) => Promise<void>;
}) {
  const [draft, setDraft] = useState<AgentRoutingConfig>(routing ?? { subagentsEnabled: false });
  const [profiles, setProfiles] = useState<LocalProfile[]>([]);
  const usesOpenRouter = (['plan', 'build', 'subagent', 'summary', 'review'] as const).some(
    (role) => draft[role]?.provider === 'openrouter',
  );
  const { catalog, catalogError, catalogNotice, catalogLoading, refreshCatalog } = useModelCatalog(
    { ...base, provider: 'openrouter' },
    nativeDesktop && usesOpenRouter,
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    let live = true;
    if (nativeDesktop)
      void runtimeSnapshot()
        .then((value) => {
          if (live) setProfiles(value.profiles);
        })
        .catch((error) => {
          if (live) setError(String(error));
        });
    return () => {
      live = false;
    };
  }, []);
  return (
    <SettingsSurface
      embedded={embedded}
      aria-busy={saving}
      ref={dialog}
      className="settings-dialog routing-modal"
      aria-labelledby="routing-title"
      onCancel={(event) => {
        if (saving) event.preventDefault();
        else onClose();
      }}
    >
      <header>
        <h2 id="routing-title">{localize('역할별 모델')}</h2>
        <button
          className="icon-button"
          aria-label={localize('닫기')}
          disabled={saving}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setSaving(true);
          setError('');
          void Promise.resolve()
            .then(() => onSave(agentRoutingConfigSchema.parse(draft)))
            .catch((error) => setError(error instanceof Error ? error.message : String(error)))
            .finally(() => setSaving(false));
        }}
      >
        <div className="settings-content">
          {usesOpenRouter && (
            <>
              <button
                type="button"
                className="secondary-button"
                disabled={catalogLoading || saving}
                onClick={() => void refreshCatalog()}
              >
                {catalogLoading
                  ? localize('모델 목록 조회 중…')
                  : localize('OpenRouter 모델 목록 새로고침')}
              </button>
              {catalogError && (
                <p className="form-error" role="alert">
                  {catalogError}
                </p>
              )}
              {catalogNotice && (
                <p className="field-hint" role="status">
                  {catalogNotice}
                </p>
              )}
            </>
          )}
          <p>
            {localize('기본 모델: ')}
            {base.model || localize('미설정')}
            {localize(
              '. 요약·검토 역할을 지정하지 않으면 현재 작업 모델을 사용합니다. 다른 역할은 기본 모델을 사용합니다.',
            )}
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.subagentsEnabled}
              disabled={running || saving}
              onChange={(event) => setDraft({ ...draft, subagentsEnabled: event.target.checked })}
            />
            {localize('서브에이전트 사용')}
          </label>
          <p className="field-note">
            {localize(
              '한 번에 최대 3개 작업을 별도 컨텍스트에서 진행합니다. Plan에서는 읽기만 허용하고, Build에서는 별도 Worktree의 수정과 허용된 명령을 실행할 수 있습니다. 부모의 권한·호출 예산·중지 신호를 공유합니다. 로컬 추론은 순서대로 실행합니다.',
            )}
          </p>
          {(['plan', 'build', 'subagent', 'summary', 'review'] as const).map((role) => {
            const config = draft[role];
            const change = (update: Partial<ModelConfig>) =>
              setDraft((old) => ({ ...old, [role]: { ...(old[role] ?? base), ...update } }));
            return (
              <fieldset key={role} disabled={running || saving} className="routing-role">
                <legend>
                  {role === 'plan'
                    ? localize('Plan · 계획')
                    : role === 'build'
                      ? localize('Build · 작업')
                      : role === 'summary'
                        ? localize('요약 · 컨텍스트 압축')
                        : role === 'review'
                          ? localize('검토 · 결과 확인')
                          : localize('서브에이전트 · 작업')}
                </legend>
                <label>
                  {localize('연결')}
                  <select
                    value={
                      !config
                        ? 'default'
                        : config.managedModelId
                          ? 'managed:' + config.managedModelId
                          : config.provider
                    }
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value === 'default') {
                        setDraft((old) => {
                          const next = { ...old };
                          delete next[role];
                          return next;
                        });
                        return;
                      }
                      const {
                        managedModelId: _id,
                        managedModelVersion: _version,
                        ...external
                      } = base;
                      if (value.startsWith('managed:')) {
                        const profile = profiles.find((item) => item.id === value.slice(8));
                        if (!profile) return;
                        setDraft((old) => ({
                          ...old,
                          [role]: {
                            ...external,
                            provider: 'llama-server',
                            model: profile.name,
                            managedModelId: profile.id,
                            managedModelVersion: profile.version,
                            contextBudgetTokens: profile.settings.contextSize,
                            maxTokens: Math.min(
                              base.maxTokens,
                              Math.floor(profile.settings.contextSize / 4),
                            ),
                            cloudConsent: false,
                            projectCloudConsent: false,
                          },
                        }));
                      } else
                        setDraft((old) => ({
                          ...old,
                          [role]: {
                            ...external,
                            provider: value as ModelConfig['provider'],
                            baseUrl: defaultProviderBaseUrl(value as ModelConfig['provider']),
                            model: '',
                            cloudConsent: false,
                            projectCloudConsent: false,
                          },
                        }));
                    }}
                  >
                    <option value="default">{localize('기본 모델 사용')}</option>
                    <option value="llama-server">{localize('외부 llama-server')}</option>
                    <option value="ollama">Ollama</option>
                    <option value="vllm">vLLM</option>
                    <option value="mlx">MLX</option>
                    <option value="openrouter">OpenRouter</option>
                    {profiles.map((profile) => (
                      <option key={profile.id} value={'managed:' + profile.id}>
                        {profile.name}
                        {localize(' · 관리 모델 v')}
                        {profile.version}
                      </option>
                    ))}
                    {config?.managedModelId &&
                      !profiles.some((profile) => profile.id === config.managedModelId) && (
                        <option value={'managed:' + config.managedModelId}>
                          {localize('등록이 없는 모델 · 다시 선택')}
                        </option>
                      )}
                    {config?.provider === 'demo' && (
                      <option value="demo">{localize('데모')}</option>
                    )}
                  </select>
                </label>
                {config && (
                  <>
                    {!config.managedModelId && !isLocalProvider(config.provider) && (
                      <label>
                        {localize('모델 ID')}
                        <input
                          list={
                            config.provider === 'openrouter'
                              ? 'routing-openrouter-models'
                              : undefined
                          }
                          value={config.model}
                          required
                          onChange={(event) => {
                            const model = event.target.value;
                            const descriptor = catalog.find((item) => item.id === model);
                            if (config.provider === 'openrouter' && descriptor)
                              setDraft((old) => ({
                                ...old,
                                [role]: selectCatalogModel(old[role] ?? base, descriptor),
                              }));
                            else change({ model });
                          }}
                        />
                      </label>
                    )}
                    {isLocalProvider(config.provider) && !config.managedModelId && (
                      <LocalModelFields config={config} onChange={(next) => change(next)} />
                    )}
                    {config.managedModelId && (
                      <p>
                        {localize('엔진 설정 v')}
                        {config.managedModelVersion}
                        {localize(' · 모델 관리에서 변경 후 다시 선택하세요.')}
                      </p>
                    )}
                    <div className="routing-numbers">
                      {(
                        [
                          ['temperature', 'Temperature', 0, 2, 0.1],
                          ['topP', 'Top P', 0.01, 1, 0.01],
                          ['maxTokens', localize('최대 출력 토큰'), 1, 1048576, 1],
                          ['contextBudgetTokens', localize('컨텍스트 예산'), 1024, 2097152, 1],
                        ] as const
                      ).map(([key, label, min, max, step]) => (
                        <label
                          key={key}
                          className={
                            (key === 'temperature' && config.useDefaultTemperature) ||
                            (key === 'topP' && config.useDefaultTopP) ||
                            (key === 'maxTokens' && config.autoMaxTokens)
                              ? 'generation-value-disabled'
                              : undefined
                          }
                        >
                          {label}
                          <input
                            type="number"
                            value={config[key]}
                            min={min}
                            max={max}
                            step={step}
                            required
                            disabled={
                              (key === 'maxTokens' && config.autoMaxTokens) ||
                              (key === 'temperature' && config.useDefaultTemperature) ||
                              (key === 'topP' && config.useDefaultTopP)
                            }
                            onChange={(event) => {
                              const value = Number(event.target.value);
                              if (key === 'contextBudgetTokens' && config.autoMaxTokens)
                                change({
                                  contextBudgetTokens: value,
                                  maxTokens: automaticOutputTokens(
                                    value,
                                    catalog.find((item) => item.id === config.model),
                                  ),
                                });
                              else change({ [key]: value });
                            }}
                          />
                        </label>
                      ))}
                    </div>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={config.useDefaultTemperature}
                        onChange={(event) =>
                          change({ useDefaultTemperature: event.target.checked })
                        }
                      />
                      {localize('Temperature 기본값 사용')}
                    </label>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={config.useDefaultTopP}
                        onChange={(event) => change({ useDefaultTopP: event.target.checked })}
                      />
                      {localize('Top P 기본값 사용')}
                    </label>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={config.autoMaxTokens}
                        onChange={(event) =>
                          change({
                            autoMaxTokens: event.target.checked,
                            maxTokens: event.target.checked
                              ? automaticOutputTokens(
                                  config.contextBudgetTokens,
                                  catalog.find((item) => item.id === config.model),
                                )
                              : config.maxTokens,
                          })
                        }
                      />
                      {localize('최대 출력 자동 · 컨텍스트의 20%')}
                    </label>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={config.eco}
                        onChange={(event) => change({ eco: event.target.checked })}
                      />
                      Eco
                    </label>
                    {config.provider === 'openrouter' && (
                      <>
                        <label className="check-row">
                          <input
                            type="checkbox"
                            checked={config.cloudConsent}
                            required
                            onChange={(event) => change({ cloudConsent: event.target.checked })}
                          />
                          {localize('이 역할의 요청을 OpenRouter로 전송 허용')}
                        </label>
                        <label className="check-row">
                          <input
                            type="checkbox"
                            checked={config.projectCloudConsent}
                            onChange={(event) =>
                              change({ projectCloudConsent: event.target.checked })
                            }
                          />
                          {localize('프로젝트 내용과 작업 결과 전송 허용')}
                        </label>
                      </>
                    )}
                  </>
                )}
              </fieldset>
            );
          })}
          {hasMessages && (
            <p>{localize('대화 기록을 유지하고 다음 요청부터 변경한 역할별 모델을 사용합니다.')}</p>
          )}
          <datalist id="routing-openrouter-models">
            {catalog.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </datalist>
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
        </div>
        <footer>
          <button type="button" disabled={saving} onClick={onClose}>
            {localize('취소')}
          </button>
          <button className="primary-button" disabled={saving || running}>
            {saving ? localize('저장 중…') : localize('저장')}
          </button>
        </footer>
      </form>
    </SettingsSurface>
  );
}
