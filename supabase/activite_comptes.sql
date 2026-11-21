-- =============================================================================
-- SAM Outils · Dernière activité des comptes (onglet Administration)
-- -----------------------------------------------------------------------------
-- La « dernière connexion » fournie par Supabase (last_sign_in_at) ne change que
-- lorsque la personne saisit son mot de passe ou suit un lien de connexion. Une
-- session déjà ouverte se prolonge seule : pendant l'utilisation du site, son jeton
-- est renouvelé environ toutes les heures, sans modifier cette date. Un compte peut
-- donc afficher « il y a 9 jours » alors qu'il a utilisé SAM Outils la veille.
--
-- Cette fonction donne, pour chaque compte, l'heure du dernier renouvellement de
-- session : c'est la dernière utilisation réelle de SAM Outils, à une heure près.
-- Elle est appelée par la fonction « sam-admin » (clé d'administration) ; ni les
-- visiteurs ni les comptes connectés ne peuvent l'appeler.
--
-- À exécuter une fois : Supabase > SQL Editor > New query > coller ce fichier > Run.
-- Puis mettre à jour la fonction « sam-admin » (Edge Functions > sam-admin > Code :
-- coller supabase/functions/sam-admin/index.ts > Deploy).
-- =============================================================================

create or replace function public.sam_dernieres_activites()
returns table (user_id uuid, derniere_activite timestamptz)
language sql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
  select a.user_id, max(a.instant) as derniere_activite
  from (
    -- Sessions ouvertes : création, mise à jour, dernier renouvellement.
    -- Lecture par to_jsonb : « refreshed_at » n'existe pas dans les anciennes versions
    -- d'Auth, et il est enregistré sans fuseau (heure UTC).
    select s.user_id,
           greatest(
             s.created_at,
             (to_jsonb(s) ->> 'updated_at')::timestamptz,
             (to_jsonb(s) ->> 'refreshed_at')::timestamptz
           ) as instant
    from auth.sessions s
    union all
    -- Jetons de renouvellement (un par renouvellement pour les sessions plus anciennes)
    select r.user_id::uuid, greatest(r.created_at, r.updated_at)
    from auth.refresh_tokens r
    where r.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) a
  where a.user_id is not null
  group by a.user_id;
$$;

comment on function public.sam_dernieres_activites() is
  'SAM Outils : dernière utilisation de chaque compte (dernier renouvellement de session). Réservée à la fonction sam-admin.';

-- Réservée à la clé d'administration (fonction sam-admin)
revoke all on function public.sam_dernieres_activites() from public;
revoke all on function public.sam_dernieres_activites() from anon, authenticated;
grant execute on function public.sam_dernieres_activites() to service_role;
