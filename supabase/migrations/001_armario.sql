-- Apply once in a new Supabase project. All application objects are owner-private.
create table public.app_owner (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null unique references auth.users(id)
);
alter table public.app_owner enable row level security;
create policy owner_identity_read on public.app_owner for select to authenticated
using (user_id = (select auth.uid()));
grant select on public.app_owner to authenticated;
create function public.is_armario_owner() returns boolean language sql stable security invoker
set search_path = public as $$ select exists(select 1 from public.app_owner where user_id = auth.uid()) $$;
revoke all on function public.is_armario_owner() from public,anon,authenticated;
grant execute on function public.is_armario_owner() to authenticated;

create table public.profiles (
  user_id uuid primary key references auth.users(id), display_name text not null default 'Mi armario',
  styles text[] not null default '{}', favorite_colors text[] not null default '{}',
  work_formality integer not null default 3 check (work_formality between 1 and 5),
  monthly_image_limit integer not null default 30 check (monthly_image_limit between 0 and 1000),
  photo_path text, photo_version integer not null default 0,
  updated_at timestamptz not null default now()
);
create table public.garments (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(user_id),
  name text not null, category text not null default 'superior' check (category in ('superior','inferior','vestido','abrigo','calzado','bolso','accesorio')),
  colors text[] not null default '{}', pattern text not null default 'Por revisar',
  formality integer not null default 3 check (formality between 1 and 5), available boolean not null default true,
  status text not null default 'processing' check (status in ('processing','review','ready','error')),
  photo_path text not null, thumbnail_path text not null, version integer not null default 1,
  deleted_at timestamptz, created_at timestamptz not null default now()
);
create table public.outfits (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(user_id),
  title text not null, explanation text not null, occasion text not null check (occasion in ('trabajo','cita','evento','noche','casual')),
  garment_ids uuid[] not null, missing text[] not null default '{}', favorite boolean not null default false,
  created_at timestamptz not null default now(), unique(id,user_id)
);
create table public.agenda_events (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(user_id),
  date date not null, occasion text not null check (occasion in ('trabajo','cita','evento','noche','casual')),
  notes text not null default '', outfit_id uuid,
  foreign key (outfit_id,user_id) references public.outfits(id,user_id)
);
create table public.ai_jobs (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(user_id),
  kind text not null check (kind in ('analyze','suggest','render','cleanup')),
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','uncertain','cancelled')),
  request_key text not null, render_key text, payload jsonb not null default '{}', result jsonb, error text,
  created_at timestamptz not null default now(), started_at timestamptz, finished_at timestamptz, attempts integer not null default 0,
  unique(user_id,kind,request_key)
);
create unique index unique_render_request on public.ai_jobs(user_id,render_key)
where kind = 'render' and status not in ('failed','cancelled');
create index job_queue on public.ai_jobs(created_at) where status = 'queued';
create table public.simulations (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(user_id),
  outfit_id uuid not null, cache_key text not null, image_path text not null,
  photo_version integer not null, created_at timestamptz not null default now(),
  foreign key(outfit_id,user_id) references public.outfits(id,user_id), unique(user_id,cache_key)
);

