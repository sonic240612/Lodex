import { t as localize } from './i18n';
import { SettingsSurface } from './SettingsSurface';
import { useEffect, useRef, useState } from 'react';
import {
  engineSettingsSchema,
  runtimeSettingsSchema,
  type LocalProfile,
  type LocalProfileInput,
  type RuntimeSnapshot,
  type EngineSettings,
  type ModelInspection,
} from '@lodex/contracts';
import {
  configureRuntime,
  nativeDesktop,
  pickRuntimeFile,
  runtimeAction,
  runtimeSnapshot,
  saveLocalProfile,
  startModelDownload,
  modelDownloadAction,
  inspectLocalModel,
} from './bridge';
import { Icon } from './icons';
import { EngineInstaller } from './EngineInstaller';

const blank = (): LocalProfileInput => ({
  name: '',
  enginePath: '',
  modelPath: '',
  settings: engineSettingsSchema.parse({}),
  vramReservationMb: 22528,
});
export function ModelManager({
  embedded = false,
  hasSession,
  running,
  onClose,
  onChoose,
}: {
  embedded?: boolean;
  hasSession: boolean;
  running: boolean;
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
    downloads: [],
    settings: runtimeSettingsSchema.parse({}),
    resources: {
      measuredAt: new Date(0).toISOString(),
      systemRamTotalMb: 0,
      systemRamUsedMb: 0,
      systemRamFreeMb: 0,
      gpuSource: 'unavailable',
      gpus: [],
    },
  });
  const [draft, setDraft] = useState(blank),
    [budget, setBudget] = useState(runtimeSettingsSchema.parse({}));
  const [trusted, setTrusted] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [extra, setExtra] = useState('[]');
  const [gpuText, setGpuText] = useState('auto');
  const [inspection, setInspection] = useState<ModelInspection | null>(null);
  const [download, setDownload] = useState({
    repository: '',
    file: '',
    revision: 'main',
    sha256: '',
  });
  const [loaded, setLoaded] = useState(!nativeDesktop);
  const [connectionError, setConnectionError] = useState('');
  const budgetConflict = loaded && budget.version !== state.settings.version;
  const savedProfile = state.profiles.find((profile) => profile.id === draft.id);
  const profileConflict = !!draft.id && savedProfile?.version !== draft.expectedVersion;
  const unavailable = !nativeDesktop || !loaded;
  const reservedVramMb = state.instances.reduce(
    (total, instance) => total + instance.reservedVramMb,
    0,
  );
  const usableVramMb = Math.max(0, state.settings.vramBudgetMb - state.settings.headroomMb);
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
    setInspection(null);
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
      ...(profile.ramReservationMb !== undefined
        ? { ramReservationMb: profile.ramReservationMb }
        : {}),
    });
    setGpuText(String(profile.settings.gpuLayers));
    setExtra(JSON.stringify(profile.settings.extraArgs, null, 2));
    setInspection(null);
    setTrusted(false);
    setError('');
  }
  function settings<K extends keyof EngineSettings>(key: K, value: EngineSettings[K]) {
    setDraft({ ...draft, settings: { ...draft.settings, [key]: value } });
  }
  function applyInspection(value: ModelInspection) {
    setInspection(value);
    setDraft((current) => ({
      ...current,
      name: current.name || value.modelName || '',
      modelPath: value.modelPath,
      settings: value.recommendedSettings,
      vramReservationMb: value.recommendedVramReservationMb,
      ramReservationMb: undefined,
    }));
    setGpuText(String(value.recommendedSettings.gpuLayers));
    setExtra(JSON.stringify(value.recommendedSettings.extraArgs, null, 2));
    setTrusted(false);
  }
  return (
    <SettingsSurface
      embedded={embedded}
      className="settings-dialog model-manager"
      ref={dialog}
      onCancel={onClose}
      aria-labelledby="model-manager-title"
      aria-busy={busy}
    >
      <div className="dialog-header">
        <h2 id="model-manager-title">{localize('로컬 모델')}</h2>
        <button className="icon-button" aria-label={localize('모델 관리 닫기')} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="settings-body">
        {!nativeDesktop && (
          <p className="demo-notice">
            {localize('모델 파일 등록과 로딩은 데스크톱 앱에서 사용할 수 있습니다.')}
          </p>
        )}
        {!loaded && <p role="status">{localize('모델 설정을 불러오는 중…')}</p>}
        {connectionError && (
          <p role="alert" className="form-error">
            {connectionError}
          </p>
        )}
        <EngineInstaller
          state={state.engines}
          disabled={unavailable || busy}
          onSnapshot={(next) => {
            if (mounted.current) setState(next);
          }}
          onChoose={(engine) => {
            setDraft((current) => ({ ...current, enginePath: engine.enginePath }));
            setTrusted(false);
          }}
        />
        <section className="runtime-budget">
          <h3>{localize('메모리 예약')}</h3>
          <p>
            {localize(
              '모델 로딩 전에 예약 예산과 실제 여유 RAM·VRAM을 함께 검사합니다. 예약량은 추정값이며 실행 중의 메모리 사용량을 강제로 제한하지는 않습니다.',
            )}
          </p>
          <fieldset disabled={busy || !loaded}>
            <div className="settings-grid">
              <label className="field">
                {localize('VRAM 전체 예산 MiB')}
                <input
                  type="number"
                  min={0}
                  max={1048576}
                  value={budget.vramBudgetMb}
                  onChange={(e) => setBudget({ ...budget, vramBudgetMb: Number(e.target.value) })}
                />
              </label>
              <label className="field">
                {localize('남겨 둘 VRAM MiB')}
                <input
                  type="number"
                  min={0}
                  max={65536}
                  value={budget.headroomMb}
                  onChange={(e) => setBudget({ ...budget, headroomMb: Number(e.target.value) })}
                />
              </label>
            </div>
            <div className="settings-grid">
              <label className="field">
                {localize('CUDA 엔진에서 사용할 NVIDIA GPU 번호')}
                <input
                  type="number"
                  min={0}
                  max={255}
                  value={budget.gpuIndex}
                  onChange={(e) => setBudget({ ...budget, gpuIndex: Number(e.target.value) })}
                />
                <small>
                  {localize('아래 자원 목록의 번호입니다. 로드된 모델을 언로드한 뒤 변경하세요.')}
                </small>
              </label>
              <label className="field">
                {localize('RAM 전체 예산 MiB (0: 시스템 전체)')}
                <input
                  type="number"
                  min={0}
                  max={4194304}
                  value={budget.ramBudgetMb}
                  onChange={(e) => setBudget({ ...budget, ramBudgetMb: Number(e.target.value) })}
                />
              </label>
              <label className="field">
                {localize('남겨 둘 RAM MiB')}
                <input
                  type="number"
                  min={0}
                  max={1048576}
                  value={budget.ramHeadroomMb}
                  onChange={(e) => setBudget({ ...budget, ramHeadroomMb: Number(e.target.value) })}
                />
              </label>
            </div>
            <label className="check-field">
              <input
                type="checkbox"
                checked={budget.autoUnloadIdle}
                onChange={(e) => setBudget({ ...budget, autoUnloadIdle: e.target.checked })}
              />
              {localize('공간 부족 또는 유휴 시간 초과 시 사용하지 않는 모델 자동 언로드')}
            </label>
            <label className="field runtime-idle-field">
              {localize('유휴 모델 자동 언로드 (분)')}
              <input
                type="number"
                min={1}
                max={1440}
                disabled={!budget.autoUnloadIdle}
                value={budget.idleUnloadMinutes}
                onChange={(e) =>
                  setBudget({ ...budget, idleUnloadMinutes: Number(e.target.value) })
                }
              />
              <small>{localize('활성 응답이 없는 관리형 모델에만 적용됩니다.')}</small>
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
              {localize('메모리 설정 저장')}
            </button>
            {budgetConflict && (
              <div role="status">
                <p>
                  {localize(
                    '다른 창에서 VRAM 설정을 변경했습니다. 저장된 설정을 다시 불러온 뒤 편집하세요.',
                  )}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setBudget(state.settings);
                    setError('');
                  }}
                >
                  {localize('저장된 VRAM 설정 불러오기')}
                </button>
              </div>
            )}
          </fieldset>
        </section>
        <section className="runtime-resources" aria-labelledby="runtime-resources-title">
          <div className="resource-heading">
            <h3 id="runtime-resources-title">{localize('현재 자원')}</h3>
            <span>{loaded ? localize('2초 간격 측정') : localize('측정 대기')}</span>
          </div>
          <div className="resource-grid">
            <article>
              <span>{localize('앱 VRAM 예약')}</span>
              <strong>
                {(reservedVramMb / 1024).toFixed(1)} / {(usableVramMb / 1024).toFixed(1)} GiB
              </strong>
              <progress max={Math.max(1, usableVramMb)} value={reservedVramMb} />
              <small>{localize('로드된 관리형 모델의 예약 합계')}</small>
            </article>
            <article>
              <span>{localize('시스템 RAM')}</span>
              <strong>
                {(state.resources.systemRamUsedMb / 1024).toFixed(1)} /{' '}
                {(state.resources.systemRamTotalMb / 1024).toFixed(1)} GiB
              </strong>
              <progress
                max={Math.max(1, state.resources.systemRamTotalMb)}
                value={state.resources.systemRamUsedMb}
              />
              <small>
                {(state.resources.systemRamFreeMb / 1024).toFixed(1)}
                {localize(' GiB 사용 가능')}
              </small>
            </article>
            {state.resources.gpus.map((gpu) => (
              <article key={gpu.index}>
                <span>
                  GPU {gpu.index} · {gpu.name}
                </span>
                <strong>
                  {(gpu.usedVramMb / 1024).toFixed(1)} / {(gpu.totalVramMb / 1024).toFixed(1)} GiB
                </strong>
                <progress max={Math.max(1, gpu.totalVramMb)} value={gpu.usedVramMb} />
                <small>
                  VRAM {(gpu.freeVramMb / 1024).toFixed(1)}
                  {localize(' GiB 여유')}
                  {gpu.utilizationPercent === null ? '' : ` · GPU ${gpu.utilizationPercent}%`}
                </small>
              </article>
            ))}
          </div>
          {loaded && state.resources.gpuSource === 'unavailable' && (
            <p>
              {localize(
                '실제 GPU 사용량을 측정하지 못했습니다. GPU는 설정한 예약 예산만 검사하며 RAM은 실제 여유 공간을 검사합니다.',
              )}
            </p>
          )}
        </section>
        <section className="local-model-list" aria-label={localize('등록한 모델')}>
          <h3>{localize('Hugging Face에서 GGUF 받기')}</h3>
          <div className="settings-grid">
            <label className="field">
              {localize('저장소')}
              <input
                placeholder="bartowski/model-GGUF"
                value={download.repository}
                onChange={(event) => setDownload({ ...download, repository: event.target.value })}
              />
            </label>
            <label className="field">
              {localize('GGUF 파일')}
              <input
                placeholder="model-Q4_K_M.gguf"
                value={download.file}
                onChange={(event) => setDownload({ ...download, file: event.target.value })}
              />
            </label>
            <label className="field">
              Revision
              <input
                value={download.revision}
                onChange={(event) => setDownload({ ...download, revision: event.target.value })}
              />
            </label>
            <label className="field">
              {localize('SHA-256 (선택 · 분할 모델은 첫 파일)')}
              <input
                value={download.sha256}
                onChange={(event) => setDownload({ ...download, sha256: event.target.value })}
              />
            </label>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={unavailable || busy || !download.repository.trim() || !download.file.trim()}
            onClick={() =>
              void operation(async () => {
                const next = await startModelDownload({
                  repository: download.repository.trim(),
                  file: download.file.trim(),
                  revision: download.revision.trim() || 'main',
                  ...(download.sha256.trim()
                    ? { expectedSha256: download.sha256.trim().toLowerCase() }
                    : {}),
                });
                if (mounted.current) setState(next);
              })
            }
          >
            {localize('다운로드 시작')}
          </button>
          <p className="subtle-note">
            {localize(
              '분할 모델은 -00001-of-00002.gguf 형식의 파일 하나를 입력하면 같은 버전의 전체 묶음을 받습니다. 중지하거나 앱을 종료한 뒤에도 이어받을 수 있습니다.',
            )}
          </p>
          {state.downloads.map((item) => {
            const percent =
              item.totalBytes && item.totalBytes > 0
                ? Math.min(100, Math.round((item.downloadedBytes / item.totalBytes) * 100))
                : null;
            return (
              <article className="local-model" key={item.id}>
                <strong>{item.repository + ' / ' + item.file}</strong>
                <span>
                  {
                    {
                      downloading: localize('다운로드 중'),
                      completed: localize('완료'),
                      failed: localize('실패'),
                      cancelled: localize('중지됨'),
                    }[item.status]
                  }{' '}
                  · {(item.downloadedBytes / 1024 ** 3).toFixed(2)} GiB
                  {percent === null ? '' : ` · ${percent}%`}
                  {(item.parts?.length ?? 0) > 1 &&
                    localize(
                      ' · 분할 파일 {0}/{1} 완료',
                      item.parts!.filter((part) => part.sha256).length,
                      item.parts!.length,
                    )}
                </span>
                {item.status === 'downloading' && (
                  <progress
                    max={item.totalBytes ?? Math.max(1, item.downloadedBytes)}
                    value={item.downloadedBytes}
                  />
                )}
                {item.error && <p className="danger-text">{item.error}</p>}
                <div className="edit-actions">
                  {(item.status === 'failed' || item.status === 'cancelled') && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void operation(async () => {
                          const next = await modelDownloadAction(item.id, 'resume');
                          if (mounted.current) setState(next);
                        })
                      }
                    >
                      {localize('이어받기')}
                    </button>
                  )}
                  {item.status === 'completed' && item.modelPath && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void operation(async () => {
                          const value = await inspectLocalModel(item.modelPath!);
                          if (mounted.current) {
                            applyInspection(value);
                            setDraft((current) => ({
                              ...current,
                              name: current.name || item.file.replace(/\.gguf$/i, ''),
                            }));
                          }
                        }, false)
                      }
                    >
                      {localize('분석 후 등록 양식에 사용')}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void operation(async () => {
                        const next = await modelDownloadAction(
                          item.id,
                          item.status === 'downloading' ? 'cancel' : 'remove',
                        );
                        if (mounted.current) setState(next);
                      })
                    }
                  >
                    {item.status === 'downloading' ? localize('중지') : localize('목록·파일 제거')}
                  </button>
                </div>
              </article>
            );
          })}
        </section>
        <section className="local-model-list" aria-label={localize('등록한 모델')}>
          <h3>{localize('등록한 모델')}</h3>
          {loaded && !state.profiles.length && (
            <p>{localize('등록한 모델이 없습니다. 아래에서 엔진과 GGUF 파일을 선택하세요.')}</p>
          )}
          {state.profiles.map((profile) => {
            const instance = state.instances.find((i) => i.profileId === profile.id);
            return (
              <article className="local-model" key={profile.id}>
                <strong>{profile.name}</strong>
                <span>
                  {instance
                    ? {
                        loading: localize('로딩 중'),
                        ready: localize('준비됨'),
                        stopped: localize('언로드됨'),
                        failed: localize('실행 실패'),
                      }[instance.status]
                    : localize('언로드됨')}{' '}
                  · {(profile.modelBytes / 1024 ** 3).toFixed(2)}
                  {localize(' GiB · 설정 예약')} {profile.vramReservationMb} MiB
                  {(profile.modelFiles?.length ?? 0) > 1 &&
                    localize(' · 분할 {0}개', profile.modelFiles!.length)}
                  {profile.ramReservationMb !== undefined &&
                    localize(' · RAM 예약 {0} MiB', profile.ramReservationMb)}
                  {!!instance?.leases && localize(' · 사용 중 {0}개 대화', instance.leases)}
                </span>
                <div className="edit-actions">
                  <button
                    disabled={unavailable || busy || running || instance?.status === 'loading'}
                    onClick={() => void operation(() => onChoose(profile), false)}
                  >
                    {hasSession ? localize('이 대화에 적용') : localize('이 모델 사용')}
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
                    {localize('로드')}
                  </button>
                  <button
                    disabled={
                      unavailable ||
                      busy ||
                      !instance ||
                      !['ready', 'failed'].includes(instance.status) ||
                      instance.leases > 0
                    }
                    onClick={() =>
                      void operation(async () => {
                        await runtimeAction(profile.id, 'unload');
                      })
                    }
                  >
                    {localize('언로드')}
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
                    {localize('설정 편집')}
                  </button>
                  <button
                    className="danger-button"
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
                    {localize('목록에서 제거')}
                  </button>
                </div>
                {instance?.error && <p className="danger-text">{instance.error}</p>}
                {instance?.memoryWarning && <p className="subtle-note">{instance.memoryWarning}</p>}
                <details>
                  <summary>{localize('엔진 정보·로그')}</summary>
                  <p>{profile.engineVersion}</p>
                  <p>{profile.modelPath}</p>
                  {(profile.modelName || profile.modelArchitecture || profile.tokenizerModel) && (
                    <p>
                      {profile.modelName || localize('이름 정보 없음')}
                      {profile.modelArchitecture ? ` · ${profile.modelArchitecture}` : ''}
                      {profile.tokenizerModel ? ` · tokenizer ${profile.tokenizerModel}` : ''}
                    </p>
                  )}
                  <p>
                    {localize('모델 컨텍스트 ')}
                    {profile.nativeContextSize?.toLocaleString() ?? localize('메타데이터 없음')} ·
                    Chat template{' '}
                    {profile.settings.chatTemplate
                      ? localize('사용자 지정')
                      : profile.embeddedChatTemplate
                        ? localize('GGUF 내장')
                        : localize('llama.cpp 자동 판정')}
                    {' · '}Tool template{' '}
                    {profile.settings.chatTemplate
                      ? localize('사용자 지정에서 판정')
                      : profile.embeddedToolTemplate
                        ? localize('GGUF 내장')
                        : localize('별도 메타데이터 없음')}
                  </p>
                  <p>
                    GGUF v{profile.ggufVersion}
                    {localize(' 헤더 확인 · 전체 파일 무결성 검사는 아직 수행하지 않음')}
                  </p>
                  <pre>{instance?.log || localize('실행 로그 없음')}</pre>
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
                throw new Error(
                  localize('GPU layers에 auto, all 또는 0 이상의 정수를 입력하세요.'),
                );
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
            <h3>{draft.id ? localize('모델 설정 편집') : localize('모델 등록')}</h3>
            {profileConflict && (
              <div role="status">
                <p>
                  {savedProfile
                    ? localize('다른 창에서 모델 설정을 변경했습니다. 다시 불러온 뒤 편집하세요.')
                    : localize('이 모델은 목록에서 제거되었습니다. 새 모델로 등록할 수 있습니다.')}
                </p>
                {savedProfile ? (
                  <button type="button" onClick={() => editProfile(savedProfile)}>
                    {localize('저장된 모델 설정 불러오기')}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(({ id: _id, expectedVersion: _version, ...value }) => value);
                      setTrusted(false);
                    }}
                  >
                    {localize('새 모델로 전환')}
                  </button>
                )}
              </div>
            )}
            <label className="field">
              {localize('이름')}
              <input
                required
                maxLength={200}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            {(['enginePath', 'modelPath'] as const).map((key) => (
              <label className="field" key={key}>
                {key === 'enginePath'
                  ? localize('llama-server 실행 파일')
                  : localize('GGUF 모델 파일')}
                <div className="input-action">
                  <input
                    required
                    value={draft[key]}
                    onChange={(e) => {
                      setDraft({ ...draft, [key]: e.target.value });
                      if (key === 'modelPath') setInspection(null);
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
                          if (key === 'modelPath') applyInspection(await inspectLocalModel(path));
                          else {
                            setDraft((current) => ({ ...current, [key]: path }));
                            setTrusted(false);
                          }
                        }
                      }, false)
                    }
                  >
                    {localize('파일 선택')}
                  </button>
                </div>
              </label>
            ))}
            <div className="edit-actions">
              <button
                type="button"
                disabled={unavailable || busy || !draft.modelPath.trim()}
                onClick={() =>
                  void operation(async () => {
                    const value = await inspectLocalModel(draft.modelPath.trim());
                    if (mounted.current) applyInspection(value);
                  }, false)
                }
              >
                {localize('GGUF 분석·권장값 적용')}
              </button>
            </div>
            {inspection && (
              <p role="status">
                {inspection.modelName || localize('이름 정보 없음')}
                {inspection.modelArchitecture ? ` · ${inspection.modelArchitecture}` : ''}
                {inspection.layerCount ? ` · ${inspection.layerCount} layers` : ''}
                {localize(' · 권장 컨텍스트')}{' '}
                {inspection.recommendedSettings.contextSize.toLocaleString()}
                {localize(' · 예상 KV cache')}{' '}
                {inspection.estimatedKvCacheMb === null
                  ? localize('메타데이터 부족')
                  : `${inspection.estimatedKvCacheMb.toLocaleString()} MiB`}
                {' · '}Tool template{' '}
                {inspection.embeddedToolTemplate
                  ? localize('GGUF 내장')
                  : localize('별도 메타데이터 없음')}
                <br />
                <small>{inspection.recommendation}</small>
              </p>
            )}
            <div className="settings-grid">
              {(
                [
                  ['contextSize', localize('컨텍스트 길이'), 1024, 2097152],
                  ['threads', localize('생성 스레드'), 1, 1024],
                  ['batchThreads', localize('프리필 스레드'), 1, 1024],
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
                <small>{localize('auto, all 또는 0 이상의 정수')}</small>
              </label>
              <label className="field">
                {localize('VRAM 예약 MiB')}
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
                {localize('RAM 예약 MiB (비워 두면 자동 계산)')}
                <input
                  type="number"
                  min={0}
                  max={4194304}
                  value={draft.ramReservationMb ?? ''}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      ramReservationMb: e.target.value === '' ? undefined : Number(e.target.value),
                    })
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
              <summary>{localize('고급 설정')}</summary>
              <label className="field">
                Chat template
                <textarea
                  rows={4}
                  value={draft.settings.chatTemplate}
                  onChange={(e) => settings('chatTemplate', e.target.value)}
                  placeholder={localize('비워 두면 GGUF의 템플릿 사용')}
                />
              </label>
              <label className="field">
                {localize('추가 엔진 인자 (JSON 배열)')}
                <textarea
                  rows={4}
                  value={extra}
                  onChange={(e) => setExtra(e.target.value)}
                  placeholder={'["--seed", "42"]'}
                />
              </label>
              <p>
                {localize(
                  '설치한 엔진의 옵션 목록을 검사합니다. 모델 경로·네트워크·인증과 위 관리 설정은 추가 인자로 덮어쓸 수 없습니다.',
                )}
              </p>
            </details>
            <label className="check-field">
              <input
                type="checkbox"
                checked={trusted}
                onChange={(e) => setTrusted(e.target.checked)}
              />
              {localize('선택한 엔진 실행 파일을 신뢰하며 정보 조회와 모델 로딩에 사용')}
            </label>
            <div className="edit-actions">
              <button
                className="primary-button"
                disabled={unavailable || busy || !trusted || profileConflict}
              >
                {busy ? localize('처리 중…') : localize('엔진 확인·모델 저장')}
              </button>
              {draft.id && (
                <button type="button" onClick={resetDraft}>
                  {localize('새 모델 입력')}
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
    </SettingsSurface>
  );
}
