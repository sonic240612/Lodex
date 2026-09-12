import { useEffect, useRef, useState } from 'react';
import {
  engineSettingsSchema,
  runtimeSettingsSchema,
  type LocalProfile,
  type LocalProfileInput,
  type RuntimeSnapshot,
  type EngineSettings,
} from '@lodex/contracts';
import {
  configureRuntime,
  nativeDesktop,
  pickRuntimeFile,
  runtimeAction,
  runtimeSnapshot,
  saveLocalProfile,
} from './bridge';
import { Icon } from './icons';

const blank = (): LocalProfileInput => ({
  name: '',
  enginePath: '',
  modelPath: '',
  settings: engineSettingsSchema.parse({}),
  vramReservationMb: 22528,
});
export function ModelManager({
  onClose,
  onChoose,
}: {
  onClose: () => void;
  onChoose: (profile: LocalProfile) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const snapshotRequest = useRef(0);
  const budgetInitialized = useRef(false);
  const [state, setState] = useState<RuntimeSnapshot>({
    profiles: [],
    instances: [],
    settings: runtimeSettingsSchema.parse({}),
  });
  const [draft, setDraft] = useState(blank),
    [budget, setBudget] = useState(runtimeSettingsSchema.parse({}));
  const [trusted, setTrusted] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [extra, setExtra] = useState('[]');
  const [gpuText, setGpuText] = useState('auto');
  const [loaded, setLoaded] = useState(!nativeDesktop);
  const [connectionError, setConnectionError] = useState('');
  const budgetConflict = loaded && budget.version !== state.settings.version;
  const savedProfile = state.profiles.find((profile) => profile.id === draft.id);
  const profileConflict = !!draft.id && savedProfile?.version !== draft.expectedVersion;
  const unavailable = !nativeDesktop || !loaded;
  async function refresh() {
    const request = ++snapshotRequest.current;
    try {
      const next = await runtimeSnapshot();
      if (!mounted.current || request !== snapshotRequest.current) return;
      setState(next);
      setConnectionError('');
      setLoaded(true);
      if (!budgetInitialized.current) {
        setBudget(next.settings);
        budgetInitialized.current = true;
      }
    } catch (failure) {
      if (mounted.current && request === snapshotRequest.current)
        setConnectionError(failure instanceof Error ? failure.message : String(failure));
    }
  }
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    let pending = false;
    const poll = async () => {
      if (!nativeDesktop || pending) return;
      pending = true;
      try {
        await refresh();
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      mounted.current = false;
      snapshotRequest.current++;
      clearInterval(timer);
    };
  }, []);
  async function operation(work: () => Promise<void>, refreshAfter = true) {
    if (busyRef.current || unavailable) return;
    busyRef.current = true;
    snapshotRequest.current++;
    setBusy(true);
    setError('');
    try {
      await work();
      if (mounted.current && refreshAfter) await refresh();
    } catch (failure) {
      if (mounted.current) {
        setError(failure instanceof Error ? failure.message : String(failure));
        if (refreshAfter) await refresh();
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function resetDraft() {
    setDraft(blank());
    setGpuText('auto');
    setExtra('[]');
    setTrusted(false);
  }
  function editProfile(profile: LocalProfile) {
    setDraft({
      id: profile.id,
      expectedVersion: profile.version,
      name: profile.name,
      enginePath: profile.enginePath,
      modelPath: profile.modelPath,
      settings: profile.settings,
      vramReservationMb: profile.vramReservationMb,
    });
    setGpuText(String(profile.settings.gpuLayers));
    setExtra(JSON.stringify(profile.settings.extraArgs, null, 2));
    setTrusted(false);
    setError('');
  }
  function settings<K extends keyof EngineSettings>(key: K, value: EngineSettings[K]) {
    setDraft({ ...draft, settings: { ...draft.settings, [key]: value } });
  }
  return (
    <dialog
      className="settings-dialog model-manager"
      ref={dialog}
      onCancel={onClose}
      aria-labelledby="model-manager-title"
      aria-busy={busy}
    >
      <div className="dialog-header">
        <h2 id="model-manager-title">로컬 모델</h2>
        <button className="icon-button" aria-label="모델 관리 닫기" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="settings-body">
        {!nativeDesktop && (
          <p className="demo-notice">모델 파일 등록과 로딩은 데스크톱 앱에서 사용할 수 있습니다.</p>
        )}
        {!loaded && <p role="status">모델 설정을 불러오는 중…</p>}
        {connectionError && (
          <p role="alert" className="form-error">
            {connectionError}
          </p>
        )}
        <section className="runtime-budget">
          <h3>VRAM 예약</h3>
          <p>
            등록한 예약량으로 모델을 배치합니다. 실제 VRAM 사용량을 강제로 제한하지 않으며, KV
            cache와 다른 앱의 사용량에 따라 조정이 필요합니다.
          </p>
          <fieldset disabled={busy || !loaded}>
            <div className="settings-grid">
              <label className="field">
                전체 예산 MiB
                <input
                  type="number"
                  min={0}
                  max={1048576}
                  value={budget.vramBudgetMb}
                  onChange={(e) => setBudget({ ...budget, vramBudgetMb: Number(e.target.value) })}
                />
              </label>
              <label className="field">
                남겨 둘 공간 MiB
                <input
                  type="number"
                  min={0}
                  max={65536}
                  value={budget.headroomMb}
                  onChange={(e) => setBudget({ ...budget, headroomMb: Number(e.target.value) })}
                />
              </label>
            </div>
            <label className="check-field">
              <input
                type="checkbox"
                checked={budget.autoUnloadIdle}
                onChange={(e) => setBudget({ ...budget, autoUnloadIdle: e.target.checked })}
              />
              공간이 부족하면 사용하지 않는 모델부터 언로드
            </label>
            <button
              className="secondary-button"
              disabled={unavailable || busy || budgetConflict}
              onClick={() =>
                void operation(async () => {
                  const next = await configureRuntime(budget);
                  if (mounted.current) {
                    setState(next);
                    setBudget(next.settings);
                  }
                })
              }
            >
              VRAM 설정 저장
            </button>
            {budgetConflict && (
              <div role="status">
                <p>
                  다른 창에서 VRAM 설정을 변경했습니다. 저장된 설정을 다시 불러온 뒤 편집하세요.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setBudget(state.settings);
                    setError('');
                  }}
                >
                  저장된 VRAM 설정 불러오기
                </button>
              </div>
            )}
          </fieldset>
        </section>
        <section className="local-model-list" aria-label="등록한 모델">
          {loaded && !state.profiles.length && (
            <p>등록한 모델이 없습니다. 아래에서 엔진과 GGUF 파일을 선택하세요.</p>
          )}
          {state.profiles.map((profile) => {
            const instance = state.instances.find((i) => i.profileId === profile.id);
            return (
              <article className="local-model" key={profile.id}>
                <strong>{profile.name}</strong>
                <span>
                  {instance
                    ? {
                        loading: '로딩 중',
                        ready: '준비됨',
                        stopped: '언로드됨',
                        failed: '실행 실패',
                      }[instance.status]
                    : '언로드됨'}{' '}
                  · {(profile.modelBytes / 1024 ** 3).toFixed(2)} GiB · 설정 예약{' '}
                  {profile.vramReservationMb} MiB
                  {!!instance?.leases && ` · 사용 중 ${instance.leases}개 대화`}
                </span>
                <div className="edit-actions">
                  <button
                    disabled={unavailable || busy || instance?.status === 'loading'}
                    onClick={() => void operation(() => onChoose(profile), false)}
                  >
                    이 모델로 새 대화
                  </button>
                  <button
                    disabled={
                      unavailable ||
                      busy ||
                      instance?.status === 'ready' ||
                      instance?.status === 'loading'
                    }
                    onClick={() =>
                      void operation(async () => {
                        await runtimeAction(profile.id, 'load');
                      })
                    }
                  >
                    로드
                  </button>
                  <button
                    disabled={
                      unavailable ||
                      busy ||
                      !instance ||
                      instance.status !== 'ready' ||
                      instance.leases > 0
                    }
                    onClick={() =>
                      void operation(async () => {
                        await runtimeAction(profile.id, 'unload');
                      })
                    }
                  >
                    언로드
                  </button>
                  <button
                    disabled={
                      unavailable ||
                      busy ||
                      instance?.status === 'loading' ||
                      (instance?.leases ?? 0) > 0
                    }
                    onClick={() => editProfile(profile)}
                  >
                    설정 편집
                  </button>
                  <button
                    disabled={
                      unavailable ||
                      busy ||
                      instance?.status === 'loading' ||
                      (instance?.leases ?? 0) > 0
                    }
                    onClick={() =>
                      void operation(async () => {
                        await runtimeAction(profile.id, 'remove');
                        if (mounted.current && draft.id === profile.id) resetDraft();
                      })
                    }
                  >
                    목록에서 제거
                  </button>
                </div>
                {instance?.error && <p className="danger-text">{instance.error}</p>}
                <details>
                  <summary>엔진 정보·로그</summary>
                  <p>{profile.engineVersion}</p>
                  <p>{profile.modelPath}</p>
                  <p>
                    GGUF v{profile.ggufVersion} 헤더 확인 · 전체 파일 무결성 검사는 아직 수행하지
                    않음
                  </p>
                  <pre>{instance?.log || '실행 로그 없음'}</pre>
                </details>
              </article>
            );
          })}
        </section>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!trusted || profileConflict) return;
            void operation(async () => {
              const gpu = gpuText.trim();
              if (!['auto', 'all'].includes(gpu) && !/^\d+$/.test(gpu))
                throw new Error('GPU layers에 auto, all 또는 0 이상의 정수를 입력하세요.');
              const settings = engineSettingsSchema.parse({
                ...draft.settings,
                gpuLayers: ['auto', 'all'].includes(gpu) ? gpu : Number(gpu),
                extraArgs: JSON.parse(extra),
              });
              await saveLocalProfile({ ...draft, settings });
              if (mounted.current) resetDraft();
            });
          }}
        >
          <fieldset disabled={busy || !loaded}>
            <h3>{draft.id ? '모델 설정 편집' : '모델 등록'}</h3>
            {profileConflict && (
              <div role="status">
                <p>
                  {savedProfile
                    ? '다른 창에서 모델 설정을 변경했습니다. 다시 불러온 뒤 편집하세요.'
                    : '이 모델은 목록에서 제거되었습니다. 새 모델로 등록할 수 있습니다.'}
                </p>
                {savedProfile ? (
                  <button type="button" onClick={() => editProfile(savedProfile)}>
                    저장된 모델 설정 불러오기
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(({ id: _id, expectedVersion: _version, ...value }) => value);
                      setTrusted(false);
                    }}
                  >
                    새 모델로 전환
                  </button>
                )}
              </div>
            )}
            <label className="field">
              이름
              <input
                required
                maxLength={200}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            {(['enginePath', 'modelPath'] as const).map((key) => (
              <label className="field" key={key}>
                {key === 'enginePath' ? 'llama-server 실행 파일' : 'GGUF 모델 파일'}
                <div className="input-action">
                  <input
                    required
                    value={draft[key]}
                    onChange={(e) => {
                      setDraft({ ...draft, [key]: e.target.value });
                      setTrusted(false);
                    }}
                  />
                  <button
                    type="button"
                    disabled={unavailable || busy}
                    onClick={() =>
                      void operation(async () => {
                        const path = await pickRuntimeFile(
                          key === 'enginePath' ? 'engine' : 'model',
                        );
                        if (path && mounted.current) {
                          setDraft((current) => ({ ...current, [key]: path }));
                          setTrusted(false);
                        }
                      }, false)
                    }
                  >
                    파일 선택
                  </button>
                </div>
              </label>
            ))}
            <div className="settings-grid">
              {(
                [
                  ['contextSize', '컨텍스트 길이', 1024, 2097152],
                  ['threads', '생성 스레드', 1, 1024],
                  ['batchThreads', '프리필 스레드', 1, 1024],
                  ['batchSize', 'Batch', 1, 65536],
                  ['microBatchSize', 'Micro batch', 1, 65536],
                ] as const
              ).map(([key, label, min, max]) => (
                <label className="field" key={key}>
                  {label}
                  <input
                    type="number"
                    required
                    min={min}
                    max={max}
                    value={draft.settings[key]}
                    onChange={(e) => settings(key, Number(e.target.value))}
                  />
                </label>
              ))}
              <label className="field">
                GPU layers
                <input value={gpuText} onChange={(e) => setGpuText(e.target.value)} />
                <small>auto, all 또는 0 이상의 정수</small>
              </label>
              <label className="field">
                VRAM 예약 MiB
                <input
                  type="number"
                  min={0}
                  max={1048576}
                  value={draft.vramReservationMb}
                  onChange={(e) =>
                    setDraft({ ...draft, vramReservationMb: Number(e.target.value) })
                  }
                />
              </label>
              <label className="field">
                Flash attention
                <select
                  value={draft.settings.flashAttention}
                  onChange={(e) =>
                    settings('flashAttention', e.target.value as EngineSettings['flashAttention'])
                  }
                >
                  {['auto', 'on', 'off'].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              {(['cacheTypeK', 'cacheTypeV'] as const).map((key) => (
                <label className="field" key={key}>
                  {key === 'cacheTypeK' ? 'K cache' : 'V cache'}
                  <select
                    value={draft.settings[key]}
                    onChange={(e) => settings(key, e.target.value as EngineSettings['cacheTypeK'])}
                  >
                    {['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'].map(
                      (v) => (
                        <option key={v}>{v}</option>
                      ),
                    )}
                  </select>
                </label>
              ))}
            </div>
            <label className="check-field">
              <input
                type="checkbox"
                checked={draft.settings.kvOffload}
                onChange={(e) => settings('kvOffload', e.target.checked)}
              />
              KV cache GPU offload
            </label>
            <details>
              <summary>고급 설정</summary>
              <label className="field">
                Chat template
                <textarea
                  rows={4}
                  value={draft.settings.chatTemplate}
                  onChange={(e) => settings('chatTemplate', e.target.value)}
                  placeholder="비워 두면 GGUF의 템플릿 사용"
                />
              </label>
              <label className="field">
                추가 엔진 인자 (JSON 배열)
                <textarea
                  rows={4}
                  value={extra}
                  onChange={(e) => setExtra(e.target.value)}
                  placeholder={'["--seed", "42"]'}
                />
              </label>
              <p>
                설치한 엔진의 옵션 목록을 검사합니다. 모델 경로·네트워크·인증과 위 관리 설정은 추가
                인자로 덮어쓸 수 없습니다.
              </p>
            </details>
            <label className="check-field">
              <input
                type="checkbox"
                checked={trusted}
                onChange={(e) => setTrusted(e.target.checked)}
              />
              선택한 엔진 실행 파일을 신뢰하며 정보 조회와 모델 로딩에 사용
            </label>
            <div className="edit-actions">
              <button
                className="primary-button"
                disabled={unavailable || busy || !trusted || profileConflict}
              >
                {busy ? '처리 중…' : '엔진 확인·모델 저장'}
              </button>
              {draft.id && (
                <button type="button" onClick={resetDraft}>
                  새 모델 입력
                </button>
              )}
            </div>
          </fieldset>
        </form>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </div>
    </dialog>
  );
}
