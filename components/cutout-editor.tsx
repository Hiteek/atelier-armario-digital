'use client';

import { useEffect, useRef, useState } from 'react';
import { Scissors, LoaderCircle } from 'lucide-react';
import type { Garment } from '@/lib/domain';

export default function CutoutEditor({ garment, busy, onSave, onRestore }: { garment: Garment; busy: boolean; onSave: (blob: Blob, key: string) => void; onRestore: () => void }) {
  const [preview, setPreview] = useState<{ blob: Blob; url: string; key: string } | null>(null);
  const [progress, setProgress] = useState(''); const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  async function processPhoto() {
    if (controller.current || !garment.photo_url) return;
    const operation = new AbortController(); controller.current = operation; setError(''); setProgress('Abriendo tu foto original…');
    try {
      const response = await fetch(garment.photo_url, { signal: operation.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error('El enlace a tu foto caducó. Cierra y vuelve a abrir la prenda.');
      const blob = await response.blob();
      const { removeBackground } = await import('@/lib/remove-background');
      const cutout = await removeBackground(blob, setProgress, operation.signal);
      if (!operation.signal.aborted) setPreview({ blob: cutout, url: URL.createObjectURL(cutout), key: crypto.randomUUID() });
    } catch (e) { if (!operation.signal.aborted) setError((e as Error).message); }
    finally { if (!operation.signal.aborted) setProgress(''); controller.current = null; }
  }
  const cleaned = preview?.url || garment.cutout_url;
  return <section className="cutout-editor" aria-label="Limpiar foto de la prenda">
    <div className="photo-comparison">
      <figure><img src={garment.photo_url || garment.thumbnail_url} alt={`Original de ${garment.name}`}/><figcaption>Original guardado</figcaption></figure>
      {cleaned && <figure><img className="cutout-photo" src={cleaned} alt={`Recorte sin fondo de ${garment.name}`}/><figcaption>{preview ? 'Vista previa · sin guardar' : 'Sin fondo · guardado'}</figcaption></figure>}
    </div>
    <h3>Una foto más limpia</h3><p className="muted">Quita el fondo en tu dispositivo, sin crédito de OpenAI. La primera vez puede descargar unos 300 MB; mejor con wifi. Revisa bordes, colores y estampados antes de guardar.</p>
    {progress ? <><p className="cutout-progress" role="status"><LoaderCircle className="spin" size={16}/>{progress}</p><button type="button" className="text-button" onClick={() => { controller.current?.abort(); setProgress(''); }}>Cancelar recorte</button></> : <div className="cutout-actions">
      {preview ? <><button type="button" className="button primary" disabled={busy} onClick={() => onSave(preview.blob, preview.key)}>Guardar recorte</button><button type="button" className="text-button" disabled={busy} onClick={() => setPreview(null)}>Descartar</button></> : <><button type="button" className="button secondary" disabled={busy} onClick={() => void processPhoto()}><Scissors size={16}/>{garment.cutout_path ? 'Rehacer recorte' : 'Quitar fondo'}</button>{garment.cutout_path && <button type="button" className="text-button" disabled={busy} onClick={onRestore}>Usar foto original</button>}</>}
    </div>}
    {error && <p className="warning" role="alert">{error}</p>}
    <small>Al guardar se usará en tus conjuntos y próximas simulaciones. Tus simulaciones ya guardadas se conservan.</small>
  </section>;
}
