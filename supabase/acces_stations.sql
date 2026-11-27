-- =============================================================================
-- SAM Outils — accès aux données des stations, par station et par compte
-- -----------------------------------------------------------------------------
-- À coller dans Supabase > SQL Editor > New query, puis Run (relançable).
-- À exécuter après stations.sql, connexion_comptes.sql et roles.sql.
--
-- Pour chaque station (Administration > Stations > Modifier) :
--   « Visible par tous les comptes » coché  : tout est visible par tous (comme avant)
--   décoché : deux réglages séparés
--     Données météo      : tous les comptes, ou seulement les comptes choisis
--     Données irrigation : tous les comptes, ou seulement les comptes choisis
-- Les admins et full admins voient toujours tout.
--
-- Données météo      : température, hygrométrie, pluie, humectation, batterie
-- Données irrigation : tensiomètres, sondes capacitives, dendromètres…
--                      (station_capteurs.categorie = 'irrigation' ; tout capteur
--                      inconnu du dictionnaire est traité comme irrigation)
-- Le filtrage est fait par la base : un compte sans accès irrigation ne peut pas
-- lire ces valeurs, même en interrogeant Supabase directement.
-- =============================================================================

-- 1. Réglages par station
do $$
declare
  nouveau boolean := not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'stations' and column_name = 'acces_meteo');
begin
  alter table public.stations add column if not exists acces_meteo text not null default 'tous';
  alter table public.stations add column if not exists acces_irrigation text not null default 'tous';
  -- Première exécution : les stations jusqu'ici masquées restent masquées.
  if nouveau then
    update public.stations set acces_meteo = 'comptes', acces_irrigation = 'comptes' where not publique;
  end if;
end $$;
alter table public.stations drop constraint if exists stations_acces_meteo_check;
alter table public.stations add constraint stations_acces_meteo_check check (acces_meteo in ('tous', 'comptes'));
alter table public.stations drop constraint if exists stations_acces_irrigation_check;
alter table public.stations add constraint stations_acces_irrigation_check check (acces_irrigation in ('tous', 'comptes'));

-- 2. Catégorie des capteurs
alter table public.station_capteurs add column if not exists categorie text not null default 'irrigation';
alter table public.station_capteurs drop constraint if exists station_capteurs_categorie_check;
alter table public.station_capteurs add constraint station_capteurs_categorie_check check (categorie in ('meteo', 'irrigation'));
update public.station_capteurs set categorie = 'meteo' where code in ('t1', 'hyg1', 'pluv', 'hum', 'bat');

-- 3. Comptes autorisés, station par station
create table if not exists public.station_acces (
  station_id text not null references public.stations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  meteo boolean not null default false,
  irrigation boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (station_id, user_id)
);
create index if not exists station_acces_user_idx on public.station_acces (user_id);
alter table public.station_acces enable row level security;
drop policy if exists station_acces_lecture on public.station_acces;
create policy station_acces_lecture on public.station_acces
  for select to authenticated using (user_id = (select auth.uid()) or (select public.is_sam_full_admin()));
drop policy if exists station_acces_admin on public.station_acces;
create policy station_acces_admin on public.station_acces
  for all to authenticated using ((select public.is_sam_full_admin())) with check ((select public.is_sam_full_admin()));
grant select, insert, update, delete on public.station_acces to authenticated;
revoke all on public.station_acces from anon;

-- 4. Droits du compte connecté sur chaque station
create or replace function public.sam_acces_stations()
returns table (station_id text, meteo boolean, irrigation boolean)
language sql
stable
security definer
set search_path = public, auth
as $$
  with moi as (select public.is_sam_admin() as admin)
  select s.id,
         moi.admin or s.publique or s.acces_meteo = 'tous' or coalesce(x.meteo, false),
         moi.admin or s.publique or s.acces_irrigation = 'tous' or coalesce(x.irrigation, false)
  from public.stations s
  cross join moi
  left join public.station_acces x on x.station_id = s.id and x.user_id = auth.uid()
  where auth.uid() is not null;
