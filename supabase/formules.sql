-- =============================================================================
-- SAM — formules d'abonnement des comptes « normal » : Météo, Outils SAM, Complète
-- -----------------------------------------------------------------------------
-- À coller dans Supabase > SQL Editor > New query, puis Run (relançable).
-- À exécuter après stations_muettes.sql. Exécuté le 24/11/2026.
--
--   meteo     Données des stations, prévisions, cartographie, alertes gel
--   outils    les 6 Outils SAM (indicateurs, programmation et bilan irrigation,
--             phénologie, tavelure, piégeage), sans aucune donnée des stations
--   complete  les deux (par défaut : comptes existants, comptes sans formule)
--
-- Date de fin d'accès facultative (formule Découverte) : passé ce jour, le compte
-- n'a plus accès qu'à son profil et à l'aide, jusqu'à prolongation.
-- Les rôles admin et full admin ont toujours tout.
-- Le contrôle est fait dans la base : un compte « outils » ne lit aucune mesure de
-- station, un compte « météo » aucune donnée des Outils SAM, même hors du site.
-- =============================================================================

-- 1. Formule de chaque compte (par adresse mail, réglable avant l'acceptation de l'invitation)
create table if not exists public.sam_formules (
  email text primary key check (email = lower(email)),
  formule text not null default 'complete' check (formule in ('meteo', 'outils', 'complete')),
  acces_jusqu date,
  maj_le timestamptz not null default now()
);
alter table public.sam_formules enable row level security;
drop policy if exists sam_formules_lecture on public.sam_formules;
create policy sam_formules_lecture on public.sam_formules
  for select to authenticated using (email = lower((select auth.jwt()) ->> 'email') or (select public.is_sam_full_admin()));
drop policy if exists sam_formules_full_admin on public.sam_formules;
create policy sam_formules_full_admin on public.sam_formules
  for all to authenticated using ((select public.is_sam_full_admin())) with check ((select public.is_sam_full_admin()));
revoke all on public.sam_formules from anon;
grant select, insert, update, delete on public.sam_formules to authenticated;

