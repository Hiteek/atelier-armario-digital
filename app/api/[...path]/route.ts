import { z } from 'zod';
import { adminClient, isConfigured, sessionClient } from '@/lib/supabase';
import { authenticated, dbCheck, errorResponse, HttpError, json, limitedBody, readJson, requestKey, sameOrigin } from '@/lib/http';
import { eventInput, garmentInput, limaMonth, outfitInput, profileInput, renderKey, suggestionInput, validateOutfit, type Garment, type Outfit, type Profile } from '@/lib/domain';
import { preparePhoto } from '@/lib/images';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
type Context = { params: Promise<{ path: string[] }> };

async function signed(db: Awaited<ReturnType<typeof sessionClient>>, path: string | null) {
  if (!path) return undefined;
  const { data } = await db.storage.from('wardrobe').createSignedUrl(path, 900);
  return data?.signedUrl;
}
async function dispatch(req: Request, ctx: Context) {
  const { path } = await ctx.params; const route = path[0]; const id = path[1]; const method = req.method;
  if (method !== 'GET') sameOrigin(req);
  if (route === 'status' && method === 'GET') return json({ configured: isConfigured() });
  if (route === 'login' && method === 'POST') {
    if (!isConfigured()) throw new HttpError(503, 'Falta conectar el almacenamiento privado.');
    const credentials = z.object({ email: z.string().email(), password: z.string().min(1).max(200) }).parse(await readJson(req));
    const db = await sessionClient(); const { error } = await db.auth.signInWithPassword(credentials);
    if (error) throw new HttpError(401, 'No se pudo iniciar sesión. Revisa tu correo y contraseña.');
    const owner = await db.rpc('is_armario_owner');
    if (!owner.data || owner.error) { await db.auth.signOut(); throw new HttpError(403, 'Esta cuenta no tiene acceso a este armario privado.'); }
    return json({ ok: true });
  }
  const { db, user } = await authenticated(); const admin = adminClient();
  if (route === 'logout' && method === 'POST') { await db.auth.signOut(); return json({ ok: true }); }
  if (route === 'snapshot' && method === 'GET') {
    dbCheck((await db.from('profiles').upsert({ user_id: user.id }, { onConflict: 'user_id', ignoreDuplicates: true })).error);
    const results = await Promise.all([
      db.from('profiles').select('*').eq('user_id', user.id).single(),
      db.from('garments').select('*').is('deleted_at', null).order('created_at', { ascending: false }),
      db.from('outfits').select('*').order('created_at', { ascending: false }),
      db.from('agenda_events').select('*').order('date'),
      db.from('ai_jobs').select('id,kind,status,error,result,created_at,payload').order('created_at', { ascending: false }).limit(50),
      db.from('simulations').select('*').order('created_at', { ascending: false }),
      db.from('ai_jobs').select('id', { count: 'exact', head: true }).eq('kind', 'render').gte('created_at', `${limaMonth()}T00:00:00-05:00`),
      db.from('ai_jobs').select('id', { count: 'exact', head: true }).in('status', ['queued', 'running'])
    ]);
    results.forEach(r => dbCheck(r.error));
    const [profile, garments, outfits, events, jobs, simulations, usage, pending] = results;
    return json({
      profile: { ...profile.data, photo_url: await signed(db, profile.data!.photo_path) },
      garments: await Promise.all(garments.data!.map(async g => ({ ...g, thumbnail_url: await signed(db, g.thumbnail_path), photo_url: await signed(db, g.photo_path) }))),
      outfits: outfits.data, events: events.data, jobs: jobs.data!.map(({ payload, ...j }) => ({ ...j, outfit_id: payload?.outfit_id })),
      simulations: await Promise.all(simulations.data!.map(async s => ({ ...s, image_url: await signed(db, s.image_path) }))),
      image_requests: usage.count ?? 0, pending_jobs: pending.count ?? 0
    });
  }
  if (route === 'upload' && method === 'POST') {
    const key = requestKey(req);
    const raw = await limitedBody(req, 11 * 1024 * 1024);
    const form = await new Response(new Uint8Array(raw), { headers: { 'Content-Type': req.headers.get('content-type') || '' } }).formData();
    const kind = z.enum(['garment', 'profile']).parse(form.get('kind'));
    const file = form.get('file'); if (!(file instanceof File)) throw new HttpError(400, 'Selecciona una foto.');
    if (kind === 'garment') {
      const existing = await db.from('garments').select('id').eq('id', key).maybeSingle(); dbCheck(existing.error);
      if (existing.data) return json({ id: key });
    }
    let photos: Awaited<ReturnType<typeof preparePhoto>>;
    try { photos = await preparePhoto(file); } catch { throw new HttpError(400, 'Usa una foto JPG, PNG o WebP estática, válida y de hasta 10 MB.'); }
    const base = `${user.id}/${kind}/${key}`; const photoPath = `${base}/photo.jpg`; const thumbPath = `${base}/thumb.webp`;
    dbCheck((await admin.storage.from('wardrobe').upload(photoPath, photos.photo, { contentType: 'image/jpeg', upsert: true })).error);
    try {
      if (kind === 'profile') {
        dbCheck((await admin.rpc('change_photo', { p_user: user.id, p_path: photoPath })).error);
      } else {
        dbCheck((await admin.storage.from('wardrobe').upload(thumbPath, photos.thumbnail, { contentType: 'image/webp', upsert: true })).error);
        const result = await admin.rpc('register_garment', { p_user: user.id, p_id: key, p_name: file.name.replace(/\.[^.]+$/, '').slice(0, 100) || 'Nueva prenda', p_photo: photoPath, p_thumb: thumbPath });
        dbCheck(result.error);
      }
    } catch (error) {
      // If the database response was lost, don't remove images from a successfully committed operation.
      const exists = kind === 'garment' ? await db.from('garments').select('id').eq('id', key).maybeSingle() : await db.from('profiles').select('photo_path').eq('photo_path', photoPath).maybeSingle();
      if (!exists.error && !exists.data) await admin.storage.from('wardrobe').remove([photoPath, thumbPath]);
      if (exists.data) return json({ id: key });
      throw error;
    }
    return json({ id: key });
  }
  if (route === 'profile' && method === 'PATCH') {
    const input = profileInput.parse(await readJson(req));
    dbCheck((await db.from('profiles').update({ ...input, updated_at: new Date().toISOString() }).eq('user_id', user.id)).error);
    return json({ ok: true });
  }
  if (route === 'profile-photo' && method === 'DELETE') {
    dbCheck((await admin.rpc('change_photo', { p_user: user.id, p_path: null })).error); return json({ ok: true });
  }
  if (route === 'garments' && id && (method === 'PATCH' || method === 'DELETE')) {
    z.string().uuid().parse(id);
    const input = method === 'PATCH' ? garmentInput.parse(await readJson(req)) : {};
    dbCheck((await admin.rpc('change_garment', { p_user: user.id, p_id: id, p_data: input, p_delete: method === 'DELETE' })).error);
    return json({ ok: true });
  }
  if (route === 'suggestions' && method === 'POST') {
    if (!process.env.RENDER_PROCESSOR_URL) throw new HttpError(503, 'Falta activar el procesador gratuito del armario.');
    const input = suggestionInput.parse(await readJson(req));
    const { data, error } = await db.from('garments').select('id').eq('status', 'ready').eq('available', true).is('deleted_at', null); dbCheck(error);
    if (!data?.length) throw new HttpError(400, 'Sube y confirma al menos una prenda disponible para recibir ideas.');
    const job = await admin.rpc('enqueue_job', { p_user: user.id, p_kind: 'suggest', p_key: requestKey(req), p_payload: input }); dbCheck(job.error);
    return json({ job: { id: job.data.id, status: job.data.status } }, 202);
  }
  if (route === 'outfits' && method === 'POST') {
    const input = outfitInput.parse(await readJson(req));
    const g = await db.from('garments').select('*').is('deleted_at', null); dbCheck(g.error);
    let valid; try { valid = validateOutfit(input, g.data as Garment[]); } catch (e) { throw new HttpError(400, (e as Error).message); }
    const saved = await db.from('outfits').insert({ ...valid, user_id: user.id }).select('id').single(); dbCheck(saved.error);
    return json(saved.data, 201);
  }
  if (route === 'outfits' && id && method === 'PATCH') {
    z.string().uuid().parse(id); const { favorite } = z.object({ favorite: z.boolean() }).parse(await readJson(req));
    const result = await db.from('outfits').update({ favorite }).eq('id', id).select('id').single(); dbCheck(result.error); return json({ ok: true });
  }
  if (route === 'render' && method === 'POST') {
    if (!process.env.RENDER_PROCESSOR_URL) throw new HttpError(503, 'Falta activar el procesador gratuito del armario.');
    const { outfit_id } = z.object({ outfit_id: z.string().uuid() }).parse(await readJson(req));
    const [p, o, g] = await Promise.all([db.from('profiles').select('*').single(), db.from('outfits').select('*').eq('id', outfit_id).single(), db.from('garments').select('*').is('deleted_at', null)]);
    [p, o, g].forEach(r => dbCheck(r.error));
    let cacheKey; try { cacheKey = renderKey(p.data as Profile, o.data as Outfit, g.data as Garment[]); } catch (e) { throw new HttpError(400, (e as Error).message); }
    const existing = await db.from('simulations').select('id').eq('cache_key', cacheKey).maybeSingle(); dbCheck(existing.error);
    if (existing.data) return json({ cached: true, simulation_id: existing.data.id });
    const job = await admin.rpc('enqueue_job', { p_user: user.id, p_kind: 'render', p_key: requestKey(req), p_render_key: cacheKey, p_payload: { outfit_id, cache_key: cacheKey } }); dbCheck(job.error);
    if (job.data.status === 'uncertain') throw new HttpError(409, 'El resultado anterior es incierto. Revisa el panel de procesos antes de solicitar otra imagen.');
    return json({ job: { id: job.data.id, status: job.data.status } }, 202);
  }
  if (route === 'simulations' && id && method === 'DELETE') {
    z.string().uuid().parse(id);
    dbCheck((await admin.rpc('delete_simulation', { p_user: user.id, p_id: id })).error); return json({ ok: true });
  }
  if (route === 'events' && (method === 'POST' || method === 'PATCH')) {
    const input = eventInput.parse(await readJson(req));
    if (input.outfit_id) {
      const o = await db.from('outfits').select('id').eq('id', input.outfit_id).maybeSingle(); dbCheck(o.error);
      if (!o.data) throw new HttpError(400, 'El conjunto seleccionado no existe.');
    }
    const query = method === 'POST'
      ? db.from('agenda_events').insert({ ...input, id: requestKey(req), user_id: user.id })
      : db.from('agenda_events').update(input).eq('id', z.string().uuid().parse(id));
    const r = await query.select('id').single();
    if (method === 'POST' && r.error?.code === '23505') return json({ ok: true });
    dbCheck(r.error); return json(r.data);
  }
  if (route === 'events' && id && method === 'DELETE') {
    dbCheck((await db.from('agenda_events').delete().eq('id', z.string().uuid().parse(id))).error); return json({ ok: true });
  }
  if (route === 'jobs' && id && method === 'GET') {
    const r = await db.from('ai_jobs').select('id,kind,status,error,result,created_at').eq('id', z.string().uuid().parse(id)).single(); dbCheck(r.error); return json(r.data);
  }
  if (route === 'jobs' && id && path[2] === 'retry-cleanup' && method === 'POST') {
    const job = await db.from('ai_jobs').select('kind,status').eq('id', z.string().uuid().parse(id)).single(); dbCheck(job.error);
    if (job.data?.kind !== 'cleanup' || job.data.status !== 'failed') throw new HttpError(400, 'Solo puedes reintentar una eliminación fallida.');
    dbCheck((await admin.from('ai_jobs').update({ status: 'queued', attempts: 0, error: null }).eq('id', id).eq('user_id', user.id).eq('status', 'failed')).error);
    return json({ ok: true });
  }
  throw new HttpError(404, 'Esta operación no existe.');
}
async function handle(req: Request, ctx: Context) { try { return await dispatch(req, ctx); } catch (error) { return errorResponse(error); } }
export { handle as GET, handle as POST, handle as PATCH, handle as DELETE };
