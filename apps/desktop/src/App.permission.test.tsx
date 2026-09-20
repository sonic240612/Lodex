import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FullAccessDialog } from './App';

describe('full access warning', () => {
  it('lists host, secret, cloud and remote execution consequences', () => {
    const html = renderToStaticMarkup(<FullAccessDialog onClose={vi.fn()} onConfirm={vi.fn()} />);
    expect(html).toContain('프로젝트 밖의 파일');
    expect(html).toContain('호스트 명령과 네트워크');
    expect(html).toContain('.env, SSH 키, 인증 파일');
    expect(html).toContain('OpenRouter');
    expect(html).toContain('Telegram');
    expect(html).toContain('전체 접근 사용');
  });
});
