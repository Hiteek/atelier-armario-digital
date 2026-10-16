import type { Garment } from '@/lib/domain';

// A reusable composition of real photos; no image generation request is made.
export default function OutfitPreview({ garments }: { garments: Garment[] }) {
  return <div className="outfit-preview" aria-label="Composición de tus prendas reales">
    {garments.map(g => <div key={g.id} className={`preview-piece piece-${g.category}`}><img src={g.cutout_url || g.thumbnail_url} alt={g.name} loading="lazy"/></div>)}
  </div>;
}
