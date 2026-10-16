import { ArrowRight, Images } from 'lucide-react';
import { occasionLabels } from '@/lib/catalog';
import type { Outfit, Simulation } from '@/lib/domain';

export default function SimulationGallery({ simulations, outfits, onView, onOpenOutfit, onFindLooks }: {
  simulations: Simulation[]; outfits: Outfit[]; onView: (simulation: Simulation) => void;
  onOpenOutfit: (outfit: Outfit) => void; onFindLooks: () => void;
}) {
  return <>
    <div className="page-heading"><div><span className="eyebrow">TUS LOOKS, EN IMÁGENES</span><h1>Mis simulaciones</h1><p>Todas tus imágenes guardadas, reunidas en un solo lugar.</p></div><Images className="heading-icon" size={34}/></div>
    <p className="muted saved-simulations-note">Ver estas imágenes no genera nuevas simulaciones ni consume crédito de IA. Son aproximaciones: pueden variar colores, estampados y ajuste.</p>
    <p className="result-count">{simulations.length} {simulations.length === 1 ? 'simulación guardada' : 'simulaciones guardadas'}</p>
    {simulations.length ? <div className="saved-simulations">{simulations.map(simulation => {
      const outfit = outfits.find(o => o.id === simulation.outfit_id);
      const title = outfit?.title || 'Conjunto guardado';
      return <article className="saved-simulation" key={simulation.id}>
        <button className="saved-simulation-photo" aria-label={`Ver simulación de ${title}`} onClick={() => onView(simulation)}>
          {simulation.image_url ? <img src={simulation.image_url} alt={`Simulación aproximada de ${title}`} loading="lazy"/> : <span>La imagen no está disponible por el momento.</span>}
          <span className="saved-simulation-label">Ver imagen completa</span>
        </button>
        <div className="saved-simulation-info"><span className="eyebrow">{outfit ? occasionLabels[outfit.occasion] : 'Tu armario'}</span><h2>{title}</h2>
          {simulation.created_at && <time dateTime={simulation.created_at}>{new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(simulation.created_at))}</time>}
          {outfit && <button className="button secondary full" onClick={() => onOpenOutfit(outfit)}>Abrir conjunto <ArrowRight size={16}/></button>}
        </div>
      </article>;
    })}</div> : <div className="empty-state"><div><Images size={34}/></div><h2>Tus simulaciones aparecerán aquí</h2><p>Elige un conjunto en Ideas de looks y pulsa «Verme con este look» para crear tu primera imagen.</p><button className="button secondary" onClick={onFindLooks}>Explorar mis conjuntos <ArrowRight size={16}/></button></div>}
  </>;
}
