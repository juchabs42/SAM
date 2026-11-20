-- =============================================================================
-- SAM Outils — capteurs masqués, station par station
-- -----------------------------------------------------------------------------
-- À coller dans Supabase > SQL Editor > New query, puis Run (relançable).
-- À exécuter après acces_stations.sql.
--
-- Administration > Capteurs > « Noms des capteurs » : pour la station choisie, une case
-- « Affiché dans Données » par capteur. Un capteur décoché (exemple : pas de pluviomètre à
-- Carthagène P5) disparaît pour tous les comptes, admins compris :
--   - de l'onglet Données (graphiques, encarts, résumé journalier, exports CSV) ;
--   - de la carte (infobulles) ;
--   - du Bilan irrigation : sans pluviomètre, la pluie reste celle d'Open-Meteo.
-- Les mesures ne sont pas effacées : elles restent visibles dans Administration > Capteurs
-- et réapparaissent dès que la case est recochée.
-- =============================================================================

-- 1. Capteurs masqués de chaque station (codes : t1, hyg1, pluv, hum, ts1, decagon1…)
alter table public.stations add column if not exists capteurs_masques text[] not null default '{}';

-- 2. Vue filtrée (acces_stations.sql) : retire aussi les capteurs masqués.
--    Mêmes colonnes qu'avant : station_journalier et le site continuent de la lire telle quelle.
create or replace view public.station_mesures_visibles as
with acces as (
  select a.station_id, a.meteo, a.irrigation from public.sam_acces_stations() a where a.meteo or a.irrigation
), dico as (
  select coalesce(array_agg(code) filter (where categorie = 'meteo'), '{}') as meteo_codes from public.station_capteurs
)
select
  m.station_id,
  m.mesure_le,
  case when a.meteo and not ('t1' = any (s.capteurs_masques)) then m.t_air end as t_air,
  case when a.meteo and not ('hyg1' = any (s.capteurs_masques)) then m.hr end as hr,
  case when a.meteo and not ('pluv' = any (s.capteurs_masques)) then m.pluie end as pluie,
  case
    when a.meteo and a.irrigation and cardinality(s.capteurs_masques) = 0 then m.autres
    else coalesce((
      select jsonb_object_agg(e.key, e.value)
      from jsonb_each(m.autres) e
      where case when e.key = any (d.meteo_codes) then a.meteo else a.irrigation end
        and not (e.key = any (s.capteurs_masques))
    ), '{}'::jsonb)
  end as autres
from public.station_mesures m
join acces a on a.station_id = m.station_id
join public.stations s on s.id = m.station_id
cross join dico d;

grant select on public.station_mesures_visibles to authenticated;
revoke all on public.station_mesures_visibles from anon;

notify pgrst, 'reload schema';
