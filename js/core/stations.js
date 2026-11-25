// Stations du réseau SAM : liste partagée entre le bandeau de gauche (onglet Données)
// et la page Données. Favoris du compte en premier, autres stations repliées.
import { auth } from './auth.js';
import { profile } from './profile.js';
import { createEmitter } from './util.js';

const HOUR = 3600000;
const LATE_HOURS = 3;
const SILENT_HOURS = 48;
const emitter = createEmitter();
const state = { list: [], loaded: false, loading: null, error: null, selectedId: null, groupes: [], selectedGroupId: null };
/** Nombre maximal de stations dans un groupe (couleurs bien distinctes sur les graphiques). */
export const GROUP_MAX = 8;

/** État de transmission d'une station. */
export function stationState(station) {
  const hours = station.derniere_mesure ? (Date.now() - new Date(station.derniere_mesure).getTime()) / HOUR : Infinity;
  if (station.installee === false && hours > SILENT_HOURS) return { key: 'pending', label: 'Pas encore installée' };
  if (!station.derniere_mesure) return { key: 'never', label: 'Aucune donnée' };
  if (!station.active) return { key: 'off', label: 'Collecte arrêtée' };
  if (hours <= LATE_HOURS) return { key: 'ok', label: 'Transmet' };
  if (hours <= SILENT_HOURS) return { key: 'late', label: 'En retard' };
  return { key: 'silent', label: 'Muette' };
}

/** Station posée et active dont la transmission pose problème (en retard, muette, jamais reçue, erreur Comsag). */
export function stationToWatch(station) {
  if (station.installee === false || station.active === false) return false;
  return ['late', 'silent', 'never'].includes(stationState(station).key) || Boolean(station.derniere_erreur);
}

const byName = (a, b) => a.nom.localeCompare(b.nom, 'fr');

