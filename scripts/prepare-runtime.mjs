import { mkdir, copyFile, chmod, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
if (!process.version.startsWith('v24.')) throw new Error('Node 24 LTS is required.');
await mkdir('.runtime', { recursive: true });
const destination = '.runtime/' + (process.platform === 'win32' ? 'node.exe' : 'node');
await copyFile(process.execPath, destination);
if (process.platform !== 'win32') await chmod(destination, 0o755);
await writeFile(
  '.runtime/manifest.json',
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      sha256: createHash('sha256')
        .update(await readFile(destination))
        .digest('hex'),
      distribution:
        'Development runtime copied from the build machine; release licensing and signing gate remains open.',
    },
    null,
    2,
  ),
);
console.log('Prepared bundled Node runtime:', destination);
