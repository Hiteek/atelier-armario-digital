import { AutoModel, AutoProcessor, RawImage, env } from '@huggingface/transformers';
import { alphaFromLogits, foregroundBounds } from '../lib/cutout-mask';

// We download fixed public weights only. User images never leave this worker.
const modelId = 'studioludens/birefnet-lite-512';
const revision = '962e67969ec6acec9c19fab76acee4f5e22e990c';
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm!.numThreads = 1;
env.backends.onnx.wasm!.proxy = false;

const scope = self as unknown as { onmessage: ((e: MessageEvent<{ blob: Blob; preferCpu: boolean }>) => Promise<void>) | null; postMessage: (data: unknown, transfer?: Transferable[]) => void };
const progress = (message: string) => scope.postMessage({ type: 'progress', message });
let model: Awaited<ReturnType<typeof AutoModel.from_pretrained>> | undefined;
let processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> | undefined;
let usingGpu = false;
const options = { revision, progress_callback: (event: { status: string; progress?: number }) => {
  if (event.status === 'progress' && typeof event.progress === 'number') progress(`Descargando el recortador: ${Math.round(event.progress)} %. Tus fotos siguen en tu dispositivo.`);
} };

scope.onmessage = async ({ data: { blob, preferCpu } }) => {
  try {
    if (!model) {
      progress('Preparando el recortador. La primera descarga puede tardar unos minutos…');
      const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
      const adapter = preferCpu ? null : await gpu?.requestAdapter().catch(() => null);
      const useGpu = adapter?.features.has('shader-f16');
      try {
        model = await AutoModel.from_pretrained(modelId, { ...options, device: useGpu ? 'webgpu' : 'wasm', dtype: useGpu ? 'fp16' : 'fp32' });
        usingGpu = !!useGpu;
      } catch (error) {
        if (!useGpu) throw error;
        scope.postMessage({ type:'diagnostic', engine:'webgpu', reason:'initialization-failed' });
        progress('Preparando una alternativa compatible con tu dispositivo…');
        model = await AutoModel.from_pretrained(modelId, { ...options, device: 'wasm', dtype: 'fp32' });
      }
      processor = await AutoProcessor.from_pretrained(modelId, { revision });
    }
    progress('Separando la prenda del fondo en tu dispositivo…');
    const image = await RawImage.fromBlob(blob);
    const { pixel_values } = await processor!(image);
    const infer = async () => {
      const output = await model!({ input_image: pixel_values });
      const logits = output.logits ?? output.output_image ?? Object.values(output)[0];
      try {
        const alpha = alphaFromLogits(logits.data as ArrayLike<number>, logits.type);
        // Validate before accepting GPU output; some adapters silently produce an unusable mask.
        try { foregroundBounds(alpha,512,512); }
        catch (error) {
          let min=255,max=0,foreground=0;
          for (const value of alpha) { min=Math.min(min,value);max=Math.max(max,value);if(value>=128)foreground++; }
          scope.postMessage({ type:'diagnostic', engine:usingGpu?'webgpu':'wasm', tensorType:logits.type, min,max,foreground:foreground/alpha.length });
          throw error;
        }
        return alpha;
      } finally { logits.dispose(); }
    };
    let alpha: Uint8Array;
    try { alpha = await infer(); }
    catch (error) {
      if (!usingGpu) throw error;
      progress('Probando un recorte compatible con tu dispositivo. El original se conserva…');
      await model.dispose(); model = undefined; usingGpu = false;
      model = await AutoModel.from_pretrained(modelId, { ...options, device: 'wasm', dtype: 'fp32' });
      progress('Separando la prenda del fondo en tu dispositivo…');
      alpha = await infer();
    }
    scope.postMessage({ type: 'result', alpha, width: 512, height: 512 }, [alpha.buffer]);
    pixel_values.dispose();
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith('No se pudo separar bien')
      ? error.message + ' Tu original sigue guardado.'
      : 'No se pudo recortar esta foto en este dispositivo. Prueba otra foto o un ordenador. Tu original sigue guardado.';
    scope.postMessage({ type: 'error', message });
  }
};
