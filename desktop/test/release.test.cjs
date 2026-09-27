const test = require('node:test');
const assert = require('node:assert/strict');
test('release cannot silently fall back to unsigned packaging', async () => {
  const { releaseConfig, artifactName } = await import('../scripts/release-config.mjs');
  const env = { GITHUB_REF_NAME: 'desktop-v0.1.0', APPLE_SIGN_IDENTITY: 'Developer ID Application: Example (TEAM)', BOXHAVEN_SIGN_KEYCHAIN: '/tmp/test.keychain-db', BOXHAVEN_NOTARY_PROFILE: 'test' };
  for (const field of Object.keys(env)) assert.throws(() => releaseConfig({ ...env, [field]: '' }, '0.1.0', 'darwin', 'arm64'));
  assert.throws(() => releaseConfig(env, '0.2.0', 'darwin', 'arm64'));
  assert.throws(() => releaseConfig(env, '0.1.0', 'linux', 'arm64'));
  assert.throws(() => releaseConfig({ ...env, APPLE_SIGN_IDENTITY: '-' }, '0.1.0', 'darwin', 'arm64'));
  const config = releaseConfig(env, '0.1.0', 'darwin', 'arm64');
  assert.equal(config.osxSign.optionsForFile().hardenedRuntime, true);
  assert.equal(config.osxNotarize.keychainProfile, 'test');
  assert.equal(artifactName('0.1.0'), 'BoxHaven-0.1.0-mac-arm64.dmg');
});
