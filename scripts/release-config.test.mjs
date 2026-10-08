import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseConfig } from './release-config.mjs';

const fixture = {
  version: '0.1.0',
  desktopVersion: '0.1.0',
  rustVersion: '0.1.0',
  requestedVersion: '0.1.0',
  signed: false,
  draft: false,
  repository: 'sonic240612/Lodex',
  platform: 'win32',
};
test('unsigned packages cannot enable updater or publish a draft', () => {
  assert.deepEqual(releaseConfig(fixture).plugins.updater.endpoints, []);
  assert.throws(() => releaseConfig({ ...fixture, draft: true }), /signed/);
  assert.throws(() => releaseConfig({ ...fixture, requestedVersion: '0.2.0' }), /version/);
});
test('signed configuration includes only public key and the selected repository', () => {
  const config = releaseConfig({
    ...fixture,
    signed: true,
    draft: true,
    publicKey: 'public-fixture',
    privateKey: 'secret-fixture',
    platform: 'darwin',
  });
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.deepEqual(config.bundle.targets, ['app', 'dmg']);
  assert.match(config.plugins.updater.endpoints[0], /sonic240612\/Lodex/);
  assert.ok(!JSON.stringify(config).includes('secret-fixture'));
  assert.throws(() => releaseConfig({ ...fixture, signed: true }), /PRIVATE_KEY/);
  assert.throws(
    () => releaseConfig({ ...fixture, repository: 'owner/repo?token=secret' }),
    /repository/,
  );
});
