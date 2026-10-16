import { describe, expect, it } from 'vitest';
import { eventInput, garmentInput, limaMonth, renderKey, validateOutfit, validateSuggestionAnchor, suggestionInput, type Garment, type Outfit, type Profile } from '../lib/domain';
import { preparePhoto } from '../lib/images';
import sharp from 'sharp';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const garment = (id: number, category: Garment['category']): Garment => ({
  id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, user_id: owner,
  name: 'Prenda', category, colors: ['crema'], pattern: 'Liso', formality: 3, available: true,
  status: 'ready', photo_path: `${owner}/garment/${id}/photo.jpg`, thumbnail_path: '', version: 1, deleted_at: null
});
const garments = [garment(1, 'superior'), garment(2, 'inferior'), garment(3, 'calzado')];
const outfit: Outfit = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'Look', explanation: 'Elegante', occasion: 'trabajo', garment_ids: garments.map(g => g.id), missing: [], favorite: false, created_at: '' };
const profile: Profile = { user_id: owner, display_name: 'Yo', photo_path: `${owner}/profile/photo.jpg`, photo_version: 1, styles: [], favorite_colors: [], work_formality: 3, monthly_image_limit: 30 };

describe('Conjuntos y cache de imágenes', () => {
  it('permite búsquedas generales y exige un identificador válido para fijar una prenda', () => {
    expect(suggestionInput.parse({occasion:'casual'}).anchor_garment_id).toBeUndefined();
    expect(()=>suggestionInput.parse({occasion:'casual',anchor_garment_id:'inventado'})).toThrow();
    expect(()=>validateSuggestionAnchor(garments[0].id,garments)).not.toThrow();
    for(const changes of [{available:false},{status:'review'},{deleted_at:'2026-10-15'}]) expect(()=>validateSuggestionAnchor(garments[0].id,[{...garments[0],...changes}])).toThrow();
    expect(()=>validateSuggestionAnchor('cccccccc-cccc-4ccc-8ccc-cccccccccccc',garments)).toThrow();
  });
  it('rechaza propuestas que omiten la prenda fija y conserva las piezas faltantes', () => {
    expect(()=>validateOutfit({...outfit,garment_ids:garments.slice(1).map(g=>g.id)},garments,garments[0].id)).toThrow();
    const partial=validateOutfit({...outfit,garment_ids:[garments[0].id]},garments,garments[0].id);
    expect(partial.garment_ids).toContain(garments[0].id); expect(partial.missing).toContain('Calzado');
  });
  it('rechaza prendas inventadas, retiradas, pendientes y no disponibles', () => {
    expect(() => validateOutfit({ ...outfit, garment_ids: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'] }, garments)).toThrow();
    for (const changes of [{ deleted_at: '2026-10-14' }, { available: false }, { status: 'review' }]) {
      expect(() => validateOutfit(outfit, [{ ...garments[0], ...changes }, ...garments.slice(1)])).toThrow();
    }
  });
  it('detecta piezas básicas faltantes sin inventar identificadores', () => {
    const partial = validateOutfit({ ...outfit, garment_ids: [garments[0].id] }, garments);
    expect(partial.missing).toEqual(['Prenda inferior', 'Calzado']);
    expect(partial.garment_ids).toEqual([garments[0].id]);
  });
  it('acepta un vestido con calzado y rechaza identificadores duplicados', () => {
    const dress = garment(4, 'vestido');
    expect(validateOutfit({ ...outfit, garment_ids: [dress.id, garments[2].id] }, [...garments, dress]).missing).toEqual([]);
    expect(() => validateOutfit({ ...outfit, garment_ids: [dress.id, dress.id] }, [dress])).toThrow();
  });
  it('reutiliza la misma composición y cambia al modificar cualquier foto/prenda', () => {
    const key = renderKey(profile, outfit, garments);
    expect(renderKey(profile, { ...outfit, garment_ids: [...outfit.garment_ids].reverse() }, garments)).toBe(key);
    expect(renderKey({ ...profile, photo_version: 2 }, outfit, garments)).not.toBe(key);
    expect(renderKey(profile, outfit, [{ ...garments[0], version: 2 }, ...garments.slice(1)])).not.toBe(key);
    expect(() => renderKey({ ...profile, photo_path: null }, outfit, garments)).toThrow();
    expect(() => renderKey(profile, { ...outfit, garment_ids: [garments[0].id] }, garments)).toThrow();
  });
  it('cuenta el mes de Lima y valida fechas reales', () => {
    expect(limaMonth(new Date('2026-11-01T02:00:00Z'))).toBe('2026-10-01');
    expect(eventInput.safeParse({ date: '2026-02-30', occasion: 'casual', notes: '', outfit_id: null }).success).toBe(false);
  });
  it('valida la clasificación editada', () => {
    expect(garmentInput.safeParse({ ...garments[0], status: 'ready' }).success).toBe(true);
    expect(garmentInput.safeParse({ ...garments[0], colors: [], status: 'ready' }).success).toBe(false);
  });
});
describe('Fotos', () => {
  it('corrige orientación EXIF, limita resolución y elimina metadatos', async () => {
    const raw = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#fff' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const { photo, thumbnail } = await preparePhoto(new File([new Uint8Array(raw)], 'prenda.jpg', { type: 'image/jpeg' }));
    const meta = await sharp(photo).metadata();
    expect(meta.width).toBe(200); expect(meta.height).toBe(400); expect(meta.exif).toBeUndefined();
    expect((await sharp(thumbnail).metadata()).format).toBe('webp');
  });
  it('rechaza archivos falsos, formatos no permitidos y más de 10 MB', async () => {
    await expect(preparePhoto(new File(['not an image'], 'test.jpg', { type: 'image/jpeg' }))).rejects.toThrow();
    await expect(preparePhoto(new File(['test'], 'test.svg', { type: 'image/svg+xml' }))).rejects.toThrow();
    await expect(preparePhoto(new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' }))).rejects.toThrow();
  });
});
