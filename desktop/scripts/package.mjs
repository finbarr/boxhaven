import { packager } from '@electron/packager';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
export async function packageApp(releaseOptions = {}) {
  const paths = await packager({
    dir: root, name: 'BoxHaven', appBundleId: 'dev.boxhaven.desktop',
    executableName: 'BoxHaven', appCategoryType: 'public.app-category.developer-tools',
    out: join(root, 'release'), overwrite: true,
    ...releaseOptions,
    icon: join(root, 'assets', process.platform === 'darwin' ? 'BoxHaven.icns' : 'icon.png'),
    // The bundled CLI and node-pty's helper must be real executables on disk.
    asar: false,
    ignore: [/^\/release(?:\/|$)/, /^\/scripts(?:\/|$)/, /^\/test(?:\/|$)/, /^\/.artifacts(?:\/|$)/, /\.map$/],
});
return paths;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log((await packageApp()).join('\n'));
}
