// Читання DWG у фоновому потоці (dist/dwg/dwg-worker.js + libredwg-web.wasm ≈ 9,5 МБ).
// Файли завантажуються лише при відкритті DWG; для кожного файлу — новий потік.
import { t } from './i18n.js';

/** Версія формату з перших байтів файлу (AC1032 тощо). */
export const dwgVersion = (bytes) => new TextDecoder('latin1').decode(bytes.subarray(0, 6)).replace(/[^A-Z0-9]/g, '');

export function readDWG(bytes) {
  // Фоновий потік і WebAssembly не працюють із локального файлу (file://) — лише на сайті
  if (location.protocol === 'file:') return Promise.reject(new Error(t('e.dwgOffline')));
  const dir = new URL('dwg/', location.href);
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('dwg-worker.js', dir), { type: 'module' });
    } catch {
      reject(new Error(t('e.dwgOffline')));
      return;
    }
    const done = (fn, v) => { worker.terminate(); fn(v); };
    worker.onmessage = (e) => (e.data.ok ? done(resolve, e.data.sections) : done(reject, new Error(t('e.dwgRead'))));
    worker.onerror = () => done(reject, new Error(t('e.dwgRead')));
    const copy = bytes.slice(); // буфер передається потоку (transfer) — віддаємо копію
    worker.postMessage({ bytes: copy, wasmDir: dir.href.replace(/\/$/, '') }, [copy.buffer]);
  });
}