export const stationStore = {
  get list() { return state.list; },
  get loaded() { return state.loaded; },
  get error() { return state.error; },
  get selectedId() { return state.selectedId; },
  /** Table à lire pour les mesures : la vue filtrée selon les droits du compte quand elle existe. */
  get mesuresTable() { return state.mesures || 'station_mesures'; },
  get selected() { return state.list.find(s => s.id === state.selectedId) || null; },
  /** Groupes de stations du compte (conseiller, admin, full admin), dans l'ordre de création. */
  get groupes() { return state.groupes; },
  get selectedGroupId() { return state.selectedGroupId; },
  get selectedGroup() { return state.groupes.find(g => g.id === state.selectedGroupId) || null; },
  /** Stations d'un groupe visibles par le compte, dans l'ordre du groupe. */
  groupStations(group) { return (group?.stations || []).map(id => state.list.find(s => s.id === id)).filter(Boolean); },
  onChange: fn => emitter.on(fn),

  async load(force = false) {
    if (state.loaded && !force) return state.list;
    if (!state.loading) {
      state.loading = (async () => {
        // Les favoris du compte décident de la station ouverte par défaut.
        await profile.load().catch(() => null);
        if (!auth.client) throw new Error('Connexion à la base indisponible.');
        const [{ data, error }, rights] = await Promise.all([
          auth.client.from('stations').select('*').order('nom'),
          auth.client.rpc('sam_acces_stations')
        ]);
        if (error) throw error;
        // Droits du compte sur chaque station (acces_stations.sql). Sans ce script : tout est lisible.
        const map = rights.error ? null : new Map((rights.data || []).map(r => [r.station_id, r]));
        state.list = (data || []).map(station => ({
          ...station,
          acces: map ? { meteo: Boolean(map.get(station.id)?.meteo), irrigation: Boolean(map.get(station.id)?.irrigation) } : { meteo: true, irrigation: true }
        }));
        state.mesures = map ? 'station_mesures_visibles' : 'station_mesures';
        await stationStore.loadGroups();
        state.loaded = true;
        state.error = null;
      })().catch(error => {
        state.error = error;
        state.loaded = true;
      }).finally(() => { state.loading = null; });
    }
    await state.loading;
    stationStore.ensureSelection();
    emitter.emit({ type: 'list' });
    return state.list;
  },

  /** Ordre du bandeau : favoris (dans l'ordre choisi), puis stations installées, puis à venir. */
  groups() {
    const favIds = profile.favorites();
    const favorites = favIds.map(id => state.list.find(s => s.id === id)).filter(Boolean);
    const rest = state.list.filter(s => !favIds.includes(s.id));
    const installed = rest.filter(s => s.installee !== false).sort(byName);
    const pending = auth.isFullAdmin ? rest.filter(s => s.installee === false).sort(byName) : [];
    return { favorites, installed, pending };
  },

  /** Première station du bandeau : premier favori, sinon première station installée. */
  first() {
    const { favorites, installed, pending } = stationStore.groups();
    return favorites[0] || installed[0] || pending[0] || null;
  },

  ensureSelection() {
    const visible = stationStore.groups();
    const ids = [...visible.favorites, ...visible.installed, ...visible.pending].map(s => s.id);
    if (!state.selectedId || !ids.includes(state.selectedId)) state.selectedId = stationStore.first()?.id || null;
  },

  select(id) {
    if (!id || (id === state.selectedId && !state.selectedGroupId)) return;
    state.selectedId = id;
    state.selectedGroupId = null;
    emitter.emit({ type: 'select', id });
  },

  // -------------------------------------------------------------------------
  // Groupes de stations (supabase/conseillers.sql) : personnels, 8 stations au plus
  // -------------------------------------------------------------------------
  async loadGroups() {
    if (!auth.peutGrouper || !auth.client) { state.groupes = []; state.selectedGroupId = null; return state.groupes; }
    const { data, error } = await auth.client.from('groupes_stations').select('*').order('ordre').order('cree_le');
    state.groupes = error ? [] : (data || []).map(g => ({ ...g, id: String(g.id) }));
    if (state.selectedGroupId && !state.groupes.some(g => g.id === state.selectedGroupId)) state.selectedGroupId = null;
    return state.groupes;
  },

  selectGroup(id) {
    id = id ? String(id) : null;
    if (!id || id === state.selectedGroupId) return;
    state.selectedGroupId = id;
    emitter.emit({ type: 'group', id });
  },

  /** Crée ou modifie un groupe ; renvoie le groupe enregistré. */
  async saveGroup({ id, nom, stations }) {
    const row = { nom: String(nom || '').trim().slice(0, 60), stations: [...new Set(stations)].slice(0, GROUP_MAX), maj_le: new Date().toISOString() };
    const query = id
      ? auth.client.from('groupes_stations').update(row).eq('id', id).select().single()
      : auth.client.from('groupes_stations').insert({ ...row, ordre: state.groupes.length }).select().single();
    const { data: row0, error } = await query;
    if (error) throw error;
    const data = { ...row0, id: String(row0.id) };
    const i = state.groupes.findIndex(g => g.id === data.id);
    if (i >= 0) state.groupes[i] = data; else state.groupes.push(data);
    emitter.emit({ type: id ? 'groups' : 'group-created', id: data.id });
    if (state.selectedGroupId === data.id) emitter.emit({ type: 'group', id: data.id });
    return data;
  },

  async deleteGroup(id) {
    const { error } = await auth.client.from('groupes_stations').delete().eq('id', id);
    if (error) throw error;
    state.groupes = state.groupes.filter(g => g.id !== id);
    const wasSelected = state.selectedGroupId === id;
    if (wasSelected) state.selectedGroupId = null;
    emitter.emit({ type: 'groups' });
    if (wasSelected) emitter.emit({ type: 'select', id: state.selectedId });
  },

  /** Met à jour une station après modification (fiche station). */
  patch(id, values) {
    const station = state.list.find(s => s.id === id);
    if (station) Object.assign(station, values);
    emitter.emit({ type: 'list' });
  }
};