-- 2. Formule en vigueur d'un compte : 'complete', 'meteo', 'outils' ou 'terminee' (date de fin passée)
create or replace function sam_private.formule_de(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (select 1 from auth.users u join public.sam_admins a on a.email = lower(u.email) where u.id = p_user) then 'complete'
    when f.acces_jusqu is not null and f.acces_jusqu < (now() at time zone 'Europe/Paris')::date then 'terminee'
    else coalesce(f.formule, 'complete')
  end
  from (select 1) x
  left join auth.users u on u.id = p_user
  left join public.sam_formules f on f.email = lower(u.email);
$$;
revoke all on function sam_private.formule_de(uuid) from public, anon, authenticated;

-- Pour le site : formule du compte connecté
create or replace function public.sam_formule()
returns table (formule text, acces_jusqu date)
language sql
stable
security definer
set search_path = ''
as $$
  select sam_private.formule_de(auth.uid()),
         (select f.acces_jusqu from auth.users u join public.sam_formules f on f.email = lower(u.email) where u.id = auth.uid());
$$;
revoke all on function public.sam_formule() from public, anon;
grant execute on function public.sam_formule() to authenticated;

create or replace function public.sam_voit_stations()
returns boolean language sql stable security definer set search_path = ''
as $$ select sam_private.formule_de(auth.uid()) in ('meteo', 'complete'); $$;
create or replace function public.sam_voit_outils()
returns boolean language sql stable security definer set search_path = ''
as $$ select sam_private.formule_de(auth.uid()) in ('outils', 'complete'); $$;
revoke all on function public.sam_voit_stations() from public, anon;
revoke all on function public.sam_voit_outils() from public, anon;
grant execute on function public.sam_voit_stations() to authenticated;
grant execute on function public.sam_voit_outils() to authenticated;

-- 3. Stations et mesures : rien pour un compte sans la partie météo
--    (liste des stations, vue des mesures et alertes gel passent toutes par cette fonction)
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
  where auth.uid() is not null
    and (moi.admin or public.sam_voit_stations());
$$;

-- Envoi des alertes gel : seulement aux comptes qui ont la partie météo
create or replace function sam_private.voit_meteo(p_user uuid, p_station text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select sam_private.formule_de(p_user) in ('meteo', 'complete')
    and exists (
      select 1 from public.stations s
      where s.id = p_station
        and (s.publique or s.acces_meteo = 'tous'
          or exists (select 1 from public.station_acces x where x.station_id = s.id and x.user_id = p_user and x.meteo)
          or exists (select 1 from auth.users u join public.sam_admins a on a.email = lower(u.email) where u.id = p_user))
    );
$$;
revoke all on function sam_private.voit_meteo(uuid, text) from public, anon, authenticated;

-- 4. Outils SAM : lecture réservée aux comptes qui ont la partie outils
do $$
declare
  t text;
begin
  -- Bilan irrigation : données propres à chaque compte
  foreach t in array array['pilotage_parcelles', 'pilotage_irrigations', 'pilotage_pluies'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists %I on public.%I', t || ' propriétaire', t);
      execute format('create policy %I on public.%I for all to authenticated using ((select auth.uid()) = user_id and (select public.sam_voit_outils())) with check ((select auth.uid()) = user_id and (select public.sam_voit_outils()))', t || ' propriétaire', t);
    end if;
  end loop;
  -- Phénologie, tavelure : lecture de tous les comptes qui ont les outils
  foreach t in array array['pheno_parcels', 'pheno_observations', 'tavelure_comptages', 'tavelure_parametres', 'tavelure_peritheces',
                           'piegeage_campaign_parcels', 'piegeage_campaign_species', 'piegeage_intervention_parcels', 'piegeage_observation_details'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists %I on public.%I', t || ' lecture comptes', t);
      execute format('create policy %I on public.%I for select to authenticated using ((select public.sam_voit_outils()))', t || ' lecture comptes', t);
    end if;
  end loop;
  -- Piégeage : lignes archivées visibles des seuls administrateurs
  foreach t in array array['piegeage_campaigns', 'piegeage_interventions', 'piegeage_observations_v2', 'piegeage_parcels', 'piegeage_trap_events', 'piegeage_traps'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists %I on public.%I', t || ' lecture comptes', t);
      execute format('create policy %I on public.%I for select to authenticated using ((select public.sam_voit_outils()) and (archived_at is null or (select public.is_sam_admin())))', t || ' lecture comptes', t);
    end if;
  end loop;
  if to_regclass('public.piegeage_species') is not null then
    drop policy if exists "piegeage_species lecture comptes" on public.piegeage_species;
    create policy "piegeage_species lecture comptes" on public.piegeage_species
      for select to authenticated using ((select public.sam_voit_outils()) and ((active and archived_at is null) or (select public.is_sam_admin())));
  end if;
end $$;

notify pgrst, 'reload schema';

-- =============================================================================
-- À la main (sinon : Administration > Comptes > Fiche utilisateur > Formule)
--   insert into public.sam_formules (email, formule, acces_jusqu)
--   values ('prenom.nom@exemple.fr', 'meteo', null)
--   on conflict (email) do update set formule = excluded.formule, acces_jusqu = excluded.acces_jusqu, maj_le = now();
-- =============================================================================

-- 5. Alerte gel du soir (prévision) : formule Complète seulement — la formule Météo n'a pas
--    les prévisions (outil Indicateurs) ; elle garde l'alerte sur mesure.
create or replace function public.sam_alertes_gel_prevision()
returns table (alerte_id uuid, user_id uuid, email text, station_id text, station_nom text,
               latitude double precision, longitude double precision, seuil real, par_mail boolean, par_notification boolean)
language sql stable security definer set search_path = ''
as $$
  select a.id, a.user_id, u.email::text, s.id, s.nom, s.latitude, s.longitude, a.seuil, a.par_mail, a.par_notification
  from public.alertes_gel a
  join auth.users u on u.id = a.user_id and (u.banned_until is null or u.banned_until < now())
  join public.stations s on s.id = a.station_id and s.installee and s.latitude is not null and s.longitude is not null
  where a.actif and a.prevision and (a.par_mail or a.par_notification)
    and (a.derniere_alerte_prevision is null or a.derniere_alerte_prevision < (now() at time zone 'Europe/Paris')::date)
    and sam_private.voit_meteo(a.user_id, s.id)
    and sam_private.formule_de(a.user_id) = 'complete';
$$;
revoke all on function public.sam_alertes_gel_prevision() from public, anon, authenticated;
grant execute on function public.sam_alertes_gel_prevision() to service_role;
