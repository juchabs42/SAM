-- =============================================================================
-- SAM Outils — trois rôles : normal, admin, full admin
-- -----------------------------------------------------------------------------
-- À coller dans Supabase > SQL Editor > New query, puis Run.
-- Relançable sans risque. À exécuter après schema.sql, stations.sql et
-- connexion_comptes.sql.
--
--   normal      producteurs, techniciens : lecture seule (pas dans sam_admins)
--   admin       collègues SudExpé : saisie Phénologie, Tavelure, Piégeage
--   full admin  gestion des comptes, des stations, des capteurs, fiches stations
--
-- Les comptes déjà présents dans sam_admins deviennent « admin », sauf
-- jchabat@sudexpe.net qui devient « full admin ».
-- =============================================================================

-- 1. Niveau de chaque administrateur
alter table public.sam_admins add column if not exists niveau text not null default 'admin';
alter table public.sam_admins drop constraint if exists sam_admins_niveau_check;
alter table public.sam_admins add constraint sam_admins_niveau_check check (niveau in ('admin', 'full'));

insert into public.sam_admins (email, niveau)
values ('jchabat@sudexpe.net', 'full')
on conflict (email) do update set niveau = 'full';

-- 2. Fonctions de contrôle
-- is_sam_admin() (déjà existante) : vrai pour « admin » ET « full admin ».
-- Double authentification (double_authentification.sql) : pour un compte qui l'a
-- activée, les droits ne s'appliquent qu'une fois le code saisi (jeton « aal2 »).
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
revoke all on function public.sam_mfa_ok() from public, anon;
grant execute on function public.sam_mfa_ok() to authenticated;

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

-- Rôle du compte connecté : 'full', 'admin' ou 'normal' (lu par le site).
-- Sans le code de double authentification (compte qui l'a activée) : 'normal'.
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

revoke all on function public.is_sam_full_admin() from public, anon;
grant execute on function public.is_sam_full_admin() to authenticated;
revoke all on function public.sam_role() from public, anon;
grant execute on function public.sam_role() to authenticated;

-- 3. Stations et capteurs : modification réservée aux « full admin »
do $$
begin
  if to_regclass('public.stations') is not null then
    drop policy if exists stations_admin_maj on public.stations;
    create policy stations_admin_maj on public.stations
      for update to authenticated using ((select public.is_sam_full_admin())) with check ((select public.is_sam_full_admin()));
    drop policy if exists stations_admin_ajout on public.stations;
    create policy stations_admin_ajout on public.stations
      for insert to authenticated with check ((select public.is_sam_full_admin()));
    drop policy if exists stations_admin_suppr on public.stations;
    create policy stations_admin_suppr on public.stations
      for delete to authenticated using ((select public.is_sam_full_admin()));
  end if;
  if to_regclass('public.station_capteurs') is not null then
    drop policy if exists station_capteurs_admin on public.station_capteurs;
    create policy station_capteurs_admin on public.station_capteurs
      for all to authenticated using ((select public.is_sam_full_admin())) with check ((select public.is_sam_full_admin()));
  end if;
end $$;

-- Boutons « Synchroniser » des stations
do $$
begin
  if to_regprocedure('sam_private.comsag_demander(text, timestamptz)') is not null then
    execute $f$
      create or replace function public.stations_synchroniser(p_station text default null)
      returns integer
      language plpgsql security definer set search_path = '' as $b$
      begin
        if not public.is_sam_full_admin() then
          raise exception 'Réservé aux administrateurs « full admin ».';
        end if;
        return sam_private.comsag_demander(p_station, null);
      end $b$;
    $f$;
  end if;
  if to_regprocedure('sam_private.comsag_integrer()') is not null then
    execute $f$
      create or replace function public.stations_integrer()
      returns integer
      language plpgsql security definer set search_path = '' as $b$
      begin
        if not public.is_sam_full_admin() then
          raise exception 'Réservé aux administrateurs « full admin ».';
        end if;
        return sam_private.comsag_integrer();
      end $b$;
    $f$;
  end if;
end $$;

-- 4. Profils des comptes : chacun le sien, les « full admin » tous
do $$
begin
  if to_regclass('public.profils') is not null then
    drop policy if exists profils_lecture on public.profils;
    create policy profils_lecture on public.profils
      for select to authenticated using (id = (select auth.uid()) or (select public.is_sam_full_admin()));
  end if;
end $$;

notify pgrst, 'reload schema';

-- =============================================================================
-- Changer un rôle à la main (sinon : onglet Administration > Comptes > Gérer)
--   admin      : insert into public.sam_admins (email, niveau) values ('prenom.nom@sudexpe.net', 'admin')
--                on conflict (email) do update set niveau = 'admin';
--   full admin : même requête avec 'full'
--   normal     : delete from public.sam_admins where email = 'prenom.nom@sudexpe.net';
-- =============================================================================
