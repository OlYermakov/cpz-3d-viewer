// Збирає src/ в один автономний файл dist/CPZ-Viewer.html (працює офлайн, подвійним кліком).
import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

async function emit(result) {
  const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const html = await readFile('src/index.html', 'utf8');
  await mkdir('dist', { recursive: true });
  await writeFile('dist/CPZ-Viewer.html', html.replace('<!--APP_SCRIPT-->', () => `<script>${js}</script>`));
  console.log(`dist/CPZ-Viewer.html (${(js.length / 1024).toFixed(0)} KB JS)`);
}

const options = {
  entryPoints: ['src/main.js'],
  bundle: true,
  minify: !watch,
  format: 'iife',
  target: 'es2020',
  write: false,
  legalComments: 'none',
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
