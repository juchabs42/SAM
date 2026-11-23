-- =============================================================================
-- SAM — maintenance de la base (relançable). Exécuté le 23/11/2026.
-- -----------------------------------------------------------------------------
-- 1. Le journal des tâches automatiques (cron.job_run_details) grossit d'environ
--    340 lignes par jour : on ne garde que les 14 derniers jours (purge chaque nuit, 3 h 17).
-- 2. Deux fonctions de lecture des réponses Comsag reçoivent un chemin de recherche fixe
--    (alerte de sécurité Supabase « search_path mutable »).
-- =============================================================================

select cron.unschedule(jobid) from cron.job where jobname = 'sam-purge-journal';
select cron.schedule(
  'sam-purge-journal',
  '17 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '14 days'$$
);

alter function sam_private.nombre(text) set search_path = '';
alter function sam_private.horodatage(text) set search_path = '';
