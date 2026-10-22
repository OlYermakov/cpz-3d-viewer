// Генерує PNG/ICO іконки з icons/icon.svg та icons/favicon.svg у public/ (запуск: npm run icons).
import { Resvg } from '@resvg/resvg-js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const icon = await readFile('icons/icon.svg', 'utf8');
const favicon = await readFile('icons/favicon.svg', 'utf8');

// Повноформатний варіант (без заокруглення, зображення зменшене до безпечної зони):
// Android «maskable» обрізає по колу/«сквірклу», iOS заокруглює кути сам
const fullBleed = (scale) => icon
  .replace('<rect width="512" height="512" rx="112"/>', '<rect width="512" height="512"/>')
  .replace('<g id="art">', `<g id="art" transform="translate(256 256) scale(${scale}) translate(-256 -256)">`);

const png = (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();

await mkdir('public', { recursive: true });
const out = {
  'favicon-16.png': png(favicon, 16),
  'favicon-32.png': png(favicon, 32),
  'favicon-48.png': png(favicon, 48),
  'icon-192.png': png(icon, 192),
  'icon-512.png': png(icon, 512),
  'icon-maskable-512.png': png(fullBleed(0.8), 512),
  'apple-touch-icon.png': png(fullBleed(0.98), 180),
};
for (const [name, data] of Object.entries(out)) await writeFile(`public/${name}`, data);

// favicon.ico з PNG 16/32/48 (формат ICO з PNG-вмістом, Windows Vista+)
const imgs = [[16, out['favicon-16.png']], [32, out['favicon-32.png']], [48, out['favicon-48.png']]];
const header = Buffer.alloc(6 + 16 * imgs.length);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(imgs.length, 4);
let offset = header.length;
imgs.forEach(([size, data], i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(size, e); header.writeUInt8(size, e + 1); header.writeUInt8(0, e + 2); header.writeUInt8(0, e + 3);
  header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(data.length, e + 8); header.writeUInt32LE(offset, e + 12);
  offset += data.length;
});
await writeFile('public/favicon.ico', Buffer.concat([header, ...imgs.map(([, d]) => d)]));
await writeFile('public/icon.svg', icon);

console.log('public/:', [...Object.keys(out), 'favicon.ico', 'icon.svg'].join(', '));
