-- =============================================================================
-- SAM — double authentification (code à 6 chiffres d'une application)
-- -----------------------------------------------------------------------------
-- À coller dans Supabase > SQL Editor > New query, puis Run (relançable).
-- À exécuter après roles.sql. Exécuté le 23/11/2026.
--
-- Chaque compte peut activer la double authentification dans « Mon profil »
-- (Google Authenticator, Microsoft Authenticator…). Pour un compte qui l'a activée,
-- les droits « admin » et « full admin » ne s'appliquent qu'une fois le code saisi :
-- un mot de passe volé ne suffit plus à modifier quoi que ce soit.
-- Un compte qui ne l'a pas activée garde son fonctionnement actuel.
-- Téléphone perdu : un full admin retire la double authentification depuis la fiche
-- utilisateur (Administration > Comptes), ou Supabase > Authentication > Users > le compte
-- > « Remove MFA factors » ; la personne la réactive ensuite dans « Mon profil ».
-- Les mêmes définitions figurent dans schema.sql et roles.sql : relancer l'un de ces
-- fichiers ne retire pas la double authentification.
-- =============================================================================

-- Vrai si le compte n'a pas de double authentification, ou s'il a saisi son code.
create or replace function public.sam_mfa_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors f
        where f.user_id = (select auth.uid()) and f.status = 'verified'
      );
$$;

create or replace function public.is_sam_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from auth.users u
    join public.sam_admins a on a.email = lower(u.email)
    where u.id = auth.uid()
      and u.email_confirmed_at is not null
  ) and public.sam_mfa_ok();
$$;

create or replace function public.is_sam_full_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from auth.users u
    join public.sam_admins a on a.email = lower(u.email)
    where u.id = auth.uid()
      and u.email_confirmed_at is not null
      and a.niveau = 'full'
  ) and public.sam_mfa_ok();
$$;

revoke all on function public.sam_mfa_ok() from public, anon;
grant execute on function public.sam_mfa_ok() to authenticated;
revoke all on function public.is_sam_admin() from public, anon;
grant execute on function public.is_sam_admin() to authenticated;
revoke all on function public.is_sam_full_admin() from public, anon;
grant execute on function public.is_sam_full_admin() to authenticated;

-- Rôle lu par le site : 'normal' tant que le code n'est pas saisi.
-- Après ce fichier, relancer conseillers.sql : il redéfinit sam_role() avec le rôle « conseiller ».
create or replace function public.sam_role()
returns text
language sql
stable
security definer
set search_path = public, auth
as $$
  select case when not public.sam_mfa_ok() then 'normal' else coalesce((
    select a.niveau
    from auth.users u
    join public.sam_admins a on a.email = lower(u.email)
    where u.id = auth.uid()
      and u.email_confirmed_at is not null
  ), 'normal') end;
$$;
revoke all on function public.sam_role() from public, anon;
grant execute on function public.sam_role() to authenticated;
