import { build } from 'esbuild';
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = dirname(root);
for (const dir of ['dist', 'bin', 'assets']) mkdirSync(join(root, dir), { recursive: true });
const revision = execFileSync('git', ['describe', '--tags', '--match', 'v[0-9]*', '--always', '--dirty'], { cwd: repo, encoding: 'utf8' }).trim();
execFileSync('go', ['build', '-trimpath', '-ldflags', `-X main.Version=${revision}`, '-o', join(root, 'bin', 'bh'), './cmd/bh'], { cwd: repo, stdio: 'inherit' });
copyFileSync(join(repo, 'backend/app/src/assets/boxhaven-logo.png'), join(root, 'assets/icon.png'));
copyFileSync(join(root, 'assets/icon.png'), join(root, 'dist/icon.png'));
copyFileSync(join(root, 'src/index.html'), join(root, 'dist/index.html'));
copyFileSync(join(repo, 'LICENSE'), join(root, 'dist/LICENSE'));
await build({ entryPoints: [join(root, 'src/renderer.js')], bundle: true, outdir: join(root, 'dist'), minify: true, sourcemap: true });
if (process.platform === 'darwin') {
  const iconset = join(root, 'assets/BoxHaven.iconset');
  mkdirSync(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      execFileSync('sips', ['-z', String(size * scale), String(size * scale), join(root, 'assets/icon.png'), '--out', join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'pipe' });
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(root, 'assets/BoxHaven.icns')]);
  rmSync(iconset, { recursive: true });
}
console.log('Built BoxHaven desktop and its bundled bh CLI.');
