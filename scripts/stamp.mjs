// Cache-busting for GitHub Pages (max-age=600, no headers to tweak): every local
// module and the stylesheet get ?v=<content hash> via an import map in index.html,
// so a deploy never mixes old and new files. Run `npm run stamp` before committing;
// `npm test` fails if index.html is out of date.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const hash = (f) => createHash('sha1').update(readFileSync(join(root, f))).digest('hex').slice(0, 8);
const walk = (d) => readdirSync(join(root, d), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.js') ? [join(d, e.name)] : []));

export function stamped() {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const files = walk('js').map((f) => relative(root, join(root, f))).sort();
  const imports = Object.fromEntries(files.map((f) => [`./${f}`, `./${f}?v=${hash(f)}`]));
  const map = `<script type="importmap">${JSON.stringify({ imports }, null, 2)}</script>`;
  return html
    .replace(/<script type="importmap">[\s\S]*?<\/script>\n?\s*/, '')
    .replace(/<script type="module" src="js\/app\.js[^"]*"><\/script>/, `${map}\n  <script type="module" src="js/app.js?v=${hash('js/app.js')}"></script>`)
    .replace(/href="css\/style\.css[^"]*"/, `href="css/style.css?v=${hash('css/style.css')}"`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(join(root, 'index.html'), stamped());
  console.log('index.html stamped');
}
