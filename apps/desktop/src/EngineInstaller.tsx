import { t as localize } from './i18n';
import { useEffect, useRef, useState } from 'react';
import type {
  EngineCatalog,
  EngineManagerSnapshot,
  EngineVariant,
  ManagedEngine,
  RuntimeSnapshot,
} from '@lodex/contracts';
import { engineCatalog, engineManagerAction, installEngine } from './bridge';

export function engineVariantLabel(asset: EngineVariant) {
  const os = { win32: 'Windows', darwin: 'macOS', linux: 'Linux (Ubuntu)' }[asset.platform];
  return `${os} · ${asset.architecture} · ${asset.backend === 'metal' ? 'Metal / CPU' : asset.backend.toUpperCase()}${asset.backendVersion ? ' ' + asset.backendVersion : ''}`;
}
export function EngineInstaller({
  state,
  disabled,
  onSnapshot,
  onChoose,
}: {
  state: EngineManagerSnapshot | undefined;
  disabled: boolean;
  onSnapshot: (snapshot: RuntimeSnapshot) => void;
  onChoose: (engine: ManagedEngine) => void;
}) {
  const mounted = useRef(true);
  const [channel, setChannel] = useState<'stable' | 'nightly'>('stable');
  const [catalog, setCatalog] = useState<EngineCatalog | null>(null);
  const [selected, setSelected] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const selection = catalog?.variants.find((variant) => variant.id === selected);
  const compatible = (variant: EngineVariant) =>
    variant.platform === state?.platform && variant.architecture === state?.architecture;
  const active = state?.installations.some((job) =>
    ['downloading', 'extracting'].includes(job.status),
  );
  const installed =
    selection &&
    state?.installed.some(
      (engine) =>
        engine.assets[0]?.id === selection.id && engine.assets[0].sha256 === selection.sha256,
    );
  async function operation(work: () => Promise<void>) {
    if (busy || disabled) return;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className="local-model-list" aria-label={localize('llama.cpp 엔진 관리')}>
      <h3>{localize('llama.cpp 엔진')}</h3>
      <p className="subtle-note">
        {localize(
          '공식 배포 파일과 SHA-256을 확인해 버전별로 설치합니다. 설치한 엔진을 등록 양식에서 선택한 뒤 모델 설정을 저장하세요. 관리형 설치는 llama.cpp만 지원하며 Ollama·vLLM·MLX는 모델 연결에서 외부 서버로 연결합니다.',
        )}
      </p>
      <div className="input-action">
        <select
          aria-label={localize('엔진 릴리스 채널')}
          disabled={busy || disabled}
          value={channel}
          onChange={(event) => {
            setChannel(event.target.value as 'stable' | 'nightly');
            setCatalog(null);
            setSelected(0);
          }}
        >
          <option value="stable">{localize('안정판 채널')}</option>
          <option value="nightly">{localize('Nightly 최신 빌드')}</option>
        </select>
        <button
          type="button"
          className="secondary-button"
          disabled={busy || disabled}
          onClick={() =>
            void operation(async () => {
              setCatalog(null);
              const next = await engineCatalog(channel);
              if (mounted.current) {
                setCatalog(next);
                setSelected(
                  next.variants.find((asset) => compatible(asset) && !asset.unavailableReason)
                    ?.id ?? 0,
                );
              }
            })
          }
        >
          {busy ? localize('처리 중…') : localize('공식 릴리스 조회')}
        </button>
      </div>
      {catalog && (
        <>
          <p>
            <a href={catalog.releaseUrl} target="_blank" rel="noreferrer">
              {catalog.releaseTag}
            </a>{' '}
            · {new Date(catalog.publishedAt).toLocaleDateString()}
            {catalog.prerelease ? localize(' · Nightly 빌드') : ''}
          </p>
          <label className="field">
            {localize('운영체제·GPU 엔진')}
            <select
              value={selected}
              disabled={disabled || busy}
              onChange={(event) => setSelected(Number(event.target.value))}
            >
              <option value={0}>{localize('설치할 엔진 선택')}</option>
              {catalog.variants.map((asset) => (
                <option
                  key={asset.id}
                  value={asset.id}
                  disabled={!compatible(asset) || !!asset.unavailableReason}
                >
                  {engineVariantLabel(asset)}
                  {!compatible(asset)
                    ? localize(' · 다른 운영체제/CPU')
                    : asset.unavailableReason
                      ? localize(' · 자동 설치 불가')
                      : ''}
                </option>
              ))}
            </select>
          </label>
          {!catalog.variants.some((asset) => compatible(asset) && !asset.unavailableReason) && (
            <p role="status">
              {localize(
                '현재 환경에 맞는 검증 가능한 공식 파일이 없습니다. 아래 등록 양식에서 직접 준비한 엔진 파일을 선택하세요.',
              )}
            </p>
          )}
          {catalog.variants
            .filter((asset) => compatible(asset) && asset.unavailableReason)
            .map((asset) => (
              <p className="subtle-note" key={asset.id}>
                {engineVariantLabel(asset)}: {asset.unavailableReason}
              </p>
            ))}
          {selection && (
            <p className="subtle-note">
              {selection.name} ·{' '}
              {(
                (selection.size +
                  selection.dependencies.reduce((sum, item) => sum + item.size, 0)) /
                1024 ** 2
              ).toFixed(0)}{' '}
              MiB
              {selection.backend === 'cuda' &&
                localize(' · CUDA 런타임 포함. 호환 NVIDIA 드라이버가 필요합니다.')}
              {selection.backend === 'vulkan' && localize(' · Vulkan 드라이버가 필요합니다.')}
              {selection.platform === 'linux' &&
                localize(' · Ubuntu 기반 바이너리로 배포판의 시스템 라이브러리가 필요합니다.')}
            </p>
          )}
          <button
            type="button"
            className="secondary-button"
            disabled={
              disabled ||
              busy ||
              active ||
              !selection ||
              !compatible(selection) ||
              !!selection.unavailableReason ||
              !!installed
            }
            onClick={() =>
              void operation(async () => {
                const next = await installEngine({
                  releaseTag: catalog.releaseTag,
                  assetId: selected,
                });
                if (mounted.current) onSnapshot(next);
              })
            }
          >
            {installed ? localize('설치된 버전') : localize('선택한 버전 설치')}
          </button>
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {state?.installations.slice(-5).map((job) => (
        <article className="local-model" key={job.id}>
          <strong>
            {job.releaseTag} · {job.assetName}
          </strong>
          <span>
            {
              {
                downloading: localize('다운로드 중'),
                extracting: localize('검증·압축 해제 중'),
                completed: localize('설치 완료'),
                cancelled: localize('설치 취소'),
                failed: localize('설치 실패'),
              }[job.status]
            }{' '}
            · {(job.downloadedBytes / 1024 ** 2).toFixed(0)} /{' '}
            {(job.totalBytes / 1024 ** 2).toFixed(0)} MiB
          </span>
          {['downloading', 'extracting'].includes(job.status) && (
            <>
              <progress max={job.totalBytes} value={job.downloadedBytes} />
              <button
                type="button"
                className="secondary-button"
                disabled={disabled || busy}
                onClick={() =>
                  void operation(async () => {
                    const next = await engineManagerAction(job.id, 'cancel');
                    if (mounted.current) onSnapshot(next);
                  })
                }
              >
                {localize('설치 취소')}
              </button>
            </>
          )}
          {job.error && <p className="danger-text">{job.error}</p>}
        </article>
      ))}
      {state?.installed.map((engine) => (
        <article className="local-model" key={engine.id}>
          <strong>
            {engine.releaseTag} · {engine.backend.toUpperCase()} · {engine.architecture}
          </strong>
          <span>{engine.enginePath}</span>
          {!!engine.referencedBy.length && (
            <small>
              {localize('사용 중인 프로필: ')}
              {engine.referencedBy.join(', ')}
              {engine.running ? localize(' · 실행 중') : ''}
            </small>
          )}
          <div className="edit-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={disabled || busy}
              onClick={() => onChoose(engine)}
            >
              {localize('등록 양식에서 선택')}
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={disabled || busy || engine.running || !!engine.referencedBy.length}
              onClick={() =>
                void operation(async () => {
                  const next = await engineManagerAction(engine.id, 'remove');
                  if (mounted.current) onSnapshot(next);
                })
              }
            >
              {localize('이 버전 제거')}
            </button>
          </div>
          <details>
            <summary>{localize('출처·검증 정보')}</summary>
            <a href={engine.releaseUrl} target="_blank" rel="noreferrer">
              {localize('공식 릴리스')}
            </a>
            {engine.assets.map((asset) => (
              <p key={asset.id}>
                {asset.name}
                <br />
                <code>SHA-256 {asset.sha256}</code>
              </p>
            ))}
          </details>
        </article>
      ))}
    </section>
  );
}