-- No anonymous access. Queue changes and simulations are restricted to server functions.
do $$ declare t text; begin
  foreach t in array array['profiles','garments','outfits','agenda_events','ai_jobs','simulations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_read on public.%I for select to authenticated using (user_id = auth.uid() and public.is_armario_owner())', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  foreach t in array array['profiles','garments','outfits','agenda_events'] loop
    execute format('create policy owner_write on public.%I for all to authenticated using (user_id = auth.uid() and public.is_armario_owner()) with check (user_id = auth.uid() and public.is_armario_owner())', t);
    execute format('grant insert,update,delete on public.%I to authenticated', t);
  end loop;
end $$;
grant all on public.app_owner,public.profiles,public.garments,public.outfits,public.agenda_events,public.ai_jobs,public.simulations to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('wardrobe','wardrobe',false,10485760,array['image/jpeg','image/png','image/webp']);
create policy wardrobe_read on storage.objects for select to authenticated
using (bucket_id = 'wardrobe' and (storage.foldername(name))[1] = auth.uid()::text and public.is_armario_owner());
-- Upload/removal are server-side after authenticated ownership checks, avoiding arbitrary object edits.

create function public.enqueue_job(p_user uuid,p_kind text,p_key text,p_payload jsonb,p_render_key text default null)
returns public.ai_jobs language plpgsql security definer set search_path = public as $$
declare j public.ai_jobs; lim integer; used integer;
begin
  if not exists(select 1 from app_owner where user_id = p_user) then raise exception 'OWNER_ONLY'; end if;
  perform pg_advisory_xact_lock(hashtext(p_user::text));
  select * into j from ai_jobs where user_id=p_user and kind=p_kind and request_key=p_key;
  if found then return j; end if;
  if p_kind = 'render' then
    select * into j from ai_jobs where user_id=p_user and render_key=p_render_key and status not in ('failed','cancelled');
    if found then return j; end if;
    select monthly_image_limit into lim from profiles where user_id=p_user for share;
    select count(*) into used from ai_jobs where user_id=p_user and kind='render'
      and created_at >= (date_trunc('month', now() at time zone 'America/Lima') at time zone 'America/Lima');
    if used >= lim then raise exception 'MONTHLY_LIMIT'; end if;
  end if;
  if p_kind <> 'cleanup' and (select count(*) from ai_jobs where user_id=p_user and status in ('queued','running') and kind <> 'cleanup') >= 40 then
    raise exception 'QUEUE_FULL';
  end if;
  insert into ai_jobs(user_id,kind,request_key,payload,render_key) values(p_user,p_kind,p_key,p_payload,p_render_key) returning * into j;
  return j;
end $$;

create function public.register_garment(p_user uuid,p_id uuid,p_name text,p_photo text,p_thumb text)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  if not exists(select 1 from app_owner where user_id=p_user) then raise exception 'OWNER_ONLY'; end if;
  insert into garments(id,user_id,name,photo_path,thumbnail_path) values(p_id,p_user,p_name,p_photo,p_thumb);
  perform enqueue_job(p_user,'analyze',p_id::text,jsonb_build_object('garment_id',p_id));
  return p_id;
end $$;

create function public.claim_job(p_user uuid default null) returns setof public.ai_jobs language plpgsql security definer set search_path = public as $$
begin
  -- A charged request may have succeeded upstream. Never retry an expired generation.
  update ai_jobs set status=case when kind='render' then 'uncertain' when kind='cleanup' and attempts<3 then 'queued' else 'failed' end,
    error='El proceso se interrumpió. Revisa el resultado antes de solicitar otra operación.',finished_at=now()
    where status='running' and started_at < now()-interval '15 minutes' and (p_user is null or user_id=p_user);
  return query update ai_jobs set status='running',started_at=now(),attempts=attempts+1
    where id=(select id from ai_jobs where status='queued' and (p_user is null or user_id=p_user) order by created_at for update skip locked limit 1)
    returning *;
end $$;

-- Invalidate images and cancel in-flight work atomically when the source is removed/changed.
create function public.retire_images(p_user uuid,p_garment uuid default null) returns void
language plpgsql security definer set search_path=public as $$
declare paths jsonb;
begin
  select coalesce(jsonb_agg(s.image_path),'[]') into paths from simulations s
    join outfits o on o.id=s.outfit_id where s.user_id=p_user and (p_garment is null or p_garment=any(o.garment_ids));
  delete from simulations s using outfits o where s.outfit_id=o.id and s.user_id=p_user
    and (p_garment is null or p_garment=any(o.garment_ids));
  update ai_jobs j set status='cancelled',finished_at=now(),error='Las fotos o prendas del conjunto cambiaron.'
    where j.user_id=p_user and j.kind='render' and j.status in ('queued','running','succeeded','uncertain')
    and (p_garment is null or exists(select 1 from outfits o where o.id::text=j.payload->>'outfit_id' and p_garment=any(o.garment_ids)));
  if jsonb_array_length(paths)>0 then
    perform enqueue_job(p_user,'cleanup',gen_random_uuid()::text,jsonb_build_object('paths',paths));
  end if;
end $$;

create function public.change_photo(p_user uuid,p_path text) returns void
language plpgsql security definer set search_path=public as $$
declare old_path text;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));
  select photo_path into old_path from profiles where user_id=p_user for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if old_path is not distinct from p_path then return; end if;
  perform retire_images(p_user);
  update profiles set photo_path=p_path,photo_version=photo_version+1,updated_at=now() where user_id=p_user;
  if old_path is not null then perform enqueue_job(p_user,'cleanup',gen_random_uuid()::text,jsonb_build_object('paths',jsonb_build_array(old_path))); end if;
