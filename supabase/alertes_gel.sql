-- =============================================================================
-- SAM — alertes gel (notification sur le téléphone et mail)
-- -----------------------------------------------------------------------------
-- À coller dans Supabase > SQL Editor > New query, puis Run (relançable).
-- À exécuter après conseillers.sql. Exécuté le 23/11/2026.
--
-- Chaque compte règle ses alertes dans Mon profil > Alertes gel : station, seuil (°C),
-- alerte du soir (prévision de la nuit) et/ou alerte sur mesure, mail et/ou notification.
-- Un producteur suit une station ; conseillers, admins et full admins, plusieurs.
--   - Mesure : vérifiée 1 minute après chaque intégration Comsag (toutes les 5 minutes) ;
--     l'alerte part dès qu'une mesure reçue est sous le seuil, une fois par 12 heures au plus.
--   - Prévision : chaque soir à 17 h UTC (18 h en hiver), minimum prévu jusqu'au lendemain 10 h.
-- L'envoi est fait par la fonction Supabase « sam-alertes » (notifications Web Push, mails Brevo).
-- Les clés (clé des tâches automatiques, clés des notifications) sont créées et gardées dans
-- sam_private.reglages, jamais affichées ; seule la clé publique des notifications sort
-- (fonction sam_notifications_cle). Mails : secret BREVO_CLE de la fonction (Supabase >
-- Edge Functions > Secrets) et adresse d'envoi dans sam_private.reglages (mail_expediteur).
-- =============================================================================

-- 1. Alertes de chaque compte
create table if not exists public.alertes_gel (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  station_id text not null references public.stations(id) on delete cascade,
  seuil real not null default 0 check (seuil between -15 and 10),
  prevision boolean not null default true,
  mesure boolean not null default true,
  par_mail boolean not null default true,
  par_notification boolean not null default true,
  actif boolean not null default true,
  derniere_alerte_mesure timestamptz,
  derniere_alerte_prevision date,
  cree_le timestamptz not null default now(),
  unique (user_id, station_id)
);
create index if not exists alertes_gel_station_idx on public.alertes_gel (station_id);
alter table public.alertes_gel enable row level security;
drop policy if exists alertes_gel_lecture on public.alertes_gel;
create policy alertes_gel_lecture on public.alertes_gel
  for select to authenticated using (user_id = (select auth.uid()) or (select public.is_sam_full_admin()));
drop policy if exists alertes_gel_ajout on public.alertes_gel;
create policy alertes_gel_ajout on public.alertes_gel
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.sam_acces_stations() a where a.station_id = alertes_gel.station_id and a.meteo)
  );
drop policy if exists alertes_gel_modif on public.alertes_gel;
create policy alertes_gel_modif on public.alertes_gel
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists alertes_gel_retrait on public.alertes_gel;
create policy alertes_gel_retrait on public.alertes_gel
  for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.alertes_gel from anon;
grant select, insert, update, delete on public.alertes_gel to authenticated;

-- Un producteur (rôle normal) suit une station ; plusieurs pour les autres rôles.
create or replace function sam_private.alertes_gel_limite()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.sam_role() = 'normal'
     and exists (select 1 from public.alertes_gel g where g.user_id = new.user_id and g.station_id <> new.station_id) then
    raise exception 'Un compte producteur suit le gel d''une station. Pour plusieurs stations, demandez le rôle Conseiller.';
  end if;
  return new;
end;
$$;
drop trigger if exists alertes_gel_limite on public.alertes_gel;
create trigger alertes_gel_limite before insert on public.alertes_gel
  for each row execute function sam_private.alertes_gel_limite();

-- 2. Appareils abonnés aux notifications (un par navigateur ou téléphone)
create table if not exists public.notifications_push (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  appareil text,
  cree_le timestamptz not null default now(),
  primary key (user_id, endpoint)
);
alter table public.notifications_push enable row level security;
drop policy if exists notifications_push_moi on public.notifications_push;
create policy notifications_push_moi on public.notifications_push
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.notifications_push from anon;
grant select, insert, update, delete on public.notifications_push to authenticated;

-- 3. Droit de voir la température d'une station, pour un compte donné (comme sam_acces_stations)
create or replace function sam_private.voit_meteo(p_user uuid, p_station text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.stations s
    where s.id = p_station
      and (s.publique or s.acces_meteo = 'tous'
        or exists (select 1 from public.station_acces x where x.station_id = s.id and x.user_id = p_user and x.meteo)
        or exists (select 1 from auth.users u join public.sam_admins a on a.email = lower(u.email) where u.id = p_user))
  );
$$;

