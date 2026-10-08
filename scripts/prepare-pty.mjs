import { cp, mkdir, readdir, readFile, rm, stat, chmod, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export async function preparePty() {
  const require = createRequire(import.meta.url);
  const source = dirname(require.resolve('node-pty/package.json'));
  const dist = resolve('apps/daemon/dist');
  const target = join(dist, 'node_modules/node-pty');
  if (relative(dist, target) !== join('node_modules', 'node-pty'))
    throw new Error('Unsafe PTY destination');
  const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  try {
    const previous = JSON.parse(await readFile(join(target, 'lodex-runtime.json'), 'utf8'));
    if (
      previous.version === metadata.version &&
      previous.platform === process.platform &&
      previous.arch === process.arch &&
      previous.node === process.version
    ) {
      const expected = [
        ...previous.files,
        ...(await Promise.all(
          ['package.json', 'lib/index.js'].map(async (path) => ({
            path,
            sha256: createHash('sha256')
              .update(await readFile(join(source, path)))
              .digest('hex'),
          })),
        )),
      ];
      let matches = true;
      for (const file of expected) {
        if (
          createHash('sha256')
            .update(await readFile(join(target, file.path)))
            .digest('hex') !== file.sha256 ||
          createHash('sha256')
            .update(await readFile(join(source, file.path)))
            .digest('hex') !== file.sha256
        )
          matches = false;
      }
      if (matches) return; // Do not unlink native libraries held by a running development terminal.
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const entry of ['package.json', 'LICENSE', 'lib'])
    await cp(join(source, entry), join(target, entry), { recursive: true });
  for (const entry of ['build/Release', `prebuilds/${process.platform}-${process.arch}`]) {
    try {
      if ((await stat(join(source, entry))).isDirectory())
        await cp(join(source, entry), join(target, entry), { recursive: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const files = [];
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await inspect(path);
      else if (entry.name.endsWith('.node') || entry.name === 'spawn-helper') {
        if (process.platform !== 'win32') await chmod(path, 0o755);
        files.push({
          path: relative(target, path).replaceAll('\\', '/'),
          sha256: createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
        });
      }
    }
  }
  await inspect(target);
  if (!files.some((file) => file.path.endsWith('.node')))
    throw new Error('Missing node-pty native module for this build platform');
  await writeFile(
    join(target, 'lodex-runtime.json'),
    JSON.stringify(
      {
        package: 'node-pty',
        version: metadata.version,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        abi: process.versions.modules,
        napi: process.versions.napi,
        files,
      },
      null,
      2,
    ),
  );
}
