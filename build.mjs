// Збирає src/ в один автономний файл dist/CPZ-Viewer.html (працює офлайн, подвійним кліком)
// і копіює public/ (іконки, маніфест) поруч — для сайту на GitHub Pages.
import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));

async function emit(result) {
  const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const html = await readFile('src/index.html', 'utf8');
  const favicon = (await readFile('icons/favicon.svg', 'utf8')).trim();
  // Іконка вкладки — data-URI, щоб працювала і в офлайн-файлі; логотип у панелі — та сама SVG
  const faviconUri = `data:image/svg+xml,${encodeURIComponent(favicon.replace(/<!--[\s\S]*?-->/g, ''))}`;
  const brand = favicon.replace(/<!--[\s\S]*?-->/g, '').replace('<svg ', '<svg width="38" height="38" aria-hidden="true" ');
  // Велика іконка у вікні «Про застосунок»: id з префіксом, щоб не конфліктувати з іншими SVG на сторінці
  const aboutIcon = (await readFile('icons/icon.svg', 'utf8'))
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/id="([^"]+)"/g, 'id="ai-$1"')
    .replace(/url\(#([^)]+)\)/g, 'url(#ai-$1)')
    .replace('<svg ', '<svg aria-hidden="true" ');
  await mkdir('dist', { recursive: true });
  await writeFile('dist/CPZ-Viewer.html', html
    .replace('<!--FAVICON_URI-->', () => faviconUri)
    .replace('<!--BRAND_SVG-->', () => brand)
    .replace('<!--ABOUT_ICON-->', () => aboutIcon)
    .replace('<!--APP_SCRIPT-->', () => `<script>${js}</script>`));
  await cp('public', 'dist', { recursive: true });
  console.log(`dist/CPZ-Viewer.html (${(js.length / 1024).toFixed(0)} KB JS) + public/`);
}

const options = {
  entryPoints: ['src/main.js'],
  bundle: true,
  minify: !watch,
  format: 'iife',
  target: 'es2020',
  write: false,
  legalComments: 'none',
  loader: { '.DAT': 'text', '.dat': 'text' }, // каталог Objektart вбудовується як текст
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
};

if (watch) {
  const ctx = await esbuild.context({
    ...options,
    plugins: [{ name: 'emit', setup(b) { b.onEnd((r) => r.errors.length || emit(r)); } }],
  });
  await ctx.watch();
  console.log('Очікую змін...');
} else {
  await emit(await esbuild.build(options));
}
