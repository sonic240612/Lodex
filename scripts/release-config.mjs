import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function releaseConfig({
  version,
  desktopVersion,
  rustVersion,
  requestedVersion,
  signed,
  draft,
  publicKey,
  privateKey,
  repository,
  platform,
  certificateThumbprint,
}) {
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requestedVersion ?? '') ||
    ![version, desktopVersion, rustVersion].every((value) => value === requestedVersion)
  )
    throw new Error('Release version must match package.json, Cargo.toml and tauri.conf.json.');
  if (draft && !signed) throw new Error('Draft releases require signed update artifacts.');
  if (signed && (!publicKey?.trim() || !privateKey?.trim()))
    throw new Error(
      'Set LODEX_UPDATER_PUBLIC_KEY and TAURI_SIGNING_PRIVATE_KEY before building signed updates.',
    );
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('Invalid release repository.');
  if (!['win32', 'darwin', 'linux'].includes(platform))
    throw new Error('Unsupported release platform.');
  if (certificateThumbprint && !/^[A-Fa-f0-9]{40}$/.test(certificateThumbprint))
    throw new Error('Invalid Windows signing certificate thumbprint.');
  return {
    bundle: {
      targets:
        platform === 'win32'
          ? ['nsis']
          : platform === 'darwin'
            ? ['app', 'dmg']
            : ['deb', 'appimage'],
      createUpdaterArtifacts: signed,
      ...(platform === 'win32' && certificateThumbprint
        ? {
            windows: {
              certificateThumbprint,
              digestAlgorithm: 'sha256',
              timestampUrl: 'http://timestamp.digicert.com',
            },
          }
        : {}),
    },
    plugins: {
      updater: {
        pubkey: signed ? publicKey.trim() : '',
        endpoints: signed
          ? [`https://github.com/${repository}/releases/latest/download/latest.json`]
          : [],
        windows: { installMode: 'passive' },
      },
    },
  };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const desktop = JSON.parse(await readFile('apps/desktop/src-tauri/tauri.conf.json', 'utf8'));
  const cargo = await readFile('apps/desktop/src-tauri/Cargo.toml', 'utf8');
  const config = releaseConfig({
    version: pkg.version,
    desktopVersion: desktop.version,
    rustVersion: /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1],
    requestedVersion: process.env.LODEX_RELEASE_VERSION,
    signed: process.env.LODEX_SIGN_UPDATES === 'true',
    draft: process.env.LODEX_DRAFT_RELEASE === 'true',
    publicKey: process.env.LODEX_UPDATER_PUBLIC_KEY,
    privateKey: process.env.TAURI_SIGNING_PRIVATE_KEY,
    repository: process.env.GITHUB_REPOSITORY ?? 'sonic240612/Lodex',
    platform: process.platform,
    certificateThumbprint: process.env.LODEX_CERTIFICATE_THUMBPRINT,
  });
  await mkdir('.local/release', { recursive: true });
  await writeFile('.local/release/tauri.release.json', JSON.stringify(config, null, 2));
  console.log(
    `Release configuration ready (${process.platform}, updates ${config.bundle.createUpdaterArtifacts ? 'signed' : 'disabled'}).`,
  );
}