end $$;

create function public.change_garment(p_user uuid,p_id uuid,p_data jsonb,p_delete boolean default false) returns void
language plpgsql security definer set search_path=public as $$
declare g public.garments;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));
  select * into g from garments where id=p_id and user_id=p_user and deleted_at is null for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  perform retire_images(p_user,p_id);
  if p_delete then
    update garments set deleted_at=now(),available=false,version=version+1 where id=p_id;
    update ai_jobs set status='cancelled',finished_at=now() where user_id=p_user and kind='analyze'
      and payload->>'garment_id'=p_id::text and status in ('queued','running');
    perform enqueue_job(p_user,'cleanup',gen_random_uuid()::text,jsonb_build_object('paths',jsonb_build_array(g.photo_path,g.thumbnail_path)));
  else
    update garments set name=p_data->>'name',category=p_data->>'category',
      colors=array(select jsonb_array_elements_text(p_data->'colors')),pattern=p_data->>'pattern',
      formality=(p_data->>'formality')::integer,available=(p_data->>'available')::boolean,
      status=p_data->>'status',version=version+1 where id=p_id;
    update ai_jobs set status='cancelled',finished_at=now() where user_id=p_user and kind='analyze'
      and payload->>'garment_id'=p_id::text and status in ('queued','running');
  end if;
end $$;

create function public.complete_render(p_job uuid,p_path text,p_photo_version integer,p_versions jsonb) returns uuid
language plpgsql security definer set search_path=public as $$
declare j public.ai_jobs; o public.outfits; sim uuid; pair record;
begin
  select * into j from ai_jobs where id=p_job;
  if not found then raise exception 'CANCELLED'; end if;
  perform pg_advisory_xact_lock(hashtext(j.user_id::text));
  select * into j from ai_jobs where id=p_job and status='running' for update;
  if not found then raise exception 'CANCELLED'; end if;
  perform 1 from profiles where user_id=j.user_id and photo_version=p_photo_version and photo_path is not null for update;
  if not found then raise exception 'STALE_PHOTO'; end if;
  select * into o from outfits where id=(j.payload->>'outfit_id')::uuid and user_id=j.user_id;
  if not found or cardinality(o.garment_ids)<>jsonb_object_length_compat(p_versions) then raise exception 'STALE_OUTFIT'; end if;
  for pair in select key,value from jsonb_each_text(p_versions) loop
    perform 1 from garments where id=pair.key::uuid and user_id=j.user_id and id=any(o.garment_ids)
      and version=pair.value::integer and deleted_at is null and available and status='ready' for update;
    if not found then raise exception 'STALE_GARMENT'; end if;
  end loop;
  insert into simulations(user_id,outfit_id,cache_key,image_path,photo_version)
    values(j.user_id,o.id,j.render_key,p_path,p_photo_version) returning id into sim;
  update ai_jobs set status='succeeded',result=jsonb_build_object('simulation_id',sim),finished_at=now() where id=p_job;
  return sim;
end $$;

-- PostgreSQL has no jsonb_object_length; this tiny immutable helper keeps version validation explicit.
create function public.jsonb_object_length_compat(v jsonb) returns integer language sql immutable
set search_path=public as $$ select count(*)::integer from jsonb_object_keys(v) $$;