-- 4. Listes lues par la fonction sam-alertes (réservées au service)
create or replace function public.sam_alertes_gel_mesures()
returns table (alerte_id uuid, user_id uuid, email text, station_id text, station_nom text, seuil real,
               t_air real, mesure_le timestamptz, par_mail boolean, par_notification boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.user_id, u.email::text, s.id, s.nom, a.seuil, m.t_air, m.mesure_le, a.par_mail, a.par_notification
  from public.alertes_gel a
  join auth.users u on u.id = a.user_id and (u.banned_until is null or u.banned_until < now())
  join public.stations s on s.id = a.station_id and s.active and s.installee and not ('t1' = any (s.capteurs_masques))
  cross join lateral (
    select x.t_air, x.mesure_le from public.station_mesures x
    where x.station_id = s.id and x.t_air is not null and x.mesure_le > now() - interval '3 hours'
    order by x.mesure_le desc limit 1
  ) m
  where a.actif and a.mesure and (a.par_mail or a.par_notification)
    and m.t_air <= a.seuil
    and (a.derniere_alerte_mesure is null or a.derniere_alerte_mesure < now() - interval '12 hours')
    and sam_private.voit_meteo(a.user_id, s.id);
$$;

create or replace function public.sam_alertes_gel_prevision()
returns table (alerte_id uuid, user_id uuid, email text, station_id text, station_nom text,
               latitude double precision, longitude double precision, seuil real, par_mail boolean, par_notification boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.user_id, u.email::text, s.id, s.nom, s.latitude, s.longitude, a.seuil, a.par_mail, a.par_notification
  from public.alertes_gel a
  join auth.users u on u.id = a.user_id and (u.banned_until is null or u.banned_until < now())
  join public.stations s on s.id = a.station_id and s.installee and s.latitude is not null and s.longitude is not null
  where a.actif and a.prevision and (a.par_mail or a.par_notification)
    and (a.derniere_alerte_prevision is null or a.derniere_alerte_prevision < (now() at time zone 'Europe/Paris')::date)
    and sam_private.voit_meteo(a.user_id, s.id);
$$;

create or replace function public.sam_alertes_gel_marquer(p_ids uuid[], p_type text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.alertes_gel set
    derniere_alerte_mesure = case when p_type = 'mesure' then now() else derniere_alerte_mesure end,
    derniere_alerte_prevision = case when p_type = 'prevision' then (now() at time zone 'Europe/Paris')::date else derniere_alerte_prevision end
  where id = any (p_ids);
$$;

revoke all on function public.sam_alertes_gel_mesures() from public, anon, authenticated;
revoke all on function public.sam_alertes_gel_prevision() from public, anon, authenticated;
revoke all on function public.sam_alertes_gel_marquer(uuid[], text) from public, anon, authenticated;
revoke all on function sam_private.voit_meteo(uuid, text) from public, anon, authenticated;
grant execute on function public.sam_alertes_gel_mesures() to service_role;
grant execute on function public.sam_alertes_gel_prevision() to service_role;
grant execute on function public.sam_alertes_gel_marquer(uuid[], text) to service_role;

-- 5. Réglages privés de la fonction (aucun accès depuis le site)
create table if not exists sam_private.reglages (
  cle text primary key,
  valeur text not null,
  modifie_le timestamptz not null default now()
);
revoke all on sam_private.reglages from public, anon, authenticated;
insert into sam_private.reglages (cle, valeur)
values ('alertes_cle', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')),
       ('mail_expediteur', 'jchabat@sudexpe.net')
on conflict (cle) do nothing;

create or replace function public.sam_alertes_reglage(p_cle text)
returns text language sql stable security definer set search_path = ''
as $$ select valeur from sam_private.reglages where cle = p_cle; $$;
create or replace function public.sam_alertes_reglage_creer(p_cle text, p_valeur text)
returns void language sql security definer set search_path = ''
as $$ insert into sam_private.reglages (cle, valeur) values (p_cle, p_valeur) on conflict (cle) do nothing; $$;
revoke all on function public.sam_alertes_reglage(text) from public, anon, authenticated;
revoke all on function public.sam_alertes_reglage_creer(text, text) from public, anon, authenticated;
grant execute on function public.sam_alertes_reglage(text) to service_role;
grant execute on function public.sam_alertes_reglage_creer(text, text) to service_role;

-- Clé publique des notifications (créée par la fonction sam-alertes à son premier appel)
create or replace function public.sam_notifications_cle()
returns text language sql stable security definer set search_path = ''
as $$ select valeur from sam_private.reglages where cle = 'vapid_public'; $$;
revoke all on function public.sam_notifications_cle() from public, anon;
grant execute on function public.sam_notifications_cle() to authenticated;

-- 6. Tâches automatiques : la fonction n'est appelée que s'il y a une alerte à envoyer.
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('sam-alertes-mesures', 'sam-alertes-prevision');
end $$;
select cron.schedule('sam-alertes-mesures', '1-59/5 * * * *', $job$
  select net.http_post(
    url := 'https://kaenkiakgrkucdxticze.supabase.co/functions/v1/sam-alertes',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-sam-cle', (select valeur from sam_private.reglages where cle = 'alertes_cle')),
    body := '{"mode":"mesures"}'::jsonb,
    timeout_milliseconds := 30000)
  where exists (select 1 from public.sam_alertes_gel_mesures());
$job$);
select cron.schedule('sam-alertes-prevision', '0 17 * * *', $job$
  select net.http_post(
    url := 'https://kaenkiakgrkucdxticze.supabase.co/functions/v1/sam-alertes',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-sam-cle', (select valeur from sam_private.reglages where cle = 'alertes_cle')),
    body := '{"mode":"prevision"}'::jsonb,
    timeout_milliseconds := 60000)
  where exists (select 1 from public.sam_alertes_gel_prevision());
$job$);
