import { packager } from '@electron/packager';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const paths = await packager({
  dir: root, name: 'BoxHaven', appBundleId: 'dev.boxhaven.desktop',
  executableName: 'BoxHaven', appCategoryType: 'public.app-category.developer-tools',
  out: join(root, 'release'), overwrite: true,
  icon: join(root, 'assets', process.platform === 'darwin' ? 'BoxHaven.icns' : 'icon.png'),
  // The bundled CLI and node-pty's helper must be real executables on disk.
  asar: false,
  ignore: [/^\/release(?:\/|$)/, /^\/scripts(?:\/|$)/, /^\/test(?:\/|$)/, /^\/.artifacts(?:\/|$)/, /\.map$/],
});
console.log(paths.join('\n'));
