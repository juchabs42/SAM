-- =============================================================================
-- SAM Outils — mesures Comsag en double : fusion (à exécuter une fois, relançable)
-- Exécuté le 22/11/2026 : 239 copies fusionnées (6 286 → 6 047 mesures).
-- -----------------------------------------------------------------------------
-- Comsag renvoie parfois la même mesure horaire deux fois, avec un horodatage décalé
-- d'une seconde (plus rarement de quelques dizaines de secondes). Les deux étaient
-- enregistrées : pluie de l'heure comptée deux fois, « 26 / 24 mesures » par jour…
--   1. la collecte (comsag_integrer) reconnaît désormais ces copies et les fusionne ;
--   2. les copies déjà enregistrées sont fusionnées avec la mesure d'origine (une valeur
--      absente de l'une est reprise de l'autre), puis supprimées ;
--   3. les lignes supprimées sont gardées dans sam_private.station_mesures_doublons.
-- Une même mesure = même station, moins de 60 s d'écart, aucune valeur contradictoire.
-- Deux mesures proches mais différentes (jour d'installation, nuit du changement d'heure)
-- sont conservées.
-- =============================================================================

-- Une même mesure revient parfois de Comsag avec un horodatage décalé d'une seconde (ou plus,
-- rarement) : on la reconnaît (même station, moins de 60 s d'écart, aucune valeur contradictoire)
-- et on la fusionne avec celle déjà enregistrée au lieu de l'ajouter (sinon pluie comptée deux fois).
create or replace function sam_private.meme_mesure(a public.station_mesures, b public.station_mesures)
returns boolean language sql immutable set search_path = '' as $$
  select a.station_id = b.station_id
     and abs(extract(epoch from a.mesure_le - b.mesure_le)) <= 60
     and (a.t_air is null or b.t_air is null or a.t_air = b.t_air)
     and (a.hr is null or b.hr is null or a.hr = b.hr)
     and (a.pluie is null or b.pluie is null or a.pluie = b.pluie)
     and not exists (
       select 1 from jsonb_each(coalesce(a.autres, '{}'::jsonb)) e
       where e.value <> 'null'::jsonb
         and coalesce(b.autres -> e.key, 'null'::jsonb) <> 'null'::jsonb
         and b.autres -> e.key <> e.value)
$$;

-- Complète les capteurs de a avec ceux de b (valeurs de a prioritaires, valeurs vides ignorées).
create or replace function sam_private.fusion_autres(a jsonb, b jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(a, '{}'::jsonb) || coalesce((
    select jsonb_object_agg(e.key, e.value)
    from jsonb_each(coalesce(b, '{}'::jsonb)) e
    where e.value <> 'null'::jsonb and coalesce(a -> e.key, 'null'::jsonb) = 'null'::jsonb
  ), '{}'::jsonb)
$$;

-- Range les réponses reçues dans station_mesures ; renvoie le nombre de mesures écrites.
create or replace function sam_private.comsag_integrer()
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_json jsonb;
  v_lignes integer;
  v_total integer := 0;
  v_capteurs text[];
  v_erreur text;
  v_m public.station_mesures;          -- mesure reçue
  v_existante public.station_mesures;  -- même mesure déjà enregistrée
begin
  for r in
    select q.request_id, q.station_id, q.demande_le,
           resp.status_code, resp.content, resp.timed_out, resp.error_msg,
           (resp.id is not null) as recue
    from sam_private.comsag_requetes q
    left join net._http_response resp on resp.id = q.request_id
    order by q.request_id
  loop
    if not r.recue then
      -- Pas encore de réponse : on attend, puis on abandonne au bout de 2 heures.
      if r.demande_le < now() - interval '2 hours' then
        update public.stations set derniere_synchro = now(), derniere_erreur = 'Pas de réponse de Comsag'
        where id = r.station_id;
        delete from sam_private.comsag_requetes where request_id = r.request_id;
      end if;
      continue;
    end if;

    v_json := null;
    v_erreur := null;
    if coalesce(r.timed_out, false) then
      v_erreur := 'Délai de réponse dépassé';
    elsif r.error_msg is not null then
      v_erreur := 'Erreur réseau vers Comsag';
    elsif r.status_code <> 200 then
      v_erreur := 'Comsag répond ' || r.status_code;
    else
      begin
        v_json := r.content::jsonb;
      exception when others then
        v_erreur := 'Réponse Comsag illisible';
      end;
      if v_json ? 'error' then
        v_erreur := 'Comsag : ' || coalesce(v_json #>> '{error,message}', 'erreur') || coalesce(' (' || (v_json #>> '{error,code}') || ')', '');
        v_json := null;
      end if;
    end if;

    if v_erreur is not null then
      update public.stations set derniere_synchro = now(), derniere_erreur = v_erreur where id = r.station_id;
    else
      v_lignes := 0;
      for v_m in
        select r.station_id,
               sam_private.horodatage(x ->> 'timestamp'),
               sam_private.nombre(x ->> 't1'),
               sam_private.nombre(x ->> 'hyg1'),
               sam_private.nombre(x ->> 'pluv'),
               x - 'timestamp' - 't1' - 'hyg1' - 'pluv'
        from jsonb_array_elements(coalesce(v_json -> 'datas', '[]'::jsonb)) as x
        where jsonb_typeof(x) = 'object' and sam_private.horodatage(x ->> 'timestamp') is not null
        order by 2
      loop
        -- Même mesure déjà enregistrée à quelques secondes près : on la complète.
        select m.* into v_existante
        from public.station_mesures m
        where m.station_id = v_m.station_id
          and m.mesure_le between v_m.mesure_le - interval '60 seconds' and v_m.mesure_le + interval '60 seconds'
          and m.mesure_le <> v_m.mesure_le
          and sam_private.meme_mesure(m, v_m)
        order by abs(extract(epoch from m.mesure_le - v_m.mesure_le)), m.mesure_le
        limit 1;
        if found then
          update public.station_mesures as sm set
            t_air = coalesce(sm.t_air, v_m.t_air),
            hr = coalesce(sm.hr, v_m.hr),
            pluie = coalesce(sm.pluie, v_m.pluie),
            autres = sam_private.fusion_autres(sm.autres, v_m.autres)
          where sm.station_id = v_existante.station_id and sm.mesure_le = v_existante.mesure_le;
        else
          insert into public.station_mesures as sm (station_id, mesure_le, t_air, hr, pluie, autres)
          values (v_m.station_id, v_m.mesure_le, v_m.t_air, v_m.hr, v_m.pluie, v_m.autres)
          on conflict (station_id, mesure_le) do update set
            t_air = coalesce(excluded.t_air, sm.t_air),
            hr = coalesce(excluded.hr, sm.hr),
            pluie = coalesce(excluded.pluie, sm.pluie),
            autres = sam_private.fusion_autres(excluded.autres, sm.autres);
        end if;
        v_lignes := v_lignes + 1;
      end loop;
      v_total := v_total + v_lignes;

      select coalesce(array_agg(distinct k order by k), '{}') into v_capteurs
      from jsonb_array_elements(coalesce(v_json -> 'datas', '[]'::jsonb)) as d,
           lateral jsonb_object_keys(case when jsonb_typeof(d) = 'object' then d else '{}'::jsonb end) as k
      where k <> 'timestamp';

      update public.stations st set
        derniere_synchro = now(),
        derniere_erreur = null,
        capteurs = array(select distinct c from unnest(st.capteurs || v_capteurs) as c order by c),
        premiere_mesure = (select min(m.mesure_le) from public.station_mesures m where m.station_id = st.id),
        derniere_mesure = (select max(m.mesure_le) from public.station_mesures m where m.station_id = st.id)
      where st.id = r.station_id;
      -- Une station « pas encore installée » qui transmet devient installée.
      update public.stations set installee = true
      where id = r.station_id and not installee and derniere_mesure > now() - interval '2 days';
    end if;
    delete from sam_private.comsag_requetes where request_id = r.request_id;
  end loop;
  return v_total;
end $$;

revoke all on function sam_private.comsag_integrer() from public, anon, authenticated;
revoke all on function sam_private.meme_mesure(public.station_mesures, public.station_mesures) from public, anon, authenticated;
revoke all on function sam_private.fusion_autres(jsonb, jsonb) from public, anon, authenticated;

-- Sauvegarde des copies supprimées
create table if not exists sam_private.station_mesures_doublons (
  station_id text not null,
  mesure_le timestamptz not null,
  t_air real,
  hr real,
  pluie real,
  autres jsonb,
  fusionnee_dans timestamptz not null,           -- horodatage de la mesure gardée
  supprimee_le timestamptz not null default now()
);
revoke all on sam_private.station_mesures_doublons from public, anon, authenticated;

-- Fusionne les copies déjà enregistrées ; renvoie le nombre de lignes supprimées.
create or replace function sam_private.fusionner_doublons()
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r public.station_mesures;
  g public.station_mesures;   -- mesure gardée
  v_n integer := 0;
begin
  for r in select * from public.station_mesures order by station_id, mesure_le loop
    if g.station_id is not null and sam_private.meme_mesure(g, r) then
      insert into sam_private.station_mesures_doublons (station_id, mesure_le, t_air, hr, pluie, autres, fusionnee_dans)
      values (r.station_id, r.mesure_le, r.t_air, r.hr, r.pluie, r.autres, g.mesure_le);
      update public.station_mesures as sm set
        t_air = coalesce(sm.t_air, r.t_air),
        hr = coalesce(sm.hr, r.hr),
        pluie = coalesce(sm.pluie, r.pluie),
        autres = sam_private.fusion_autres(sm.autres, r.autres)
      where sm.station_id = g.station_id and sm.mesure_le = g.mesure_le
      returning sm.* into g;
      delete from public.station_mesures where station_id = r.station_id and mesure_le = r.mesure_le;
      v_n := v_n + 1;
    else
      g := r;
    end if;
  end loop;
  return v_n;
end $$;
revoke all on function sam_private.fusionner_doublons() from public, anon, authenticated;

select sam_private.fusionner_doublons() as copies_supprimees;
