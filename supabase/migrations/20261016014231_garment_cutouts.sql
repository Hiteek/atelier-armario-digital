-- Additive: originals and existing classifications remain untouched.
alter table public.garments add column cutout_path text;
alter table public.garments add column cutout_thumbnail_path text;
alter table public.garments add constraint cutout_pair check ((cutout_path is null) = (cutout_thumbnail_path is null));

create function public.set_garment_cutout(p_user uuid,p_id uuid,p_version integer,p_path text,p_thumb text)
returns void language plpgsql security invoker set search_path=public as $$
declare g public.garments; prefix text;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));
  select * into g from garments where id=p_id and user_id=p_user and deleted_at is null for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if (p_path is null) <> (p_thumb is null) then raise exception 'INVALID_PATH'; end if;
  if p_path is not null then
    prefix := p_user::text || '/cutouts/' || p_id::text || '/';
    if not starts_with(p_path,prefix) or right(p_path,11) <> '/photo.webp'
      or p_thumb <> left(p_path,length(p_path)-11) || '/thumb.webp' then raise exception 'INVALID_PATH'; end if;
  end if;
  if g.cutout_path is not distinct from p_path then return; end if;
  if g.version <> p_version then raise exception 'SOURCE_CHANGED'; end if;
  -- A cutout is a presentation change of the same garment. Keep completed images.
  -- Cancel only work using a superseded reference; no automatic regeneration.
  update ai_jobs j set status='cancelled',finished_at=now(),error='La foto de referencia cambió.'
    where j.user_id=p_user and j.kind='render' and j.status in ('queued','running')
    and exists(select 1 from outfits o where o.id::text=j.payload->>'outfit_id' and p_id=any(o.garment_ids));
  update garments set cutout_path=p_path,cutout_thumbnail_path=p_thumb,version=version+1 where id=p_id;
  if g.cutout_path is not null then
    perform enqueue_job(p_user,'cleanup',gen_random_uuid()::text,jsonb_build_object('paths',jsonb_build_array(g.cutout_path,g.cutout_thumbnail_path)));
  end if;
end $$;
revoke all on function public.set_garment_cutout(uuid,uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.set_garment_cutout(uuid,uuid,integer,text,text) to service_role;

-- Retiring a garment also removes its derived assets through the persistent queue.
create function public.retire_garment_cutout() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  if old.deleted_at is null and new.deleted_at is not null and old.cutout_path is not null then
    perform enqueue_job(old.user_id,'cleanup',gen_random_uuid()::text,jsonb_build_object('paths',jsonb_build_array(old.cutout_path,old.cutout_thumbnail_path)));
    new.cutout_path := null; new.cutout_thumbnail_path := null;
  end if;
  return new;
end $$;
revoke all on function public.retire_garment_cutout() from public,anon,authenticated;
create trigger retire_garment_cutout before update of deleted_at on public.garments
for each row execute function public.retire_garment_cutout();
