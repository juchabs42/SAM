-- =============================================================================
-- SAM — relevé rapide des stations sous alerte gel
-- -----------------------------------------------------------------------------
-- À coller dans Supabase > SQL Editor > New query, puis Run (relançable).
-- À exécuter après alertes_gel.sql. Exécuté le 25/11/2026.
--
-- Comsag : une alarme à 3 °C est réglée sur les stations suivies en alerte gel ; sous ce
-- seuil, la station transmet toutes les 5 minutes au lieu d'une fois par heure. L'API
-- Comsag ne renvoie que les mesures reçues : c'est à SAM d'aller les chercher plus souvent.
--
-- Toutes les 5 minutes (en plus du relevé de toutes les stations à 7 et 37) : SAM
-- interroge les stations qui ont une alerte gel active sur mesure, avec un seuil de
-- 3 °C ou moins, dont la dernière température mesurée est à 4 °C ou moins (1 °C de marge
-- pour attraper les premiers envois rapprochés). Les autres nuits, aucun appel en plus.
-- Chaîne : relevé à :03, :08… → intégration (:05, :10…) → contrôle des alertes une
-- minute après : l'alerte part moins de 10 minutes après la mesure.
-- =============================================================================

create or replace function sam_private.comsag_demander_gel()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  s record;
  v_nb integer := 0;
begin
  for s in
    select st.id
    from public.stations st
    where st.active and st.installee
      -- alerte gel active, déclenchée sur mesure, seuil à 3 °C ou moins
      and exists (
        select 1 from public.alertes_gel a
        where a.station_id = st.id and a.actif and a.mesure and a.seuil <= 3
          and (a.par_mail or a.par_notification))
      -- dernière température mesurée à 4 °C ou moins
      and (select m.t_air from public.station_mesures m
           where m.station_id = st.id and m.t_air is not null
           order by m.mesure_le desc limit 1) <= 4
      -- pas de demande déjà en cours, pas de relevé dans les 4 dernières minutes
      and not exists (select 1 from sam_private.comsag_requetes q where q.station_id = st.id)
      and (st.derniere_synchro is null or st.derniere_synchro < now() - interval '4 minutes')
  loop
    v_nb := v_nb + sam_private.comsag_demander(s.id, null);
  end loop;
  return v_nb;
end $$;
revoke all on function sam_private.comsag_demander_gel() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'sam-comsag-gel';
end $$;
select cron.schedule('sam-comsag-gel', '3-58/5 * * * *', $$ select sam_private.comsag_demander_gel(); $$);
