import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadSecrets, loadMcpSecret } from './secrets';
const dirs: string[] = [];
async function setup(content?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'lodex-env-한글 '));
  dirs.push(dir);
  const path = join(dir, '.env');
  if (content !== undefined) await writeFile(path, content);
  return path;
}
afterEach(async () => {
  for (const path of dirs.splice(0)) {
    if (dirname(resolve(path)) !== resolve(tmpdir())) throw new Error('Unsafe cleanup');
    await rm(path, { recursive: true, force: true });
  }
});
describe('private daemon dotenv loading', () => {
  it('resolves only named MCP references without inheriting unrelated keys', async () => {
    const envFilePath = await setup(
      'LODEX_MCP_TOKEN=file-fixture\nOPENROUTER_API_KEY=other-secret\nNODE_OPTIONS=--inspect',
    );
    expect(await loadMcpSecret('LODEX_MCP_TOKEN', { envFilePath, environment: {} })).toBe(
      'file-fixture',
    );
    expect(
      await loadMcpSecret('LODEX_MCP_TOKEN', {
        envFilePath,
        environment: { LODEX_MCP_TOKEN: 'env-fixture' },
      }),
    ).toBe('env-fixture');
    expect(
      await loadMcpSecret('LODEX_MCP_MISSING', { envFilePath, environment: {} }),
    ).toBeUndefined();
    await expect(loadMcpSecret('OPENROUTER_API_KEY', { envFilePath })).rejects.toMatchObject({
      code: 'MCP_SECRET_REF',
    });
  });
  it('reads quoted keys without changing process environment or evaluating other entries', async () => {
    const path = await setup(
      'OPENROUTER_API_KEY=" fixture-key " # comment\nNODE_OPTIONS=--inspect\nVITE_SECRET=not-forwarded\nOTHER=$(do-not-execute)\n',
    );
    const before = { ...process.env };
    expect(await loadSecrets({ envFilePath: path })).toEqual({
      openrouterKey: 'fixture-key',
      openrouterKeySource: 'env_file',
      envFilePath: path,
    });
    expect(process.env).toEqual(before);
  });
  it('prioritizes environment, then dotenv, then keychain and treats blank entries as absent', async () => {
    const path = await setup('OPENROUTER_API_KEY=file-fixture');
    expect(
      (
        await loadSecrets({
          envFilePath: path,
          environment: { OPENROUTER_API_KEY: 'env-fixture' },
          keychainKey: 'keychain-fixture',
        })
      ).openrouterKeySource,
    ).toBe('environment');
    expect(
      (await loadSecrets({ envFilePath: path, keychainKey: 'keychain-fixture' })).openrouterKey,
    ).toBe('file-fixture');
    await writeFile(path, 'OPENROUTER_API_KEY=');
    expect(
      (await loadSecrets({ envFilePath: path, keychainKey: 'keychain-fixture' }))
        .openrouterKeySource,
    ).toBe('os_keychain');
    expect((await loadSecrets({ envFilePath: path })).openrouterKeySource).toBe('none');
  });
  it('allows a missing default file but fails closed for an explicit missing file', async () => {
    const path = await setup();
    expect((await loadSecrets({ envFilePath: path })).openrouterKey).toBeNull();
    await expect(loadSecrets({ envFilePath: path, requiredFile: true })).rejects.toMatchObject({
      code: 'ENV_FILE',
    });
  });
  it('rejects relative paths, oversized files and invalid UTF-8 without exposing file contents', async () => {
    await expect(loadSecrets({ envFilePath: '.env' })).rejects.toMatchObject({ code: 'ENV_PATH' });
    const path = await setup('x'.repeat(65537));
    await expect(loadSecrets({ envFilePath: path })).rejects.toMatchObject({ code: 'ENV_FILE' });
    await writeFile(path, Buffer.from([0xff, 0xfe]));
    await expect(loadSecrets({ envFilePath: path })).rejects.toMatchObject({ code: 'ENV_FILE' });
  });
  it('rejects multiline header injection and never includes the key in its error', async () => {
    const path = await setup('OPENROUTER_API_KEY="private-fixture\nAuthorization: other"');
    try {
      await loadSecrets({ envFilePath: path });
      throw new Error('Expected refusal');
    } catch (error) {
      expect(error).toMatchObject({ code: 'ENV_KEY_FORMAT' });
      expect(String(error)).not.toContain('private-fixture');
    }
  });
});
