import { createHash } from 'node:crypto';
import {
  AppError,
  engineAssetSchema,
  type EngineAsset,
  type EngineCatalog,
  type EngineVariant,
} from '@lodex/contracts';

const api = 'https://api.github.com/repos/ggml-org/llama.cpp';
const tagPattern = /^[A-Za-z0-9._-]{1,80}$/;
interface Release {
  tag_name: string;
  html_url: string;
  published_at: string;
  prerelease: boolean;
  assets: unknown[];
}
export async function readBoundedResponse(
  response: Response,
  maximum: number,
  signal: AbortSignal,
) {
  if (!response.body) throw new AppError('ENGINE_RESPONSE', '서버 응답이 비어 있습니다.');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximum)
        throw new AppError('ENGINE_RESPONSE_SIZE', '공식 릴리스 응답이 허용 범위를 초과합니다.');
      chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}
export function officialAssetUrl(url: string, tag: string, name: string) {
  return (
    url ===
    `https://github.com/ggml-org/llama.cpp/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
  );
}
export function allowedAssetResponse(response: Response, original: string) {
  const url = new URL(response.url || original);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    ![
      'github.com',
      'release-assets.githubusercontent.com',
      'objects.githubusercontent.com',
      'github-releases.githubusercontent.com',
    ].includes(url.hostname)
  )
    throw new AppError('ENGINE_SOURCE', '공식 GitHub 다운로드 주소가 아닌 곳으로 이동했습니다.');
}
function release(value: unknown): Release {
  if (!value || typeof value !== 'object')
    throw new AppError('ENGINE_RELEASE', '릴리스 정보가 올바르지 않습니다.');
  const record = value as Record<string, unknown>;
  if (
    typeof record.tag_name !== 'string' ||
    !tagPattern.test(record.tag_name) ||
    record.draft ||
    !Array.isArray(record.assets) ||
    record.assets.length > 200 ||
    record.html_url !== `https://github.com/ggml-org/llama.cpp/releases/tag/${record.tag_name}` ||
    typeof record.published_at !== 'string' ||
    !Number.isFinite(Date.parse(record.published_at))
  )
    throw new AppError('ENGINE_RELEASE', '공식 릴리스 정보를 확인할 수 없습니다.');
  return record as unknown as Release;
}
function assetsOf(value: Release): EngineAsset[] {
  return value.assets.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const asset = item as Record<string, unknown>;
    const parsed = engineAssetSchema.safeParse({
      id: asset.id,
      name: asset.name,
      size: asset.size,
      sha256:
        typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(asset.digest)
          ? asset.digest.slice(7)
          : null,
      url: asset.browser_download_url,
    });
    return parsed.success && officialAssetUrl(parsed.data.url, value.tag_name, parsed.data.name)
      ? [parsed.data]
      : [];
  });
}
export function parseEngineRelease(
  value: unknown,
  channel: EngineCatalog['channel'] = 'stable',
): EngineCatalog {
  const data = release(value),
    assets = assetsOf(data),
    variants: EngineVariant[] = [];
  for (const asset of assets) {
    const prefix = `llama-${data.tag_name}-bin-`;
    if (!asset.name.startsWith(prefix)) continue;
    const match =
      /^(win|ubuntu|macos)-(?:((?:cpu|vulkan)|cuda-\d+\.\d+)-)?(x64|arm64)\.(zip|tar\.gz)$/.exec(
        asset.name.slice(prefix.length),
      );
    if (!match) continue;
    const platform = match[1] === 'win' ? 'win32' : match[1] === 'macos' ? 'darwin' : 'linux';
    if ((platform === 'win32') !== (match[4] === 'zip')) continue;
    const architecture = match[3] as 'x64' | 'arm64';
    const backend = match[2]?.startsWith('cuda-')
      ? 'cuda'
      : match[2] === 'vulkan'
        ? 'vulkan'
        : platform === 'darwin'
          ? 'metal'
          : 'cpu';
    const backendVersion = backend === 'cuda' ? match[2]!.slice(5) : undefined;
    const dependencies =
      backend === 'cuda'
        ? assets.filter(
            (candidate) =>
              candidate.name.startsWith('cudart-llama-') &&
              candidate.name.endsWith(
                `-bin-${match[1]}-cuda-${backendVersion}-${architecture}.${match[4]}`,
              ),
          )
        : [];
    const unavailableReason = !asset.sha256
      ? '공식 SHA-256이 없어 자동 설치할 수 없습니다.'
      : backend === 'cuda' && (dependencies.length !== 1 || !dependencies[0]?.sha256)
        ? '같은 버전의 검증 가능한 CUDA 런타임 파일이 없습니다.'
        : undefined;
    variants.push({
      ...asset,
      platform,
      architecture,
      backend,
      ...(backendVersion ? { backendVersion } : {}),
      dependencies,
      ...(unavailableReason ? { unavailableReason } : {}),
    });
  }
  return {
    channel,
    releaseTag: data.tag_name,
    releaseUrl: data.html_url,
    publishedAt: data.published_at,
    prerelease: !!data.prerelease,
    variants,
  };
}
export class EngineReleases {
  constructor(private fetcher: typeof fetch = fetch) {}
  private async request(path: string, signal: AbortSignal) {
    const response = await this.fetcher(api + path, {
      redirect: 'error',
      signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Lodex/0.1',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        'ENGINE_RELEASE_HTTP',
        `공식 엔진 목록 조회 실패 (HTTP ${response.status}). 잠시 후 조회 버튼으로 다시 시도하세요.`,
      );
    }
    return JSON.parse(
      (await readBoundedResponse(response, 4_194_304, signal)).toString('utf8'),
    ) as unknown;
  }
  async byTag(tag: string, signal: AbortSignal) {
    if (!tagPattern.test(tag))
      throw new AppError('ENGINE_RELEASE', '올바르지 않은 릴리스 이름입니다.');
    return parseEngineRelease(
      await this.request(`/releases/tags/${encodeURIComponent(tag)}`, signal),
    );
  }
  async catalog(channel: EngineCatalog['channel'], signal: AbortSignal): Promise<EngineCatalog> {
    if (channel === 'nightly') {
      const data = await this.request('/releases?per_page=10', signal);
      if (!Array.isArray(data))
        throw new AppError('ENGINE_RELEASE', '릴리스 목록이 올바르지 않습니다.');
      for (const item of data) {
        const candidate = parseEngineRelease(item, channel);
        if (candidate.variants.length) return candidate;
      }
      throw new AppError('ENGINE_RELEASE', '바이너리 게시가 완료된 최근 릴리스를 찾지 못했습니다.');
    }
    const latest = await this.request('/releases/latest', signal);
    const catalog = parseEngineRelease(latest, channel);
    if (catalog.variants.length) return catalog;
    const pointer = assetsOf(release(latest)).find((asset) => asset.name === 'nightly-tag.txt');
    if (!pointer?.sha256 || pointer.size > 128)
      throw new AppError(
        'ENGINE_RELEASE',
        '안정판의 검증 가능한 바이너리 참조가 없습니다. Nightly 채널을 확인하세요.',
      );
    const response = await this.fetcher(pointer.url, { signal, redirect: 'follow' });
    allowedAssetResponse(response, pointer.url);
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError('ENGINE_RELEASE_HTTP', '안정판의 빌드 참조를 내려받지 못했습니다.');
    }
    const content = await readBoundedResponse(response, 128, signal);
    if (createHash('sha256').update(content).digest('hex') !== pointer.sha256)
      throw new AppError('ENGINE_DIGEST', '안정판 참조 파일의 SHA-256이 일치하지 않습니다.');
    const tag = content.toString('utf8').trim();
    return { ...(await this.byTag(tag, signal)), channel };
  }
}