$$;
revoke all on function public.sam_acces_stations() from public, anon;
grant execute on function public.sam_acces_stations() to authenticated;

-- 5. Lecture : une station est visible si le compte a accès à au moins une famille de données
alter table public.stations enable row level security;
drop policy if exists stations_lecture on public.stations;
create policy stations_lecture on public.stations
  for select to authenticated using (
    exists (select 1 from public.sam_acces_stations() a where a.station_id = stations.id and (a.meteo or a.irrigation))
  );

-- Mesures brutes : réservées aux admins ; les autres comptes passent par la vue filtrée.
alter table public.station_mesures enable row level security;
drop policy if exists station_mesures_lecture on public.station_mesures;
create policy station_mesures_lecture on public.station_mesures
  for select to authenticated using ((select public.is_sam_admin()));

-- Vue filtrée : valeurs météo et irrigation masquées selon les droits du compte.
-- (Pas de security_invoker : la vue lit les mesures brutes et applique elle-même les droits.)
create or replace view public.station_mesures_visibles as
with acces as (
  select a.station_id, a.meteo, a.irrigation from public.sam_acces_stations() a where a.meteo or a.irrigation
), dico as (
  select coalesce(array_agg(code) filter (where categorie = 'meteo'), '{}') as meteo_codes from public.station_capteurs
)
select
  m.station_id,
  m.mesure_le,
  case when a.meteo then m.t_air end as t_air,
  case when a.meteo then m.hr end as hr,
  case when a.meteo then m.pluie end as pluie,
  case
    when a.meteo and a.irrigation then m.autres
    else coalesce((
      select jsonb_object_agg(e.key, e.value)
      from jsonb_each(m.autres) e
      where (e.key = any (d.meteo_codes)) = a.meteo
    ), '{}'::jsonb)
  end as autres
from public.station_mesures m
join acces a on a.station_id = m.station_id
cross join dico d;

grant select on public.station_mesures_visibles to authenticated;
revoke all on public.station_mesures_visibles from anon;

-- Résumé journalier : calculé sur la vue filtrée.
create or replace view public.station_journalier
with (security_invoker = true) as
select
  m.station_id,
  (m.mesure_le at time zone 'Europe/Paris')::date as jour,
  min(m.t_air) as t_min,
  max(m.t_air) as t_max,
  round(avg(m.t_air)::numeric, 2) as t_moy,
  min(m.hr) as hr_min,
  max(m.hr) as hr_max,
  round(avg(m.hr)::numeric, 1) as hr_moy,
  round(sum(m.pluie)::numeric, 1) as pluie,
  count(*)::integer as nb_mesures
from public.station_mesures_visibles m
group by m.station_id, (m.mesure_le at time zone 'Europe/Paris')::date;
grant select on public.station_journalier to authenticated;
revoke all on public.station_journalier from anon;

notify pgrst, 'reload schema';

-- Tensiomètres : graphique de l'onglet Irrigation (surface ou profondeur), réglable dans
-- Administration > Capteurs. ts1 à ts3 en surface, ts4 à ts6 en profondeur. Exécuté le 27/11/2026.
alter table public.station_capteurs add column if not exists graphique text;
alter table public.station_capteurs drop constraint if exists station_capteurs_graphique_check;
alter table public.station_capteurs add constraint station_capteurs_graphique_check check (graphique is null or graphique in ('surface', 'profondeur'));
insert into public.station_capteurs (code, libelle, unite, ordre, categorie) values
  ('ts3', 'Tensiomètre 3 (30 cm)', 'cb', 22, 'irrigation'),
  ('ts6', 'Tensiomètre 6 (60 cm)', 'cb', 25, 'irrigation')
on conflict (code) do nothing;
update public.station_capteurs set graphique = 'surface' where code in ('ts1', 'ts2', 'ts3') and graphique is null;
update public.station_capteurs set graphique = 'profondeur' where code in ('ts4', 'ts5', 'ts6') and graphique is null;
