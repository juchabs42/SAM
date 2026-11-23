-- =============================================================================
-- SAM — demandes d'accès (formulaire « Demander un accès » de la page de connexion)
-- -----------------------------------------------------------------------------
-- À coller dans Supabase > SQL Editor > New query, puis Run (relançable).
-- Exécuté le 23/11/2026.
--
-- Un visiteur sans compte laisse ses coordonnées ; les full admins les voient dans
-- Administration > Comptes (« Demandes d'accès ») et invitent la personne en un clic.
-- Le dépôt passe par une fonction qui contrôle les champs (adresse valide, longueurs,
-- champ piège pour les robots, une demande par adresse et par jour, 20 par heure au plus).
-- =============================================================================

create table if not exists public.demandes_acces (
  id uuid primary key default gen_random_uuid(),
  cree_le timestamptz not null default now(),
  prenom text,
  nom text,
  email text not null,
  telephone text,
  structure text,
  commune text,
  profil text,
  message text,
  statut text not null default 'nouvelle' check (statut in ('nouvelle', 'traitee', 'archivee')),
  traitee_le timestamptz
);
create index if not exists demandes_acces_cree_le on public.demandes_acces (cree_le desc);

alter table public.demandes_acces enable row level security;
drop policy if exists demandes_acces_full_admin on public.demandes_acces;
create policy demandes_acces_full_admin on public.demandes_acces for all to authenticated
  using ((select public.is_sam_full_admin())) with check ((select public.is_sam_full_admin()));
revoke all on public.demandes_acces from anon;
grant select, update, delete on public.demandes_acces to authenticated;

create or replace function public.sam_demander_acces(p jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p ->> 'email', '')));
  champ text;
begin
  -- Champ piège invisible : rempli par un robot, ignoré sans le lui dire.
  if coalesce(p ->> 'site', '') <> '' then return true; end if;
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(v_email) > 160 then
    raise exception 'Adresse mail invalide.';
  end if;
  foreach champ in array array['prenom', 'nom', 'telephone', 'structure', 'commune', 'profil'] loop
    if length(coalesce(p ->> champ, '')) > 160 then raise exception 'Champ trop long : %', champ; end if;
  end loop;
  if length(coalesce(p ->> 'message', '')) > 2000 then raise exception 'Message trop long.'; end if;
  if (select count(*) from public.demandes_acces where cree_le > now() - interval '1 hour') >= 20 then
    raise exception 'Trop de demandes en ce moment : réessayez plus tard.';
  end if;
  -- Même adresse dans les dernières 24 heures : rien de plus.
  if exists (select 1 from public.demandes_acces where email = v_email and cree_le > now() - interval '1 day') then
    return true;
  end if;
  insert into public.demandes_acces (prenom, nom, email, telephone, structure, commune, profil, message)
  values (
    nullif(trim(p ->> 'prenom'), ''), nullif(trim(p ->> 'nom'), ''), v_email,
    nullif(trim(p ->> 'telephone'), ''), nullif(trim(p ->> 'structure'), ''),
    nullif(trim(p ->> 'commune'), ''), nullif(trim(p ->> 'profil'), ''), nullif(trim(p ->> 'message'), '')
  );
  return true;
end $$;
revoke all on function public.sam_demander_acces(jsonb) from public;
grant execute on function public.sam_demander_acces(jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
