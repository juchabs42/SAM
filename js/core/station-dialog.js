// Fiche station (création et modification) : une seule fenêtre, ouverte depuis
// Administration → Stations (« Modifier », « + Nouvelle station ») et depuis Données
// (« Fiche station »). Réservée aux full admins : la base refuse les autres comptes.
// Elle reprend les styles de l'Administration (classes adm-*, css/tools/admin.css).
import { escapeHtml } from './util.js';

const IGN_ORTHO = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';

const TEMPLATE = `
  <dialog class="adm-dialog is-wide" id="staDialog" aria-labelledby="staDialogTitle">
    <form method="dialog" id="staForm" class="adm-form" novalidate>
      <h2 id="staDialogTitle">Nouvelle station</h2>
      <div class="adm-grid2">
        <label class="adm-field">Identifiant Comsag *<input id="staId" class="adm-input" required placeholder="TCSD_5902" autocomplete="off"></label>
        <label class="adm-field">Nom *<input id="staNom" class="adm-input" required autocomplete="off"></label>
      </div>
      <div class="adm-grid3">
        <label class="adm-field">Commune<input id="staCommune" class="adm-input" placeholder="Marsillargues (34)" autocomplete="off"></label>
        <label class="adm-field">Altitude (m)<input id="staAltitude" class="adm-input" inputmode="decimal" autocomplete="off"></label>
        <label class="adm-field">Identifiant RIMpro<input id="staRimpro" class="adm-input" placeholder="ex. yyNR4nw" autocomplete="off"></label>
      </div>
      <div class="adm-grid2">
        <label class="adm-field">Latitude<input id="staLat" class="adm-input" inputmode="decimal" placeholder="43.6283" autocomplete="off"></label>
        <label class="adm-field">Longitude<input id="staLon" class="adm-input" inputmode="decimal" placeholder="4.1513" autocomplete="off"></label>
      </div>
      <div class="adm-picker" id="staPicker" aria-label="Emplacement de la station : cliquez sur la carte"></div>
      <p class="adm-hint">Cliquez sur la carte (ou déplacez le repère) pour placer la station.</p>
      <div class="adm-checks">
        <label class="adm-check"><input type="checkbox" id="staInstallee"> Installée sur le terrain</label>
        <label class="adm-check"><input type="checkbox" id="staActive"> Collecte automatique des mesures</label>
        <label class="adm-check"><input type="checkbox" id="staPublique"> Visible par tous les comptes</label>
      </div>
      <fieldset class="adm-access hidden" id="staAccess">
        <legend>Qui peut voir les données de cette station ?</legend>
        <div class="adm-access-modes">
          <div class="adm-access-mode">
            <strong>Données météo</strong>
            <span class="adm-muted">température, humidité, pluie, humectation, modèles RIMpro</span>
            <label class="adm-check"><input type="radio" name="staMeteo" value="tous"> Accessibles à tous les comptes</label>
            <label class="adm-check"><input type="radio" name="staMeteo" value="comptes"> Seulement les comptes cochés ci-dessous</label>
          </div>
          <div class="adm-access-mode">
            <strong>Données irrigation</strong>
            <span class="adm-muted">tensiomètres, sondes capacitives, dendromètres</span>
            <label class="adm-check"><input type="radio" name="staIrrigation" value="tous"> Accessibles à tous les comptes</label>
            <label class="adm-check"><input type="radio" name="staIrrigation" value="comptes"> Seulement les comptes cochés ci-dessous</label>
          </div>
        </div>
        <div class="adm-access-accounts hidden" id="staAccounts">
          <input type="search" class="adm-input" id="staAccountSearch" placeholder="Rechercher un compte (nom, adresse, structure)" autocomplete="off">
          <div class="adm-access-table" id="staAccountList"></div>
        </div>
        <p class="adm-hint">Les comptes admin et full admin voient toujours toutes les données.</p>
      </fieldset>
      <p class="adm-hint hidden" id="staAccessSetup">Pour choisir les comptes qui voient les données météo et irrigation, exécutez une fois <code>supabase/acces_stations.sql</code> dans Supabase (SQL Editor).</p>
      <label class="adm-field">Commentaire<textarea id="staCommentaire" class="adm-input" rows="2"></textarea></label>
      <p class="adm-message" id="staMessage" role="status"></p>
      <div class="adm-dialog-actions">
        <button type="button" class="adm-button" id="staCancel">Annuler</button>
        <button type="submit" class="adm-button is-primary" id="staSubmit">Enregistrer</button>
      </div>
    </form>
  </dialog>
`;

