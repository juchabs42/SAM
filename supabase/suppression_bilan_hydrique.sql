-- =============================================================================
-- SAM Outils — suppression définitive de l'ancien « Bilan hydrique »
-- -----------------------------------------------------------------------------
-- À coller dans Supabase > SQL Editor > New query, puis Run.
-- IRRÉVERSIBLE : toutes les parcelles, irrigations et corrections de pluie de
-- l'ancien Bilan hydrique (tables public.bilan_*) sont effacées pour tous les comptes.
-- Le Bilan irrigation (tables public.pilotage_*) n'est pas touché.
-- =============================================================================

-- 1. Ce qui va être supprimé (pour mémoire, avant suppression)
select table_name,
       (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', table_name), false, true, '')))[1]::text::int as lignes
from information_schema.tables
where table_schema = 'public' and table_type = 'BASE TABLE' and table_name like 'bilan\_%'
order by table_name;

-- 2. Suppression de toutes les tables de l'ancien outil (bilan_parcels,
--    bilan_irrigations, bilan_rain_corrections et d'éventuelles tables plus anciennes
--    du même outil), avec leurs index et règles d'accès.
do $$
declare
  t text;
begin
  for t in
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE' and table_name like 'bilan\_%'
  loop
    execute format('drop table if exists public.%I cascade', t);
    raise notice 'Table supprimée : %', t;
  end loop;
end $$;

-- 3. Le Bilan irrigation n'a plus de lien vers l'ancien outil
alter table if exists public.pilotage_parcelles drop column if exists origine_bilan_id;

notify pgrst, 'reload schema';

-- 4. Vérification : doit renvoyer 0
select count(*) as tables_bilan_restantes
from information_schema.tables
where table_schema = 'public' and table_name like 'bilan\_%';
