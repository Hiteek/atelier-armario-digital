import { AutoModel, AutoProcessor, RawImage, env } from '@huggingface/transformers';

// We download fixed public weights only. User images never leave this worker.
const modelId = 'studioludens/birefnet-lite-512';
const revision = '962e67969ec6acec9c19fab76acee4f5e22e990c';
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm!.numThreads = 1;
env.backends.onnx.wasm!.proxy = false;

const scope = self as unknown as { onmessage: ((e: MessageEvent<Blob>) => Promise<void>) | null; postMessage: (data: unknown, transfer?: Transferable[]) => void };
const progress = (message: string) => scope.postMessage({ type: 'progress', message });
let model: Awaited<ReturnType<typeof AutoModel.from_pretrained>> | undefined;
let processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> | undefined;

scope.onmessage = async ({ data: blob }) => {
  try {
    if (!model) {
      progress('Preparando el recortador. La primera descarga puede tardar unos minutos…');
      const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
      const adapter = await gpu?.requestAdapter().catch(() => null);
      const useGpu = adapter?.features.has('shader-f16');
      const options = { revision, progress_callback: (event: { status: string; progress?: number }) => {
        if (event.status === 'progress' && typeof event.progress === 'number') progress(`Descargando el recortador: ${Math.round(event.progress)} %. Tus fotos siguen en tu dispositivo.`);
      } };
      try {
        model = await AutoModel.from_pretrained(modelId, { ...options, device: useGpu ? 'webgpu' : 'wasm', dtype: useGpu ? 'fp16' : 'fp32' });
      } catch (error) {
        if (!useGpu) throw error;
        progress('Preparando una alternativa compatible con tu dispositivo…');
        model = await AutoModel.from_pretrained(modelId, { ...options, device: 'wasm', dtype: 'fp32' });
      }
      processor = await AutoProcessor.from_pretrained(modelId, { revision });
    }
    progress('Separando la prenda del fondo en tu dispositivo…');
    const image = await RawImage.fromBlob(blob);
    const { pixel_values } = await processor!(image);
    const output = await model({ input_image: pixel_values });
    const logits = output.logits ?? Object.values(output)[0];
    const mask = logits.sigmoid();
    const alpha = Uint8Array.from(mask.data as Float32Array, value => Math.round(Math.max(0, Math.min(1, value)) * 255));
    scope.postMessage({ type: 'result', alpha, width: 512, height: 512 }, [alpha.buffer]);
    pixel_values.dispose(); logits.dispose(); mask.dispose();
  } catch {
    scope.postMessage({ type: 'error', message: 'Este dispositivo no pudo completar el recorte. Prueba desde un ordenador o con una foto más sencilla. Tu original sigue guardado.' });
  }
};
