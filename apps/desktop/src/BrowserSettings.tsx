import { t as localize } from './i18n';
import { useEffect, useState } from 'react';
import type { BrowserSettings as Settings } from '@lodex/contracts';
import { browserSettings, saveBrowserSettings } from './bridge';
import { SettingsSurface } from './SettingsSurface';
export function BrowserSettings() {
  const [value, setValue] = useState<Settings>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void browserSettings()
      .then(setValue)
      .catch((error: Error) => setMessage(error.message));
  }, []);
  async function save() {
    if (!value) return;
    setBusy(true);
    setMessage('');
    try {
      setValue(await saveBrowserSettings(value));
      setMessage(localize('저장했습니다.'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : localize('설정을 저장하지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsSurface embedded className="settings-form" aria-busy={busy}>
      <h3>{localize('브라우저 도구')}</h3>
      <p>
        {localize(
          '전체 접근으로 실행할 때 별도의 브라우저에서 페이지를 열고, 버튼·입력칸을 조작하며 화면을 확인합니다. 실행이 끝나면 브라우저와 임시 로그인 정보가 지워집니다.',
        )}
      </p>
      <p>
        {localize(
          '이 PC에 설치된 Chrome 또는 Edge를 사용합니다. 개인 브라우저의 로그인·쿠키는 가져오지 않습니다. Plan에서는 브라우저 조작을 제공하지 않습니다.',
        )}
      </p>
      {value && (
        <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={value.config.enabled}
              onChange={(event) =>
                setValue({ ...value, config: { ...value.config, enabled: event.target.checked } })
              }
            />
            {localize('브라우저 도구 사용')}
          </label>
          <label>
            {localize('브라우저')}
            <select
              value={value.config.channel}
              onChange={(event) =>
                setValue({
                  ...value,
                  config: { ...value.config, channel: event.target.value as 'chrome' | 'msedge' },
                })
              }
            >
              <option value="msedge">Microsoft Edge</option>
              <option value="chrome">Google Chrome</option>
            </select>
          </label>
          <button className="secondary-button" onClick={() => void save()}>
            {localize('설정 저장')}
          </button>
        </fieldset>
      )}
      {message && <p role="status">{message}</p>}
    </SettingsSurface>
  );
}
