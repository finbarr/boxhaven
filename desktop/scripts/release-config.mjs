export function releaseConfig(env, version, platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin' || arch !== 'arm64') throw new Error('Desktop releases currently require macOS Apple Silicon.');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Desktop version must be a stable semver.');
  if (env.GITHUB_REF_NAME !== `desktop-v${version}`) throw new Error('Release tag must match desktop/package.json: desktop-v' + version);
  for (const name of ['APPLE_SIGN_IDENTITY', 'BOXHAVEN_SIGN_KEYCHAIN', 'BOXHAVEN_NOTARY_PROFILE']) {
    if (!env[name]?.trim()) throw new Error(`Missing required release configuration: ${name}`);
  }
  if (!env.APPLE_SIGN_IDENTITY.startsWith('Developer ID Application: ')) throw new Error('A Developer ID Application identity is required.');
  return {
    osxSign: {
      identity: env.APPLE_SIGN_IDENTITY,
      keychain: env.BOXHAVEN_SIGN_KEYCHAIN,
      // The app needs JIT for Electron, but no camera, location, or audio entitlements.
      optionsForFile: () => ({ hardenedRuntime: true, entitlements: ['com.apple.security.cs.allow-jit'] }),
    },
    osxNotarize: { keychain: env.BOXHAVEN_SIGN_KEYCHAIN, keychainProfile: env.BOXHAVEN_NOTARY_PROFILE },
  };
}
export function artifactName(version) { return `BoxHaven-${version}-mac-arm64.dmg`; }
