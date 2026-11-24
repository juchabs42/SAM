-- =============================================================================
-- SAM — mail aux « full admin » quand une station se tait, et alertes gel par compte
-- -----------------------------------------------------------------------------
-- À coller dans Supabase > SQL Editor > New query, puis Run (relançable).
-- À exécuter après alertes_gel.sql. Exécuté le 24/11/2026.
--
-- 1. Station muette : une station posée et active dont la dernière mesure a plus de
--    3 heures déclenche un mail aux comptes « full admin », une seule fois par
--    interruption (nouveau mail seulement si elle a retransmis entre-temps).
--    Vérification toutes les 15 minutes ; l'envoi passe par la fonction sam-alertes
--    (mode « stations »), avec la clé Brevo des alertes gel.
-- 2. Alertes gel de chaque compte : nombre d'alertes et d'appareils abonnés, lisible
--    par les « full admin » (onglet Administration > Comptes).
-- =============================================================================

-- 1. Mémoire du dernier mail envoyé pour chaque station
alter table public.stations add column if not exists alerte_muette_le timestamptz;

-- Stations muettes depuis plus de 3 heures, pas encore signalées pour cette interruption
create or replace function public.sam_stations_muettes()
returns table (station_id text, station_nom text, derniere_mesure timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.nom, s.derniere_mesure
  from public.stations s
  where s.installee and s.active
    and s.derniere_mesure is not null
    and s.derniere_mesure < now() - interval '3 hours'
    and (s.alerte_muette_le is null or s.alerte_muette_le < s.derniere_mesure)
  order by s.nom;
$$;

-- Adresses des « full admin » (comptes confirmés, non suspendus)
create or replace function public.sam_full_admins_mails()
returns table (email text)
language sql
stable
security definer
set search_path = ''
as $$
  select u.email::text
  from auth.users u
  join public.sam_admins a on a.email = lower(u.email) and a.niveau = 'full'
  where u.email_confirmed_at is not null
    and (u.banned_until is null or u.banned_until < now());
$$;

create or replace function public.sam_stations_muettes_marquer(p_ids text[])
returns void
language sql
security definer
set search_path = ''
as $$
  update public.stations set alerte_muette_le = now() where id = any (p_ids);
$$;

revoke all on function public.sam_stations_muettes() from public, anon, authenticated;
revoke all on function public.sam_full_admins_mails() from public, anon, authenticated;
revoke all on function public.sam_stations_muettes_marquer(text[]) from public, anon, authenticated;
grant execute on function public.sam_stations_muettes() to service_role;
grant execute on function public.sam_full_admins_mails() to service_role;
grant execute on function public.sam_stations_muettes_marquer(text[]) to service_role;

-- Stations déjà muettes au moment de l'installation : pas de mail pour elles
-- (elles figurent déjà dans Administration) ; le suivi commence à la prochaine interruption.
update public.stations
set alerte_muette_le = now()
where installee and active and derniere_mesure is not null
  and derniere_mesure < now() - interval '3 hours'
  and alerte_muette_le is null;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'sam-stations-muettes';
end $$;
select cron.schedule('sam-stations-muettes', '3,18,33,48 * * * *', $job$
  select net.http_post(
    url := 'https://kaenkiakgrkucdxticze.supabase.co/functions/v1/sam-alertes',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-sam-cle', (select valeur from sam_private.reglages where cle = 'alertes_cle')),
    body := '{"mode":"stations"}'::jsonb,
    timeout_milliseconds := 30000)
  where exists (select 1 from public.sam_stations_muettes());
$job$);

-- 2. Alertes gel par compte, pour l'administration (« full admin » seulement)
create or replace function public.sam_alertes_gel_comptes()
returns table (user_id uuid, alertes integer, actives integer, appareils integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_sam_full_admin() then
    raise exception 'Réservé aux administrateurs « full admin ».';
  end if;
  return query
  select u.id,
    (select count(*)::integer from public.alertes_gel g where g.user_id = u.id),
    (select count(*)::integer from public.alertes_gel g where g.user_id = u.id and g.actif),
    (select count(*)::integer from public.notifications_push p where p.user_id = u.id)
  from auth.users u;
end $$;
revoke all on function public.sam_alertes_gel_comptes() from public, anon;
grant execute on function public.sam_alertes_gel_comptes() to authenticated;

notify pgrst, 'reload schema';
