-- =============================================================================
-- SAM — rôle « Conseiller » et groupes de stations
-- -----------------------------------------------------------------------------
-- À coller dans Supabase > SQL Editor > New query, puis Run (relançable).
-- À exécuter après formules.sql. Exécuté le 25/11/2026.
--
-- Conseiller (conseillers techniques d'OP) : les droits d'un compte « normal » en
-- formule Complète, plus les groupes de stations (onglet Données) : il réunit plusieurs
-- stations proches (« Bassin de Mogio », « Nîmes ») et compare leurs courbes.
-- Les groupes sont personnels : chacun ne voit que les siens. Admin et full admin en
-- ont aussi. Le rôle se donne dans Administration > Comptes (fonction sam-admin).
-- =============================================================================

-- 1. Liste des conseillers (par adresse, comme sam_admins)
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

-- 2. Rôle lu par le site : 'full', 'admin', 'conseiller' ou 'normal'
--    ('normal' tant que le code de double authentification n'est pas saisi).
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

-- 3. Formule : un conseiller a toujours la formule Complète
create or replace function sam_private.formule_de(p_user uuid)
returns text language sql stable security definer set search_path = ''
as $$
  select case
    when exists (select 1 from auth.users u join public.sam_admins a on a.email = lower(u.email) where u.id = p_user) then 'complete'
    when exists (select 1 from auth.users u join public.sam_conseillers c on c.email = lower(u.email) where u.id = p_user) then 'complete'
    when f.acces_jusqu is not null and f.acces_jusqu < (now() at time zone 'Europe/Paris')::date then 'terminee'
    else coalesce(f.formule, 'complete')
  end
  from (select 1) x
  left join auth.users u on u.id = p_user
  left join public.sam_formules f on f.email = lower(u.email);
$$;
revoke all on function sam_private.formule_de(uuid) from public, anon, authenticated;

-- 4. Groupes de stations (personnels)
create or replace function public.sam_peut_grouper()
returns boolean language sql stable security definer set search_path = ''
as $$ select public.sam_role() in ('conseiller', 'admin', 'full'); $$;
revoke all on function public.sam_peut_grouper() from public, anon;
grant execute on function public.sam_peut_grouper() to authenticated;

create table if not exists public.groupes_stations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  nom text not null check (char_length(btrim(nom)) between 1 and 60),
  stations text[] not null default '{}' check (cardinality(stations) <= 8),
  ordre integer not null default 0,
  cree_le timestamptz not null default now(),
  maj_le timestamptz not null default now()
);
create index if not exists groupes_stations_user_idx on public.groupes_stations (user_id);
alter table public.groupes_stations enable row level security;
drop policy if exists groupes_stations_moi on public.groupes_stations;
create policy groupes_stations_moi on public.groupes_stations
  for all to authenticated
  using (user_id = (select auth.uid()) and (select public.sam_peut_grouper()))
  with check (user_id = (select auth.uid()) and (select public.sam_peut_grouper()));
revoke all on public.groupes_stations from anon;
grant select, insert, update, delete on public.groupes_stations to authenticated;

notify pgrst, 'reload schema';

-- =============================================================================
-- À la main (sinon : Administration > Comptes > Fiche utilisateur > Rôle)
--   insert into public.sam_conseillers (email) values ('prenom.nom@op.fr') on conflict do nothing;
--   retrait : delete from public.sam_conseillers where email = 'prenom.nom@op.fr';
-- =============================================================================
