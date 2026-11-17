-- =============================================================================
-- SAM Pilotage irrigation (FAO-56 Rev.1, 2025) — parcelles privées par compte
-- À exécuter une fois dans l'éditeur SQL du projet Supabase de SAM Outils.
-- Le script peut être relancé sans risque (create if not exists / drop policy if exists).
--
-- Les paramètres de calcul d'une parcelle (culture, sol, système d'irrigation, stades,
-- coefficients et leurs sources FAO) sont rangés dans la colonne jsonb « config » :
-- le moteur évolue sans migration de schéma.
-- =============================================================================

create table if not exists public.pilotage_parcelles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nom text not null check (length(trim(nom)) > 0),
  lieu text,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  altitude double precision,
  surface_ha numeric check (surface_ha is null or surface_ha > 0),
  station_id text,
  culture_id text not null,
  classe_id text,
  config jsonb not null default '{}'::jsonb,
  origine_bilan_id uuid,
  archivee boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.pilotage_irrigations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  parcelle_id uuid not null references public.pilotage_parcelles(id) on delete cascade,
  jour date not null,
  dose_brute_mm numeric not null check (dose_brute_mm >= 0 and dose_brute_mm <= 500),
  saisie jsonb,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.pilotage_pluies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  parcelle_id uuid not null references public.pilotage_parcelles(id) on delete cascade,
  jour date not null,
  pluie_mm numeric not null check (pluie_mm >= 0 and pluie_mm <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (parcelle_id, jour)
);

create index if not exists pilotage_parcelles_user_idx on public.pilotage_parcelles (user_id);
create index if not exists pilotage_irrigations_parcelle_jour_idx on public.pilotage_irrigations (parcelle_id, jour);
create index if not exists pilotage_irrigations_user_idx on public.pilotage_irrigations (user_id);
create index if not exists pilotage_pluies_parcelle_jour_idx on public.pilotage_pluies (parcelle_id, jour);
create index if not exists pilotage_pluies_user_idx on public.pilotage_pluies (user_id);

-- Mise à jour automatique de updated_at
create or replace function public.pilotage_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists pilotage_parcelles_touch on public.pilotage_parcelles;
create trigger pilotage_parcelles_touch before update on public.pilotage_parcelles
  for each row execute function public.pilotage_touch_updated_at();
drop trigger if exists pilotage_pluies_touch on public.pilotage_pluies;
create trigger pilotage_pluies_touch before update on public.pilotage_pluies
  for each row execute function public.pilotage_touch_updated_at();

-- Droits : chaque compte ne voit et ne modifie que ses propres lignes.
alter table public.pilotage_parcelles enable row level security;
alter table public.pilotage_irrigations enable row level security;
alter table public.pilotage_pluies enable row level security;

revoke all on public.pilotage_parcelles, public.pilotage_irrigations, public.pilotage_pluies from anon;
grant select, insert, update, delete on public.pilotage_parcelles, public.pilotage_irrigations, public.pilotage_pluies to authenticated;

do $$
declare t text;
begin
  foreach t in array array['pilotage_parcelles', 'pilotage_irrigations', 'pilotage_pluies'] loop
    execute format('drop policy if exists "%1$s propriétaire" on public.%1$I', t);
    execute format(
      'create policy "%1$s propriétaire" on public.%1$I for all to authenticated
         using ((select auth.uid()) = user_id)
         with check ((select auth.uid()) = user_id)', t);
  end loop;
end $$;

-- Une irrigation ou une pluie ne peut viser qu'une parcelle du même compte.
create or replace function public.pilotage_verifie_parcelle()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.pilotage_parcelles p
    where p.id = new.parcelle_id and p.user_id = new.user_id
  ) then
    raise exception 'Parcelle inconnue pour ce compte';
  end if;
  return new;
end;
$$;

drop trigger if exists pilotage_irrigations_parcelle on public.pilotage_irrigations;
create trigger pilotage_irrigations_parcelle before insert or update on public.pilotage_irrigations
  for each row execute function public.pilotage_verifie_parcelle();
drop trigger if exists pilotage_pluies_parcelle on public.pilotage_pluies;
create trigger pilotage_pluies_parcelle before insert or update on public.pilotage_pluies
  for each row execute function public.pilotage_verifie_parcelle();
