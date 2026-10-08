import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

await mkdir('.local/release', { recursive: true });
if (process.argv.includes('--checksums')) {
  const root = resolve('apps/desktop/src-tauri/target/release/bundle');
  const records = [];
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (entry.isFile() && /\.(exe|msi|dmg|deb|AppImage|tar\.gz|sig)$/.test(entry.name)) {
        const hash = createHash('sha256')
          .update(await readFile(path))
          .digest('hex');
        records.push(`${hash}  ${relative(root, path).replaceAll('\\', '/')}`);
      }
    }
  }
  await scan(root);
  if (!records.length) throw new Error('No release packages found.');
  await writeFile('.local/release/SHA256SUMS', records.sort().join('\n') + '\n');
  console.log(`Checksummed ${records.length} release artifacts.`);
} else {
  const licenses = [];
  async function licenseFiles(folder, label) {
    const copied = [];
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (!entry.isFile() || !/^(license|licence|copying|notice)([-.].*)?$/i.test(entry.name))
        continue;
      const path = join(folder, entry.name);
      if ((await stat(path)).size > 2 * 1024 * 1024) throw new Error(`Oversized license: ${label}`);
      const text = await readFile(path, 'utf8');
      if (text.includes('\0')) continue;
      licenses.push(`\n===== ${label} / ${entry.name} =====\n${text}\n`);
      copied.push(entry.name);
    }
    return copied;
  }
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const npm = [];
  for (const [path, dependency] of Object.entries(lock.packages)) {
    if (!path.includes('node_modules/') || dependency.link) continue;
    try {
      const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
      const label = `${pkg.name}@${pkg.version}`;
      npm.push({
        name: pkg.name,
        version: pkg.version,
        license: pkg.license ?? null,
        development: !!dependency.dev,
        integrity: dependency.integrity,
        notices: await licenseFiles(path, label),
      });
    } catch (error) {
      // Platform-specific optional packages are absent on other build hosts.
      if (error.code !== 'ENOENT' || !dependency.optional) throw error;
    }
  }
  const metadata = spawnSync(
    'cargo',
    [
      'metadata',
      '--locked',
      '--format-version',
      '1',
      '--manifest-path',
      'apps/desktop/src-tauri/Cargo.toml',
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true },
  );
  if (metadata.status !== 0)
    throw new Error('Rust component inventory failed. Run cargo fetch --locked first.');
  const rust = [];
  for (const pkg of JSON.parse(metadata.stdout).packages) {
    rust.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      source: pkg.source?.startsWith('registry+')
        ? 'registry'
        : pkg.source?.startsWith('git+')
          ? 'git'
          : 'local',
      notices: await licenseFiles(dirname(pkg.manifest_path), `${pkg.name}@${pkg.version}`),
    });
  }
  if (!/^v24\.\d+\.\d+$/.test(process.version))
    throw new Error('A stable Node 24 build is required.');
  const url = `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!response.ok)
    throw new Error('Could not fetch the official license for the bundled Node version.');
  const nodeLicense = await response.text();
  if (nodeLicense.length > 2 * 1024 * 1024 || !nodeLicense.includes('Node.js'))
    throw new Error('Unexpected Node license response.');
  const inventory = {
    format: 'lodex-components-v1',
    builtAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: {
      version: process.version,
      licenseUrl: url,
      licenseSha256: createHash('sha256').update(nodeLicense).digest('hex'),
    },
    npm,
    rust,
  };
  await mkdir('.runtime', { recursive: true });
  await writeFile('.runtime/NODE_LICENSE.txt', nodeLicense);
  await writeFile('.runtime/DEPENDENCY_LICENSES.txt', licenses.join(''));
  await writeFile('.runtime/components.json', JSON.stringify(inventory, null, 2));
  await writeFile('.local/release/components.json', JSON.stringify(inventory, null, 2));
  console.log(
    `Release inventory: ${npm.length} npm packages, ${rust.length} Rust crates, Node ${process.version}.`,
  );
}
