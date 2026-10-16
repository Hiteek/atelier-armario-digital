import { foregroundBounds } from './cutout-mask';

let worker: Worker | undefined;
let active = false;
let idle: ReturnType<typeof setTimeout> | undefined;
let preferCpu = false;
try { preferCpu = sessionStorage.getItem('atelier-cutout-cpu') === '1'; } catch { /* Private browsing can disable storage. */ }
export async function removeBackground(blob: Blob, onProgress: (message: string) => void, signal: AbortSignal): Promise<Blob> {
  if (active) throw new Error('Termina el recorte actual antes de iniciar otro.');
  active = true; clearTimeout(idle);
  try {
    worker ??= new Worker(new URL('../worker/cutout-browser.ts', import.meta.url), { type: 'module' });
    const currentWorker = worker;
    const mask = await new Promise<{ alpha: Uint8Array; width: number; height: number }>((resolve, reject) => {
      const stop = () => { currentWorker.terminate(); worker = undefined; };
      const abort = () => { stop(); finish(); reject(new Error('Recorte cancelado.')); };
      const timer = setTimeout(() => { stop(); finish(); reject(new Error('El recorte tardó demasiado. Puedes volver a intentarlo; el original sigue guardado.')); }, 300_000);
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); currentWorker.onmessage = null; currentWorker.onerror = null; };
      currentWorker.onmessage = ({ data }) => {
        if (data.type === 'progress') onProgress(data.message);
        else if (data.type === 'diagnostic') {
          console.info('cutout-mask-check', JSON.stringify(data));
          if (data.engine === 'webgpu') { preferCpu = true; try { sessionStorage.setItem('atelier-cutout-cpu','1'); } catch { /* In-memory fallback still works. */ } }
        }
        else if (data.type === 'result') { finish(); resolve(data); }
        else { stop(); finish(); reject(new Error(data.message)); }
      };
      currentWorker.onerror = () => { stop(); finish(); reject(new Error('No se pudo iniciar el recortador. Tu original sigue guardado.')); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) return abort();
      currentWorker.postMessage({ blob, preferCpu });
    });
    if (signal.aborted) throw new Error('Recorte cancelado.');
    const bounds = foregroundBounds(mask.alpha, mask.width, mask.height);
    const bitmap = await createImageBitmap(blob);
    try {
      const maskCanvas = document.createElement('canvas'); maskCanvas.width = mask.width; maskCanvas.height = mask.height;
      const maskContext = maskCanvas.getContext('2d')!;
      const pixels = maskContext.createImageData(mask.width, mask.height);
      for (let i = 0; i < mask.alpha.length; i++) { pixels.data[i * 4] = 255; pixels.data[i * 4 + 1] = 255; pixels.data[i * 4 + 2] = 255; pixels.data[i * 4 + 3] = mask.alpha[i]; }
      maskContext.putImageData(pixels, 0, 0);
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(maskCanvas, 0, 0, canvas.width, canvas.height);
      const scaleX = bitmap.width / mask.width, scaleY = bitmap.height / mask.height;
      const crop = document.createElement('canvas'); crop.width = Math.ceil(bounds.width * scaleX); crop.height = Math.ceil(bounds.height * scaleY);
      crop.getContext('2d')!.drawImage(canvas, bounds.left * scaleX, bounds.top * scaleY, bounds.width * scaleX, bounds.height * scaleY, 0, 0, crop.width, crop.height);
      return await new Promise<Blob>((resolve, reject) => crop.toBlob(result => result && result.size <= 3 * 1024 * 1024 ? resolve(result) : reject(new Error('No se pudo preparar el recorte. Usa una foto más pequeña.')), 'image/webp', .94));
    } finally { bitmap.close(); }
  } finally {
    active = false;
    idle = setTimeout(() => { worker?.terminate(); worker = undefined; }, 90_000);
  }
}
