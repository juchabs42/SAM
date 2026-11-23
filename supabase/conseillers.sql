-- =============================================================================
-- SAM — rôle « Conseiller » (techniciens et conseillers d'organisations de producteurs)
-- -----------------------------------------------------------------------------
-- À coller dans Supabase > SQL Editor > New query, puis Run (relançable).
-- À exécuter après roles.sql et double_authentification.sql. Exécuté le 23/11/2026.
--
-- Un conseiller reste un compte de consultation (aucune saisie), avec en plus :
--   - les stations qu'il suit : toutes leurs données, météo et irrigation. Elles se
--     choisissent dans sa fiche (Administration > Comptes > Fiche utilisateur) et sont
--     enregistrées comme accès complets dans station_acces ;
--   - l'export Excel des données d'une station (onglet Données) ;
--   - les alertes gel sur plusieurs stations (un producteur en suit une).
-- Le rôle se donne dans la fiche utilisateur ; la fonction sam-admin tient cette table à jour.
-- =============================================================================

create table if not exists public.sam_conseillers (
  email text primary key check (email = lower(email)),
  cree_le timestamptz not null default now()
);
alter table public.sam_conseillers enable row level security;
drop policy if exists sam_conseillers_admin on public.sam_conseillers;
create policy sam_conseillers_admin on public.sam_conseillers
  for all to authenticated using ((select public.is_sam_full_admin())) with check ((select public.is_sam_full_admin()));
revoke all on public.sam_conseillers from anon;
grant select, insert, update, delete on public.sam_conseillers to authenticated;

-- Rôle lu par le site : 'full', 'admin', 'conseiller' ou 'normal'
-- ('normal' tant que le code de double authentification n'est pas saisi).
create or replace function public.sam_role()
returns text
language sql
stable
security definer
set search_path = public, auth
as $$
  select case when not public.sam_mfa_ok() then 'normal' else coalesce(
    (select a.niveau
       from auth.users u join public.sam_admins a on a.email = lower(u.email)
      where u.id = auth.uid() and u.email_confirmed_at is not null),
    (select 'conseiller'
       from auth.users u join public.sam_conseillers c on c.email = lower(u.email)
      where u.id = auth.uid() and u.email_confirmed_at is not null),
    'normal') end;
$$;
revoke all on function public.sam_role() from public, anon;
grant execute on function public.sam_role() to authenticated;