create function public.delete_simulation(p_user uuid,p_id uuid) returns void language plpgsql security definer set search_path=public as $$
declare s public.simulations;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));
  select * into s from simulations where id=p_id and user_id=p_user for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  delete from simulations where id=p_id;
  update ai_jobs set status='cancelled' where user_id=p_user and render_key=s.cache_key and kind='render';
  perform enqueue_job(p_user,'cleanup',gen_random_uuid()::text,jsonb_build_object('paths',jsonb_build_array(s.image_path)));
end $$;

create function public.complete_analysis(p_job uuid,p_data jsonb) returns void language plpgsql security definer set search_path=public as $$
declare j public.ai_jobs;
begin
  select * into j from ai_jobs where id=p_job;
  if not found then raise exception 'CANCELLED'; end if;
  perform pg_advisory_xact_lock(hashtext(j.user_id::text));
  select * into j from ai_jobs where id=p_job and status='running' for update;
  if not found then raise exception 'CANCELLED'; end if;
  update garments set name=p_data->>'name',category=p_data->>'category',
    colors=array(select jsonb_array_elements_text(p_data->'colors')),pattern=p_data->>'pattern',
    formality=(p_data->>'formality')::integer,status='review'
    where id=(j.payload->>'garment_id')::uuid and user_id=j.user_id and deleted_at is null and status='processing';
  if not found then raise exception 'CANCELLED'; end if;
  update ai_jobs set status='succeeded',finished_at=now() where id=p_job;
end $$;

create function public.complete_suggestions(p_job uuid,p_outfits jsonb) returns void language plpgsql security definer set search_path=public as $$
declare j public.ai_jobs; item jsonb; ids uuid[]; inserted uuid; saved uuid[] := '{}';
begin
  select * into j from ai_jobs where id=p_job;
  if not found then raise exception 'CANCELLED'; end if;
  perform pg_advisory_xact_lock(hashtext(j.user_id::text));
  select * into j from ai_jobs where id=p_job and status='running' for update;
  if not found then raise exception 'CANCELLED'; end if;
  for item in select value from jsonb_array_elements(p_outfits) loop
    ids := array(select value::uuid from jsonb_array_elements_text(item->'garment_ids'));
    if cardinality(ids)=0 or cardinality(ids)<>(select count(*) from garments where user_id=j.user_id and id=any(ids)
        and available and status='ready' and deleted_at is null) then raise exception 'STALE_GARMENT'; end if;
    insert into outfits(user_id,title,explanation,occasion,garment_ids,missing)
      values(j.user_id,item->>'title',item->>'explanation',item->>'occasion',ids,array(select jsonb_array_elements_text(item->'missing')))
      returning id into inserted;
    saved := array_append(saved,inserted);
  end loop;
  update ai_jobs set status='succeeded',result=jsonb_build_object('outfit_ids',saved),finished_at=now() where id=p_job;
end $$;

-- Default function privileges can differ across Supabase projects; revoke every sensitive RPC explicitly.
revoke all on function public.enqueue_job(uuid,text,text,jsonb,text) from public,anon,authenticated;
revoke all on function public.register_garment(uuid,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.claim_job(uuid) from public,anon,authenticated;
revoke all on function public.retire_images(uuid,uuid) from public,anon,authenticated;
revoke all on function public.change_photo(uuid,text) from public,anon,authenticated;
revoke all on function public.change_garment(uuid,uuid,jsonb,boolean) from public,anon,authenticated;
revoke all on function public.complete_render(uuid,text,integer,jsonb) from public,anon,authenticated;
revoke all on function public.delete_simulation(uuid,uuid) from public,anon,authenticated;
revoke all on function public.complete_analysis(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.complete_suggestions(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.enqueue_job(uuid,text,text,jsonb,text),public.register_garment(uuid,uuid,text,text,text),
  public.claim_job(uuid),public.retire_images(uuid,uuid),public.change_photo(uuid,text),public.change_garment(uuid,uuid,jsonb,boolean),
  public.complete_render(uuid,text,integer,jsonb),public.delete_simulation(uuid,uuid),public.complete_analysis(uuid,jsonb),public.complete_suggestions(uuid,jsonb) to service_role;

