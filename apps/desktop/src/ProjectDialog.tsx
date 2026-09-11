import { useEffect, useRef, useState } from 'react';
import type { Project } from '@lodex/contracts';
import { nativeDesktop, pickProjectFolder, registerProject } from './bridge';
import { Icon } from './icons';
export function ProjectDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (project: Project) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function pick() {
    setBusy(true);
    setError('');
    try {
      const selected = await pickProjectFolder();
      if (selected) setPath(selected);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog className="settings-dialog project-dialog" ref={dialog} onCancel={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          void registerProject(path)
            .then(onAdded)
            .catch((error: unknown) => setError(String(error)))
            .finally(() => setBusy(false));
        }}
      >
        <div className="dialog-header">
          <h2>프로젝트 추가</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="프로젝트 창 닫기"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="settings-body">
          <label className="field">
            로컬 프로젝트 폴더
            <div className="input-action">
              <input
                value={path}
                disabled={!nativeDesktop || busy}
                onChange={(e) => setPath(e.target.value)}
                placeholder="프로젝트 폴더의 전체 경로"
              />
              <button
                type="button"
                disabled={!nativeDesktop || busy}
                onClick={() => {
                  void pick();
                }}
              >
                폴더 선택
              </button>
            </div>
          </label>
          <p className="subtle-note">
            폴더를 복사하거나 업로드하지 않고 연결합니다. 프로젝트별 대화를 만들고 모델이 파일
            목록·읽기·검색 도구로 내용을 살펴볼 수 있습니다. 파일 수정과 명령 실행은 다음
            단계입니다.
          </p>
          {!nativeDesktop && (
            <p className="demo-notice">로컬 폴더 연결은 데스크톱 앱에서 사용할 수 있습니다.</p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <span>OpenRouter 파일 전송은 별도 설정이 필요합니다.</span>
          <button className="primary-button" disabled={!nativeDesktop || busy || !path.trim()}>
            {busy ? '연결 중…' : '프로젝트 추가'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
