import { useEffect, useRef, useState } from 'react';
import {
  agentRoutingConfigSchema,
  type AgentRoutingConfig,
  type ModelConfig,
  type LocalProfile,
  type ModelDescriptor,
} from '@lodex/contracts';
import { models, nativeDesktop, runtimeSnapshot } from './bridge';
import { Icon } from './icons';

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

function applyModelDefaults(config: ModelConfig, descriptor: ModelDescriptor): ModelConfig {
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

export function RoutingSettings({
  base,
  routing,
  hasMessages,
  running,
  onClose,
  onSave,
}: {
  base: ModelConfig;
  routing?: AgentRoutingConfig | undefined;
  hasMessages: boolean;
  running: boolean;
  onClose: () => void;
  onSave: (value: AgentRoutingConfig) => Promise<void>;
}) {
  const [draft, setDraft] = useState<AgentRoutingConfig>(routing ?? { subagentsEnabled: false });
  const [profiles, setProfiles] = useState<LocalProfile[]>([]);
  const [catalog, setCatalog] = useState<ModelDescriptor[]>([]);
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
  useEffect(() => {
    if (
      !nativeDesktop ||
      catalog.length ||
      !(['plan', 'build', 'subagent'] as const).some(
        (role) => draft[role]?.provider === 'openrouter',
      )
    )
      return;
    let live = true;
    void models('openrouter', '')
      .then((items) => {
        if (!live) return;
        setCatalog(items);
        setDraft((current) => {
          const next = { ...current };
          for (const role of ['plan', 'build', 'subagent'] as const) {
            const config = current[role];
            const descriptor = items.find((item) => item.id === config?.model);
            if (config?.provider === 'openrouter' && descriptor)
              next[role] = applyModelDefaults(config, descriptor);
          }
          return next;
        });
      })
      .catch((failure) => {
        if (live) setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      live = false;
    };
  }, [catalog.length, draft.build?.provider, draft.plan?.provider, draft.subagent?.provider]);
  return (
    <dialog
      ref={dialog}
      className="settings-dialog routing-modal"
      aria-labelledby="routing-title"
      onCancel={(event) => {
        if (saving) event.preventDefault();
        else onClose();
      }}
    >
      <header>
        <h2 id="routing-title">역할별 모델</h2>
        <button className="icon-button" aria-label="닫기" disabled={saving} onClick={onClose}>
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
          <p>기본 모델: {base.model || '미설정'}. 역할을 지정하지 않으면 이 모델을 사용합니다.</p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.subagentsEnabled}
              disabled={running || saving}
              onChange={(event) => setDraft({ ...draft, subagentsEnabled: event.target.checked })}
            />
            서브에이전트 사용
          </label>
          <p className="field-note">
            한 번에 최대 3개 작업을 별도 컨텍스트에서 분석합니다. 프로젝트 읽기만 허용하며, 부모의
            호출 예산과 중지 신호를 공유합니다. 로컬 추론은 순서대로 실행합니다.
          </p>
          {(['plan', 'build', 'subagent'] as const).map((role) => {
            const config = draft[role];
            const change = (update: Partial<ModelConfig>) =>
              setDraft((old) => ({ ...old, [role]: { ...(old[role] ?? base), ...update } }));
            return (
              <fieldset key={role} disabled={running || saving} className="routing-role">
                <legend>
                  {role === 'plan'
                    ? 'Plan · 계획'
                    : role === 'build'
                      ? 'Build · 작업'
                      : '서브에이전트 · 분석'}
                </legend>
                <label>
                  연결
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
                            model: '',
                            cloudConsent: false,
                            projectCloudConsent: false,
                          },
                        }));
                    }}
                  >
                    <option value="default">기본 모델 사용</option>
                    <option value="llama-server">외부 llama-server</option>
                    <option value="openrouter">OpenRouter</option>
                    {profiles.map((profile) => (
                      <option key={profile.id} value={'managed:' + profile.id}>
                        {profile.name} · 관리 모델 v{profile.version}
                      </option>
                    ))}
                    {config?.managedModelId &&
                      !profiles.some((profile) => profile.id === config.managedModelId) && (
                        <option value={'managed:' + config.managedModelId}>
                          등록이 없는 모델 · 다시 선택
                        </option>
                      )}
                    {config?.provider === 'demo' && <option value="demo">데모</option>}
                  </select>
                </label>
                {config && (
                  <>
                    {!config.managedModelId && (
                      <label>
                        모델 ID
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
                                [role]: applyModelDefaults(old[role] ?? base, descriptor),
                              }));
                            else change({ model });
                          }}
                        />
                      </label>
                    )}
                    {config.provider === 'llama-server' && !config.managedModelId && (
                      <label>
                        서버 주소
                        <input
                          value={config.baseUrl}
                          onChange={(event) => change({ baseUrl: event.target.value })}
                        />
                      </label>
                    )}
                    {config.managedModelId && (
                      <p>
                        엔진 설정 v{config.managedModelVersion} · 모델 관리에서 변경 후 다시
                        선택하세요.
                      </p>
                    )}
                    <div className="routing-numbers">
                      {(
                        [
                          ['temperature', 'Temperature', 0, 2, 0.1],
                          ['topP', 'Top P', 0.01, 1, 0.01],
                          ['maxTokens', '최대 출력 토큰', 1, 1048576, 1],
                          ['contextBudgetTokens', '컨텍스트 예산', 1024, 2097152, 1],
                        ] as const
                      ).map(([key, label, min, max, step]) => (
                        <label key={key}>
                          {label}
                          <input
                            type="number"
                            value={config[key]}
                            min={min}
                            max={max}
                            step={step}
                            required
                            disabled={key === 'maxTokens' && config.autoMaxTokens}
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
                      최대 출력 자동 · 컨텍스트의 20%
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
                          이 역할의 요청을 OpenRouter로 전송 허용
                        </label>
                        <label className="check-row">
                          <input
                            type="checkbox"
                            checked={config.projectCloudConsent}
                            onChange={(event) =>
                              change({ projectCloudConsent: event.target.checked })
                            }
                          />
                          프로젝트 내용과 작업 결과 전송 허용
                        </label>
                      </>
                    )}
                  </>
                )}
              </fieldset>
            );
          })}
          {hasMessages && (
            <p>저장하면 같은 프로젝트에 새 대화를 만듭니다. 기존 대화의 설정은 유지됩니다.</p>
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
            취소
          </button>
          <button className="primary-button" disabled={saving || running}>
            {saving ? '저장 중…' : hasMessages ? '새 대화로 저장' : '저장'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
