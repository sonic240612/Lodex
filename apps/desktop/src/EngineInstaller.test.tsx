import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { EngineInstaller, engineVariantLabel } from './EngineInstaller';

it('shows explicit install discovery, source verification and protected installed versions', () => {
  const html = renderToStaticMarkup(
    <EngineInstaller
      disabled={false}
      onSnapshot={vi.fn()}
      onChoose={vi.fn()}
      state={{
        platform: 'win32',
        architecture: 'x64',
        installations: [],
        installed: [
          {
            id: crypto.randomUUID(),
            releaseTag: 'b123',
            releaseUrl: 'https://github.com/ggml-org/llama.cpp/releases/tag/b123',
            prerelease: true,
            platform: 'win32',
            architecture: 'x64',
            backend: 'cpu',
            installedAt: '2026-10-01T00:00:00.000Z',
            engineRelativePath: 'llama-server.exe',
            enginePath: 'C:/engine/llama-server.exe',
            referencedBy: ['Current model'],
            running: true,
            assets: [
              {
                id: 1,
                name: 'engine.zip',
                size: 1,
                sha256: 'a'.repeat(64),
                url: 'https://github.com/ggml-org/llama.cpp/releases/download/b123/engine.zip',
              },
            ],
          },
        ],
      }}
    />,
  );
  expect(html).toContain('공식 릴리스 조회');
  expect(html).toContain('등록 양식에서 선택');
  expect(html).toContain('SHA-256');
  expect(html).toMatch(/disabled=""[^>]*>이 버전 제거/);
  expect(html).toContain('Current model');
});
it('labels Metal, CPU and CUDA versions without guessing from the host', () => {
  const asset = {
    id: 1,
    name: 'asset',
    size: 1,
    sha256: null,
    url: 'https://example.test/asset',
    dependencies: [],
    architecture: 'arm64' as const,
  };
  expect(engineVariantLabel({ ...asset, platform: 'darwin', backend: 'metal' })).toBe(
    'macOS · arm64 · Metal / CPU',
  );
  expect(
    engineVariantLabel({ ...asset, platform: 'win32', backend: 'cuda', backendVersion: '13.4' }),
  ).toContain('CUDA 13.4');
});
