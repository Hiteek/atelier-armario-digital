import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from 'vitest';
const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const stranger = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const item = '00000000-0000-4000-8000-000000000001';
const outfit = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let db: PGlite;
async function query<T>(sql: string, args: unknown[] = []) { return (await db.query<T>(sql, args)).rows; }
async function enqueue(kind: string, key: string, payload = {}, render = 'cache-one') {
  return (await query<{ id: string; status: string }>('select * from enqueue_job($1,$2,$3,$4,$5)', [owner, kind, key, payload, kind === 'render' ? render : null]))[0];
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.user',true),'')::uuid $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
    alter table storage.objects enable row level security;
    create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1,'/') $$;
    grant usage on schema public,auth,storage to authenticated,anon,service_role;
    grant select on storage.objects to authenticated;
    alter default privileges in schema public grant execute on functions to anon,authenticated;
  `);
  await db.exec(await readFile(new URL('../supabase/migrations/001_armario.sql', import.meta.url), 'utf8'));
  await db.exec(`insert into auth.users values('${owner}'),('${stranger}');
    insert into app_owner(user_id) values('${owner}');
    insert into profiles(user_id,photo_path,photo_version) values('${owner}','${owner}/profile/photo.jpg',1);
    insert into garments(id,user_id,name,category,colors,status,photo_path,thumbnail_path) values('${item}','${owner}','Camisa','superior','{crema}','ready','${owner}/garment/photo.jpg','${owner}/garment/thumb.webp');
    insert into outfits(id,user_id,title,explanation,occasion,garment_ids) values('${outfit}','${owner}','Conjunto','Prueba','trabajo','{${item}}');
    insert into storage.objects(bucket_id,name) values('wardrobe','${owner}/garment/photo.jpg');`);
}, 30000);
beforeEach(async () => { await db.exec('begin'); });
afterEach(async () => { await db.exec('rollback'); });
afterAll(async () => { await db.close(); });

describe('Base de datos PostgreSQL, RLS y cola', () => {
  it('revoca el permiso anónimo heredado y comprueba al propietario sin privilegios elevados', async () => {
    expect((await query<{ allowed: boolean }>("select has_function_privilege('anon','public.is_armario_owner()','EXECUTE') as allowed"))[0].allowed).toBe(false);
    expect((await query<{ definer: boolean }>("select prosecdef as definer from pg_proc where oid='public.is_armario_owner()'::regprocedure"))[0].definer).toBe(false);
    await db.exec(`set role authenticated; set "app.user"='${owner}';`);
    expect((await query<{ allowed: boolean }>('select is_armario_owner() as allowed'))[0].allowed).toBe(true);
    expect(await query('select user_id from app_owner')).toEqual([{ user_id: owner }]);
    await db.exec(`set "app.user"='${stranger}'`);
    expect(await query('select user_id from app_owner')).toEqual([]);
    expect((await query<{ allowed: boolean }>('select is_armario_owner() as allowed'))[0].allowed).toBe(false);
  });
  it('registra 30 prendas, permite revisión y filtra por categoría y color', async () => {
    for (let n = 10; n < 40; n++) {
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
      await query('select register_garment($1,$2,$3,$4,$5)', [owner, id, `Prenda ${n}`, `${owner}/garment/${id}.jpg`, `${owner}/garment/${id}.webp`]);
      await query('select change_garment($1,$2,$3,false)', [owner, id, { name: `Prenda ${n}`, category: n % 2 ? 'calzado' : 'superior', colors: ['negro'], pattern: 'Liso', formality: 3, available: true, status: 'ready' }]);
    }
    expect(await query("select id from garments where status='ready' and colors @> '{negro}'")).toHaveLength(30);
    expect(await query("select id from garments where category='calzado' and colors @> '{negro}'")).toHaveLength(15);
  });
  it('el propietario ve sus prendas y un segundo usuario no ve datos ni fotos', async () => {
    await db.exec(`set role authenticated; set "app.user"='${owner}';`);
    expect((await query('select * from garments')).length).toBe(1);
    expect((await query('select * from storage.objects')).length).toBe(1);
    await db.exec(`set "app.user"='${stranger}'`);
    for (const table of ['profiles','garments','outfits','agenda_events','ai_jobs','simulations','storage.objects']) expect(await query(`select * from ${table}`)).toEqual([]);
    expect((await query<{ is_armario_owner: boolean }>('select is_armario_owner()'))[0].is_armario_owner).toBe(false);
  });
  it('bloquea al segundo usuario al escribir y al llamar RPC privilegiados', async () => {
    await db.exec(`set role authenticated; set "app.user"='${stranger}';`);
    await expect(query('select enqueue_job($1,\'render\',\'key\',\'{}\',\'cache\')', [owner])).rejects.toThrow(/permission denied/);
  });
  it('bloquea escrituras directas en la cola aun para el propietario', async () => {
    await db.exec(`set role authenticated; set "app.user"='${owner}';`);
    await expect(query('insert into ai_jobs(user_id,kind,request_key) values($1,\'render\',\'key\')', [owner])).rejects.toThrow();
  });
  it('deduplica doble pulsación y reserva una sola solicitud de imagen', async () => {
    const a = await enqueue('render', 'first', { outfit_id: outfit });
    const b = await enqueue('render', 'second', { outfit_id: outfit });
    expect(a.id).toBe(b.id);
    expect((await query<{ n: number }>("select count(*)::integer n from ai_jobs where kind='render'"))[0].n).toBe(1);
  });
  it('aplica el límite mensual incluyendo solicitudes fallidas y canceladas', async () => {
    await db.exec('update profiles set monthly_image_limit=1');
    const j = await enqueue('render', 'first');
    await query("update ai_jobs set status='failed' where id=$1", [j.id]);
    await expect(enqueue('render', 'second', {}, 'different')).rejects.toThrow(/MONTHLY_LIMIT/);
  });
  it('no vuelve a ejecutar un render expirado o incierto', async () => {
    const j = await enqueue('render', 'first');
    expect((await query<{ id: string }>('select * from claim_job()'))[0].id).toBe(j.id);
    await query("update ai_jobs set started_at=now()-interval '20 minutes' where id=$1", [j.id]);
    expect(await query('select * from claim_job()')).toEqual([]);
    expect((await query<{ status: string }>('select status from ai_jobs where id=$1', [j.id]))[0].status).toBe('uncertain');
    expect((await enqueue('render', 'second')).id).toBe(j.id);
  });
  it('la función de Vercel solo reclama trabajos de su propietario', async () => {
    await query('insert into profiles(user_id) values($1)', [stranger]);
    await query('insert into ai_jobs(user_id,kind,request_key) values($1,\'analyze\',\'other-owner\')', [stranger]);
    const ownerJob = await enqueue('analyze', 'owner-job');
    const claimed = await query<{ id: string }>('select * from claim_job($1)', [owner]);
    expect(claimed[0].id).toBe(ownerJob.id);
    expect(await query('select * from claim_job($1)', [owner])).toEqual([]);
    expect((await query<{ status: string }>("select status from ai_jobs where request_key='other-owner'"))[0].status).toBe('queued');
  });
  it('permite retirar archivos aunque la cola de análisis esté llena', async () => {
    for (let i = 0; i < 40; i++) await enqueue('analyze', `analyze-${i}`);
    expect((await enqueue('cleanup', 'cleanup', { paths: [`${owner}/photo.jpg`] })).status).toBe('queued');
  });
  it('guarda el resultado y retira las simulaciones al cambiar la foto', async () => {
    const j = await enqueue('render', 'render', { outfit_id: outfit });
    await query('select * from claim_job()');
    const imagePath = `${owner}/simulations/test.png`;
    await query('select complete_render($1,$2,1,$3)', [j.id, imagePath, { [item]: 1 }]);
    expect((await query('select * from simulations')).length).toBe(1);
    await query('select change_photo($1,$2)', [owner, `${owner}/profile/new.jpg`]);
    expect(await query('select * from simulations')).toEqual([]);
    const cleanup = await query<{ payload: { paths: string[] } }>("select payload from ai_jobs where kind='cleanup'");
    expect(cleanup.flatMap(j => j.payload.paths)).toContain(imagePath);
  });
  it('no publica una imagen si la prenda fue retirada durante la generación', async () => {
    const j = await enqueue('render', 'render', { outfit_id: outfit }); await query('select * from claim_job()');
    await query('select change_garment($1,$2,\'{}\',true)', [owner, item]);
    await expect(query('select complete_render($1,$2,1,$3)', [j.id, `${owner}/simulations/test.png`, { [item]: 1 }])).rejects.toThrow(/CANCELLED/);
  });
  it('permite siete días y dos ocasiones el mismo día; editar una no modifica las demás', async () => {
    for (let day = 14; day <= 20; day++) await query('insert into agenda_events(user_id,date,occasion) values($1,$2,\'trabajo\')', [owner, `2026-10-${day}`]);
    await query('insert into agenda_events(user_id,date,occasion,notes) values($1,\'2026-10-14\',\'cita\',\'Cena\')', [owner]);
    await query("update agenda_events set outfit_id=$1 where occasion='cita'", [outfit]);
    const rows = await query<{ occasion: string; outfit_id: string | null }>('select occasion,outfit_id from agenda_events');
    expect(rows).toHaveLength(8); expect(rows.filter(r => r.outfit_id)).toHaveLength(1);
  });
  it('solo acepta resultados de recomendaciones con prendas disponibles', async () => {
    const j = await enqueue('suggest', 'suggest'); await query('select * from claim_job()');
    await query('update garments set available=false where id=$1', [item]);
    await expect(query('select complete_suggestions($1,$2)', [j.id, [{ title: 'Inventado', explanation: 'Prueba', occasion: 'cita', garment_ids: [item], missing: [] }]])).rejects.toThrow(/STALE_GARMENT/);
  });
});

