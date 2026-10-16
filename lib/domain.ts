import { createHash } from 'node:crypto';
import { z } from 'zod';

import { CATEGORIES, OCCASIONS } from './catalog';
export { CATEGORIES, OCCASIONS } from './catalog';
export const garmentInput = z.object({
  name: z.string().trim().min(1).max(100), category: z.enum(CATEGORIES),
  colors: z.array(z.string().trim().min(1).max(30)).min(1).max(6),
  pattern: z.string().trim().min(1).max(60), formality: z.number().int().min(1).max(5),
  available: z.boolean(), status: z.enum(['review', 'ready'])
});
export const profileInput = z.object({
  display_name: z.string().trim().min(1).max(70),
  styles: z.array(z.string().trim().min(1).max(50)).max(12),
  favorite_colors: z.array(z.string().trim().min(1).max(30)).max(12),
  work_formality: z.number().int().min(1).max(5), monthly_image_limit: z.number().int().min(0).max(1000)
});
export const suggestionInput = z.object({ occasion: z.enum(OCCASIONS), notes: z.string().trim().max(500).default(''), anchor_garment_id: z.string().uuid().optional() });
export const outfitInput = z.object({
  title: z.string().trim().min(1).max(100), explanation: z.string().max(1200),
  occasion: z.enum(OCCASIONS), garment_ids: z.array(z.string().uuid()).min(1).max(12),
  missing: z.array(z.string().max(100)).max(7)
});
export const suggestionOutput = z.object({ outfits: z.array(outfitInput).min(1).max(3) });
export type Garment = {
  id: string; user_id: string; name: string; category: typeof CATEGORIES[number]; colors: string[];
  pattern: string; formality: number; available: boolean; status: string;
  photo_path: string; thumbnail_path: string; version: number; deleted_at: string | null;
  photo_url?: string; thumbnail_url?: string;
  cutout_path?: string | null; cutout_thumbnail_path?: string | null; cutout_url?: string;
};
export type Profile = {
  user_id: string; display_name: string; styles: string[]; favorite_colors: string[];
  work_formality: number; monthly_image_limit: number; photo_path: string | null; photo_version: number;
  photo_url?: string; updated_at?: string;
};
export type Outfit = z.infer<typeof outfitInput> & { id: string; favorite: boolean; created_at: string };
export type Job = { id: string; kind: string; status: string; error: string | null; result: Record<string, unknown> | null; created_at: string; outfit_id?: string };
export type AgendaEvent = { id: string; date: string; occasion: typeof OCCASIONS[number]; notes: string; outfit_id: string | null };
export type Simulation = { id: string; outfit_id: string; image_path: string; image_url?: string; cache_key: string; photo_version: number };
export type Snapshot = { profile: Profile; garments: Garment[]; outfits: Outfit[]; events: AgendaEvent[]; jobs: Job[]; simulations: Simulation[]; image_requests: number; pending_jobs: number };

export class SuggestionConstraintError extends Error {}
export function validateSuggestionAnchor(anchorId: string | undefined, garments: Garment[]) {
  if (!anchorId) return;
  const anchor = garments.find(g => g.id === anchorId);
  if (!anchor || anchor.deleted_at || !anchor.available || anchor.status !== 'ready') throw new SuggestionConstraintError('La prenda elegida ya no está disponible. Confírmala o elige otra prenda.');
}
export function validateOutfit(outfit: z.infer<typeof outfitInput>, garments: Garment[], anchorId?: string) {
  if (anchorId && !outfit.garment_ids.includes(anchorId)) throw new SuggestionConstraintError('No se pudieron crear propuestas que incluyan tu prenda elegida. Vuelve a solicitar las combinaciones.');
  if (new Set(outfit.garment_ids).size !== outfit.garment_ids.length) throw new Error('Prendas repetidas en el conjunto.');
  const byId = new Map(garments.map(g => [g.id, g]));
  for (const id of outfit.garment_ids) {
    const g = byId.get(id);
    if (!g || g.deleted_at || !g.available || g.status !== 'ready') throw new Error('El conjunto contiene una prenda no disponible.');
  }
  const cats = new Set(outfit.garment_ids.map(id => byId.get(id)!.category));
  const missing = [];
  if (!cats.has('vestido')) {
    if (!cats.has('superior')) missing.push('Prenda superior');
    if (!cats.has('inferior')) missing.push('Prenda inferior');
  }
  if (!cats.has('calzado')) missing.push('Calzado');
  return { ...outfit, missing: [...new Set([...outfit.missing, ...missing])] };
}
export function renderKey(profile: Profile, outfit: Outfit, garments: Garment[]) {
  const g = validateOutfit(outfit, garments);
  if (!profile.photo_path) throw new Error('Sube primero una foto de cuerpo completo en tu perfil.');
  if (g.missing.length) throw new Error('Completa las piezas que faltan antes de generar la imagen.');
  const versions = g.garment_ids.map(id => {
    const garment = garments.find(item => item.id === id)!;
    return `${id}:${garment.version}`;
  }).sort();
  return createHash('sha256').update(JSON.stringify([profile.user_id, outfit.id, profile.photo_version, versions, process.env.IMAGE_MODEL || 'gpt-image-2', 'medium', '1024x1536', 'prompt-v1'])).digest('hex');
}
export function limaMonth(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit' }).formatToParts(date);
  return `${parts.find(p => p.type === 'year')!.value}-${parts.find(p => p.type === 'month')!.value}-01`;
}
export const eventInput = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value),
  occasion: z.enum(OCCASIONS), notes: z.string().trim().max(500), outfit_id: z.string().uuid().nullable()
});
