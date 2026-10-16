import { describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createJobRunner, type Work } from '../lib/job-runner';
import { renderKey, type Profile, type Outfit, type Garment } from '../lib/domain';
const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const gs: Garment[] = ['superior', 'inferior', 'calzado'].map((category, i) => ({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, user_id: owner, name: 'Prenda', category: category as Garment['category'], colors: ['crema'], pattern: 'Liso', formality: 3, available: true, status: 'ready', photo_path: `${owner}/garment/${i}.jpg`, thumbnail_path: '', version: 1, deleted_at: null }));
const profile: Profile = { user_id: owner, display_name: 'Yo', photo_path: `${owner}/profile.jpg`, photo_version: 1, styles: [], favorite_colors: [], work_formality: 3, monthly_image_limit: 30 };
const outfit: Outfit = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'Look', explanation: 'Prueba', occasion: 'trabajo', garment_ids: gs.map(g => g.id), missing: [], favorite: false, created_at: '' };
const renderJob: Work = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', user_id: owner, kind: 'render', payload: { outfit_id: outfit.id }, render_key: renderKey(profile, outfit, gs), attempts: 1 };
function fixtures(cleanupError = false) {
  const updates: { table: string; data: Record<string, unknown> }[] = [];
  const results: Record<string, unknown> = { app_owner: { user_id: owner }, profiles: profile, outfits: outfit, garments: gs, ai_jobs: { status: 'running' }, simulations: null };
  const storage = { download: vi.fn(async () => ({ data: new Blob(['fixture']), error: null })), upload: vi.fn(async () => ({ error: null })), remove: vi.fn(async () => ({ error: cleanupError ? { message: 'offline' } : null })) };
  const rpc = vi.fn(async () => ({ error: null }));
  const db = { storage: { from: () => storage }, rpc, from: (table: string) => {
    const chain = { select: () => chain, eq: () => chain, in: () => chain, is: () => chain, update: (data: Record<string, unknown>) => { updates.push({ table, data }); return chain; }, single: async () => ({ data: results[table], error: null }), maybeSingle: async () => ({ data: results[table], error: null }), then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: results[table], error: null }).then(resolve) };
    return chain;
  } } as unknown as SupabaseClient;
  return { db, updates, storage, rpc, results };
}
describe('Procesador compartido sin trabajador de pago', () => {
  it('elimina archivos sin necesitar una clave de IA', async () => {
    const f = fixtures(); const getAi = vi.fn(() => { throw new Error('No AI'); });
    await createJobRunner(f.db, getAi)({ ...renderJob, kind: 'cleanup', payload: { paths: [`${owner}/old.jpg`] } });
    expect(getAi).not.toHaveBeenCalled(); expect(f.storage.remove).toHaveBeenCalledWith([`${owner}/old.jpg`]);
    expect(f.updates.at(-1)?.data.status).toBe('succeeded');
  });
  it('nunca elimina un archivo de otro propietario', async () => {
    const f = fixtures();
    await createJobRunner(f.db, () => { throw new Error('No AI'); })({ ...renderJob, kind: 'cleanup', attempts: 3, payload: { paths: ['foreign/photo.jpg'] } });
    expect(f.storage.remove).not.toHaveBeenCalled(); expect(f.updates.at(-1)?.data.status).toBe('failed');
  });
  it('marca incierto un fallo posterior a solicitar una imagen, sin reintentar la API', async () => {
    const f = fixtures(); const edit = vi.fn(async () => { throw new Error('Lost response'); });
    await createJobRunner(f.db, () => ({ images: { edit } }) as unknown as OpenAI)(renderJob);
    expect(edit).toHaveBeenCalledTimes(1); expect(f.updates.at(-1)?.data.status).toBe('uncertain');
  });
  it('rechaza referencias cambiadas antes de gastar en una imagen', async () => {
    const f = fixtures(); f.results.profiles = { ...profile, photo_version: 2 }; const getAi = vi.fn();
    await createJobRunner(f.db, getAi)(renderJob);
    expect(getAi).not.toHaveBeenCalled(); expect(f.updates.at(-1)?.data.status).toBe('failed');
  });
  it('confirma versiones al guardar la imagen en lugar de publicarla directamente', async () => {
    const f = fixtures(); const edit = vi.fn(async () => ({ data: [{ b64_json: Buffer.from('fixture').toString('base64') }] }));
    await createJobRunner(f.db, () => ({ images: { edit } }) as unknown as OpenAI)(renderJob);
    expect(f.rpc).toHaveBeenCalledWith('complete_render', expect.objectContaining({ p_job: renderJob.id, p_photo_version: 1, p_versions: Object.fromEntries(gs.map(g => [g.id, 1])) }));
    expect(edit.mock.calls[0]).toBeDefined();
  });
});
