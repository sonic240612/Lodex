import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
export async function prepareBrowser() {
  const require = createRequire(import.meta.url);
  const source = dirname(require.resolve('playwright-core/package.json'));
  const dist = resolve('apps/daemon/dist');
  const target = join(dist, 'node_modules/playwright-core');
  if (relative(dist, target) !== join('node_modules', 'playwright-core'))
    throw new Error('Unsafe browser runtime destination');
  const files = [];
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (entry.isFile())
        files.push({
          path: relative(source, path).replaceAll('\\', '/'),
          sha256: createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
        });
      else throw new Error('Unsupported browser runtime link');
    }
  }
  await scan(source);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = JSON.stringify(
    {
      package: 'playwright-core',
      version: JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version,
      files,
    },
    null,
    2,
  );
  try {
    if ((await readFile(join(target, 'lodex-runtime.json'), 'utf8')) === manifest) {
      let matches = true;
      for (const file of files)
        if (
          createHash('sha256')
            .update(await readFile(join(target, file.path)))
            .digest('hex') !== file.sha256
        ) {
          matches = false;
          break;
        }
      if (matches) return;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
  await writeFile(join(target, 'lodex-runtime.json'), manifest);
}
