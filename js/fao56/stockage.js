// Enregistrement des parcelles de pilotage : Supabase (tables pilotage_*, RLS par compte).
// Tant que le script supabase/pilotage.sql n'a pas été exécuté, l'outil bascule en mode local
// (données gardées sur l'appareil) pour rester utilisable ; le mode est affiché à l'écran.

const TABLES_ABSENTES = new Set(['42P01', 'PGRST205', 'PGRST204']);

function uid() {
  return globalThis.crypto?.randomUUID ? crypto.randomUUID() : `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function creerStockage(client, storage) {
  const L = {
    get: k => storage.get(`pilotage.local.${k}`, []),
    set: (k, v) => storage.set(`pilotage.local.${k}`, v)
  };

  const api = {
    mode: client ? 'supabase' : 'local',
    erreur: null,

    async init() {
      if (!client) { api.mode = 'local'; return api.mode; }
      const { error } = await client.from('pilotage_parcelles').select('id').limit(1);
      if (error) {
        if (TABLES_ABSENTES.has(error.code) || /does not exist|schema cache/i.test(error.message || '')) {
          api.mode = 'local';
          api.erreur = 'Tables Supabase absentes : exécuter supabase/pilotage.sql. Les données restent sur cet appareil en attendant.';
        } else {
          throw error;
        }
      } else {
        api.mode = 'supabase';
      }
      return api.mode;
    },

    async parcelles() {
      if (api.mode === 'local') return L.get('parcelles').filter(p => !p.archivee).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
      const { data, error } = await client.from('pilotage_parcelles').select('*').eq('archivee', false).order('nom');
      if (error) throw error;
      return data || [];
    },

    async enregistrerParcelle(p) {
      const ligne = { ...p, updated_at: new Date().toISOString() };
      if (api.mode === 'local') {
        const all = L.get('parcelles');
        if (!ligne.id) { ligne.id = uid(); ligne.created_at = ligne.updated_at; all.push(ligne); }
        else { const i = all.findIndex(x => x.id === ligne.id); if (i >= 0) all[i] = { ...all[i], ...ligne }; else all.push(ligne); }
        L.set('parcelles', all);
        return ligne;
      }
      delete ligne.updated_at;
      delete ligne.created_at;
      delete ligne.user_id;
      const q = ligne.id
        ? client.from('pilotage_parcelles').update(ligne).eq('id', ligne.id).select().single()
        : client.from('pilotage_parcelles').insert(ligne).select().single();
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },

    async supprimerParcelle(id) {
      if (api.mode === 'local') {
        L.set('parcelles', L.get('parcelles').filter(p => p.id !== id));
        L.set('irrigations', L.get('irrigations').filter(r => r.parcelle_id !== id));
        L.set('pluies', L.get('pluies').filter(r => r.parcelle_id !== id));
        return;
      }
      const { error } = await client.from('pilotage_parcelles').delete().eq('id', id);
      if (error) throw error;
    },

    async irrigations(parcelleId) {
      if (api.mode === 'local') return L.get('irrigations').filter(r => r.parcelle_id === parcelleId).sort((a, b) => a.jour.localeCompare(b.jour));
      const { data, error } = await client.from('pilotage_irrigations').select('*').eq('parcelle_id', parcelleId).order('jour');
      if (error) throw error;
      return data || [];
    },

    async ajouterIrrigations(lignes) {
      if (!lignes.length) return [];
      if (api.mode === 'local') {
        const all = L.get('irrigations');
        const res = lignes.map(l => ({ ...l, id: uid(), created_at: new Date().toISOString() }));
        L.set('irrigations', all.concat(res));
        return res;
      }
      const { data, error } = await client.from('pilotage_irrigations').insert(lignes).select();
      if (error) throw error;
      return data || [];
    },

    async supprimerIrrigations(ids) {
      if (!ids.length) return;
      if (api.mode === 'local') { L.set('irrigations', L.get('irrigations').filter(r => !ids.includes(r.id))); return; }
      const { error } = await client.from('pilotage_irrigations').delete().in('id', ids);
      if (error) throw error;
    },

    async pluies(parcelleId) {
      if (api.mode === 'local') return L.get('pluies').filter(r => r.parcelle_id === parcelleId).sort((a, b) => a.jour.localeCompare(b.jour));
      const { data, error } = await client.from('pilotage_pluies').select('*').eq('parcelle_id', parcelleId).order('jour');
      if (error) throw error;
      return data || [];
    },

    async enregistrerPluies(lignes) {
      if (!lignes.length) return;
      if (api.mode === 'local') {
        const all = L.get('pluies');
        for (const l of lignes) {
          const i = all.findIndex(r => r.parcelle_id === l.parcelle_id && r.jour === l.jour);
          if (i >= 0) all[i] = { ...all[i], pluie_mm: l.pluie_mm };
          else all.push({ ...l, id: uid() });
        }
        L.set('pluies', all);
        return;
      }
      const { error } = await client.from('pilotage_pluies').upsert(lignes, { onConflict: 'parcelle_id,jour' });
      if (error) throw error;
    },

    async supprimerPluie(id) {
      if (api.mode === 'local') { L.set('pluies', L.get('pluies').filter(r => r.id !== id)); return; }
      const { error } = await client.from('pilotage_pluies').delete().eq('id', id);
      if (error) throw error;
    },

    /** Parcelles de l'ancien outil « Bilan hydrique » du compte, pour reprise. */
    async anciennesParcelles() {
      if (!client) return [];
      const { data, error } = await client.from('bilan_parcels').select('*').order('name');
      if (error) return [];
      return data || [];
    },

    async anciennesDonnees(parcelId) {
      const [irr, pl] = await Promise.all([
        client.from('bilan_irrigations').select('irrigation_date,amount_mm').eq('parcel_id', parcelId),
        client.from('bilan_rain_corrections').select('rain_date,amount_mm').eq('parcel_id', parcelId)
      ]);
      return { irrigations: irr.data || [], pluies: pl.data || [] };
    }
  };
  return api;
}