/** Comptes (fonction Supabase « sam-admin », action list) pour régler l'accès compte par compte. */
async function listAccounts(supabase) {
  const { data, error } = await supabase.functions.invoke('sam-admin', { body: { action: 'list' } });
  if (error) {
    let message = error.message;
    try {
      const body = await error.context?.json?.();
      if (body?.error) message = body.error;
    } catch { /* réponse non JSON */ }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  if (!Array.isArray(data?.accounts)) throw new Error('la fonction « sam-admin » déployée dans Supabase ne correspond pas au fichier du dépôt.');
  return data.accounts;
}

/**
 * Crée la fenêtre dans `host` (racine de l'outil) et renvoie { open(station|null) }.
 * - accounts : () => Promise<comptes>, pour réutiliser une liste déjà chargée (Administration) ;
 * - onSaved : ({ id, created }) => …, appelé après l'enregistrement (rechargement des stations).
 */
export function createStationDialog(ctx, { host, accounts, onSaved } = {}) {
  const { supabase } = ctx;
  const store = ctx.stations.store;
  const cssReady = ctx.loadToolCss?.('admin') || Promise.resolve();
  const box = document.createElement('div');
  box.className = 'tool-admin sam-station-editor';
  box.innerHTML = TEMPLATE;
  host.appendChild(box);
  ctx.scope.add(() => box.remove());
  const $ = id => box.querySelector(`#${id}`);
  const dialog = $('staDialog');
  const state = { picker: null, pickerMarker: null };
  let accountsCache = null;
  const loadAccounts = async () => {
    if (accounts) return accounts();
    if (!accountsCache) accountsCache = await listAccounts(supabase);
    return accountsCache;
  };
  $('staCancel').addEventListener('click', () => { dialog.returnValue = 'cancel'; dialog.close(); });

  let editing = null;
  async function open(station) {
    await cssReady;
    editing = station;
    $('staDialogTitle').textContent = station ? `Modifier « ${station.nom} »` : 'Nouvelle station';
    $('staId').value = station?.id || '';
    $('staId').disabled = Boolean(station);
    $('staNom').value = station?.nom || '';
    $('staCommune').value = station?.commune || '';
    $('staAltitude').value = Number.isFinite(station?.altitude) ? station.altitude : '';
    $('staRimpro').value = station?.rimpro_id || '';
    $('staLat').value = Number.isFinite(station?.latitude) ? station.latitude : '';
    $('staLon').value = Number.isFinite(station?.longitude) ? station.longitude : '';
    $('staInstallee').checked = station ? station.installee !== false : false;
    $('staActive').checked = station ? station.active !== false : true;
    $('staPublique').checked = station ? station.publique !== false : true;
    $('staCommentaire').value = station?.commentaire || '';
    setupAccess(station);
    $('staMessage').className = 'adm-message is-info';
    $('staMessage').textContent = station ? '' : 'Une station active est collectée automatiquement toutes les 30 minutes (historique des 120 derniers jours au premier passage).';
    dialog.showModal();
    (station ? $('staNom') : $('staId')).focus();
    await setupPicker();
  }

  const readCoord = (id, min, max) => {
    const raw = $(id).value.trim().replace(',', '.');
    if (raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= min && value <= max ? value : NaN;
  };

  async function setupPicker() {
    try {
      await ctx.vendor.leaflet();
    } catch { return; }
    const L = window.L;
    if (!L || ctx.scope.disposed) return;
    const lat = readCoord('staLat', -90, 90);
    const lon = readCoord('staLon', -180, 180);
    const has = Number.isFinite(lat) && Number.isFinite(lon);
    if (!state.picker) {
      state.picker = L.map($('staPicker'), { zoomControl: true, attributionControl: true, maxZoom: 19 });
      L.tileLayer(IGN_ORTHO, { maxZoom: 19, attribution: '© IGN – Géoplateforme' }).addTo(state.picker);
      state.picker.on('click', event => placeMarker(event.latlng.lat, event.latlng.lng, true));
      ctx.scope.add(() => { state.picker?.remove(); state.picker = null; });
    }
    state.picker.invalidateSize();
    if (has) {
      placeMarker(lat, lon, false);
      state.picker.setView([lat, lon], 15);
    } else {
      if (state.pickerMarker) { state.pickerMarker.remove(); state.pickerMarker = null; }
      state.picker.setView([43.75, 4.1], 9);
    }
    setTimeout(() => state.picker?.invalidateSize(), 120);
  }

  function placeMarker(lat, lon, fill) {
    const L = window.L;
    if (!state.picker || !L) return;
    if (!state.pickerMarker) {
      state.pickerMarker = L.marker([lat, lon], { draggable: true, keyboard: false, icon: L.divIcon({ className: 'adm-pick', html: '<span></span>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(state.picker);
      state.pickerMarker.on('dragend', () => {
        const p = state.pickerMarker.getLatLng();
        $('staLat').value = p.lat.toFixed(6);
        $('staLon').value = p.lng.toFixed(6);
      });
    } else state.pickerMarker.setLatLng([lat, lon]);
    if (fill) {
      $('staLat').value = lat.toFixed(6);
      $('staLon').value = lon.toFixed(6);
    }
  }

  ['staLat', 'staLon'].forEach(id => $(id).addEventListener('change', () => {
    const lat = readCoord('staLat', -90, 90);
    const lon = readCoord('staLon', -180, 180);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      placeMarker(lat, lon, false);
      state.picker?.setView([lat, lon], Math.max(state.picker.getZoom(), 14));
    }
  }));

  // ---------------------------------------------------------------------------
  // Accès aux données de la station (météo / irrigation, compte par compte)
  // ---------------------------------------------------------------------------
  const access = { supported: false, grants: new Map(), accounts: [], loadError: null };
  const radio = name => box.querySelector(`input[name="${name}"]:checked`)?.value || 'tous';
  const setRadio = (name, value) => { box.querySelectorAll(`input[name="${name}"]`).forEach(r => { r.checked = r.value === value; }); };

  async function setupAccess(station) {
    // Colonnes absentes : acces_stations.sql pas encore exécuté.
    access.supported = !store.list.length || 'acces_meteo' in (store.list[0] || {});
    $('staAccessSetup').classList.toggle('hidden', access.supported);
    access.grants = new Map();
    access.loadError = null;
    setRadio('staMeteo', station?.acces_meteo || 'tous');
    setRadio('staIrrigation', station?.acces_irrigation || 'tous');
    $('staAccountSearch').value = '';
    refreshAccess();
    if (!access.supported) return;
    try {
      const [grants, list] = await Promise.all([
        station ? supabase.from('station_acces').select('user_id,meteo,irrigation').eq('station_id', station.id) : Promise.resolve({ data: [] }),
        loadAccounts()
      ]);
      if (grants.error) throw grants.error;
      access.grants = new Map((grants.data || []).map(g => [g.user_id, { meteo: g.meteo, irrigation: g.irrigation }]));
      access.accounts = list || [];
    } catch (error) {
      access.loadError = error;
    }
    renderAccessAccounts();
  }

  function refreshAccess() {
    const shared = $('staPublique').checked;
    $('staAccess').classList.toggle('hidden', shared || !access.supported);
    const meteo = radio('staMeteo') === 'comptes';
    const irrigation = radio('staIrrigation') === 'comptes';
    $('staAccounts').classList.toggle('hidden', !meteo && !irrigation);
    $('staAccountList').querySelectorAll('input[data-kind="meteo"]').forEach(i => { i.disabled = !meteo; });
    $('staAccountList').querySelectorAll('input[data-kind="irrigation"]').forEach(i => { i.disabled = !irrigation; });
  }

  function renderAccessAccounts() {
    const box = $('staAccountList');
    if (access.loadError) {
      box.innerHTML = `<p class="adm-error">Liste des comptes indisponible : ${escapeHtml(access.loadError.message || access.loadError)}</p>`;
      return;
    }
    const q = $('staAccountSearch').value.trim().toLowerCase();
    // Les admins voient déjà tout : seuls les comptes « normal » sont proposés.
    const list = access.accounts
      .filter(a => (a.role || (a.admin ? 'full' : 'normal')) === 'normal')
      .filter(a => !q || [a.email, a.prenom, a.nom, a.structure, a.commune].some(v => String(v || '').toLowerCase().includes(q)))
      .sort((a, b) => accountLabel(a).localeCompare(accountLabel(b), 'fr'));
    if (!list.length) {
      box.innerHTML = `<p class="adm-muted">${q ? 'Aucun compte ne correspond.' : 'Aucun compte « normal » pour le moment : invitez d’abord les producteurs (onglet Comptes).'}</p>`;
      return;
    }
    box.innerHTML = `<table class="adm-table is-compact">
      <thead><tr><th>Compte</th><th>Météo</th><th>Irrigation</th></tr></thead>
      <tbody>${list.map(a => {
        const g = access.grants.get(a.id) || {};
        const sub = [a.structure, accountLabel(a) === a.email ? null : a.email].filter(Boolean).join(" · ");
        return `<tr data-user="${escapeHtml(a.id)}">
          <td data-label="Compte"><strong>${escapeHtml(accountLabel(a))}</strong><span class="adm-muted">${escapeHtml(sub)}</span></td>
          <td data-label="Météo"><input type="checkbox" data-kind="meteo" aria-label="Données météo pour ${escapeHtml(accountLabel(a))}"${g.meteo ? ' checked' : ''}></td>
          <td data-label="Irrigation"><input type="checkbox" data-kind="irrigation" aria-label="Données irrigation pour ${escapeHtml(accountLabel(a))}"${g.irrigation ? ' checked' : ''}></td>
        </tr>`;
      }).join('')}</tbody></table>`;
    refreshAccess();
  }

  const accountLabel = a => [a.prenom, a.nom].filter(Boolean).join(' ') || a.email;

  $('staPublique').addEventListener('change', refreshAccess);
  box.querySelectorAll('input[name="staMeteo"], input[name="staIrrigation"]').forEach(r => r.addEventListener('change', refreshAccess));
  $('staAccountSearch').addEventListener('input', renderAccessAccounts);
  $('staAccountList').addEventListener('change', event => {
    const input = event.target.closest('input[data-kind]');
    if (!input) return;
    const id = input.closest('tr').dataset.user;
    const g = { meteo: false, irrigation: false, ...(access.grants.get(id) || {}) };
    g[input.dataset.kind] = input.checked;
    access.grants.set(id, g);
  });

  async function saveAccess(stationId) {
    if (!access.supported || access.loadError) return;
    const rows = [...access.grants].map(([user_id, g]) => ({ station_id: stationId, user_id, meteo: Boolean(g.meteo), irrigation: Boolean(g.irrigation), updated_at: new Date().toISOString() }));
    const keep = rows.filter(r => r.meteo || r.irrigation);
    const drop = rows.filter(r => !r.meteo && !r.irrigation).map(r => r.user_id);
    if (keep.length) {
      const { error } = await supabase.from('station_acces').upsert(keep, { onConflict: 'station_id,user_id' });
      if (error) throw error;
    }
    if (drop.length) {
      const { error } = await supabase.from('station_acces').delete().eq('station_id', stationId).in('user_id', drop);
      if (error) throw error;
    }
  }

  $('staForm').addEventListener('submit', async event => {
    event.preventDefault();
    const id = $('staId').value.trim();
    const nom = $('staNom').value.trim();
    const lat = readCoord('staLat', -90, 90);
    const lon = readCoord('staLon', -180, 180);
    const alt = $('staAltitude').value.trim() === '' ? null : Number($('staAltitude').value.trim().replace(',', '.'));
    const fail = (message, info = false) => {
      $('staMessage').className = `adm-message${info ? ' is-info' : ''}`;
      $('staMessage').textContent = message;
    };
    if (!editing && !/^[A-Za-z0-9_-]{2,40}$/.test(id)) return fail('Identifiant Comsag invalide (lettres, chiffres, _ ou -), par ex. TCSD_5902.');
    if (!editing && store.list.some(s => s.id === id)) return fail('Une station porte déjà cet identifiant.');
    if (!nom) return fail('Le nom est obligatoire.');
    if (Number.isNaN(lat) || Number.isNaN(lon)) return fail('Coordonnées invalides (latitude entre -90 et 90, longitude entre -180 et 180).');
    if ((lat === null) !== (lon === null)) return fail('Indiquez la latitude et la longitude, ou aucune des deux.');
    if (alt !== null && !Number.isFinite(alt)) return fail('Altitude invalide.');
    const row = {
      nom,
      commune: $('staCommune').value.trim() || null,
      latitude: lat,
      longitude: lon,
      altitude: alt,
      rimpro_id: $('staRimpro').value.trim() || null,
      installee: $('staInstallee').checked,
      active: $('staActive').checked,
      publique: $('staPublique').checked,
      ...(access.supported ? { acces_meteo: radio('staMeteo'), acces_irrigation: radio('staIrrigation') } : {}),
      commentaire: $('staCommentaire').value.trim() || null,
      updated_at: new Date().toISOString()
    };
    $('staSubmit').disabled = true;
    fail('Enregistrement…', true);
    try {
      const { error } = editing
        ? await supabase.from('stations').update(row).eq('id', editing.id)
        : await supabase.from('stations').insert({ id, reseau: 'SAM', ...row });
      if (error) throw error;
      await saveAccess(editing ? editing.id : id);
      dialog.close();
      ctx.ui.toast(editing ? 'Station mise à jour.' : `Station créée${row.active ? ' : la collecte démarrera dans les 30 minutes.' : '.'}`, 5000);
      await onSaved?.({ id: editing ? editing.id : id, created: !editing });
    } catch (error) {
      fail(`Enregistrement impossible : ${error.message || error}`);
    } finally {
      $('staSubmit').disabled = false;
    }
  });


  return { open };
}
