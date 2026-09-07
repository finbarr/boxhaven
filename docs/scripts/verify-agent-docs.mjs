import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const output = join(root, '.vitepress/dist')
const index = await readFile(join(output, 'llms.txt'), 'utf8')
const links = [...index.matchAll(/^- \[[^\]]+\]\((https:\/\/docs\.boxhaven\.dev\/[^)]+\.md)\): /gm)]
const expected = (await readdir(root)).filter((file) => file.endsWith('.md') && file !== '404.md').sort()
const paths = links.map(([, url]) => new URL(url).pathname.slice(1)).sort()
assert.deepEqual(paths, expected, 'every published documentation page must appear once in llms.txt')
for (const path of paths) {
  const [source, markdown, html] = await Promise.all([
    readFile(join(root, path), 'utf8'),
    readFile(join(output, path), 'utf8'),
    readFile(join(output, path.replace(/\.md$/, '.html')), 'utf8'),
  ])
  assert.equal(markdown, source, `${path}: Markdown must match the maintained source`)
  assert.ok(html.includes(`href="https://docs.boxhaven.dev/${path}"`), `${path}: HTML must advertise its Markdown source`)
}
console.log(`Verified llms.txt and ${paths.length} Markdown documentation exports`)
