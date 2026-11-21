// SAM Administration — réservé aux administrateurs SAM.
// Trois volets : comptes (fonction Supabase « sam-admin »), stations (table stations,
// collecte Comsag), capteurs (mesures brutes de chaque station, dictionnaire des capteurs).
import { stationState } from '../core/stations.js';
import { escapeHtml, formatNumber, fetchAllRows, storage } from '../core/util.js';
import { icons } from '../core/icons.js';
import { createZoomGroup, enableChartZoom, resetZoomGroup, timeAxis, timeTicksPlugin } from '../core/charts.js';

const TZ = 'Europe/Paris';
const HOUR = 3600000;
const TABS = [
  { id: 'comptes', label: 'Comptes', icon: icons.users },
  { id: 'stations', label: 'Stations', icon: icons.station },
  { id: 'capteurs', label: 'Capteurs', icon: icons.activity }
];
// Capteurs rangés dans des colonnes dédiées de station_mesures ; les autres sont dans « autres ».
const BASE_COLUMNS = { t1: 't_air', hyg1: 'hr', pluv: 'pluie' };
const IGN_ORTHO = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';

const dateTimeFormat = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const shortFormat = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const dayKeyFormat = new Intl.DateTimeFormat('fr-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hourKeyFormat = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtDateTime = value => (value ? dateTimeFormat.format(new Date(value)).replace(' ', ' à ') : '—');
const num = value => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

function ago(value) {
  if (!value) return 'jamais';
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000);
  if (minutes < 1) return 'à l’instant';
  if (minutes < 60) return `il y a ${minutes} min`;
  if (minutes < 48 * 60) return `il y a ${Math.round(minutes / 60)} h`;
  return `il y a ${Math.round(minutes / 1440)} jours`;
}

const TEMPLATE = `
<div class="adm-main">
  <div class="adm-denied hidden" id="admDenied">
    <strong>Page réservée aux comptes « full admin ».</strong>
    <span>La gestion des comptes, des stations et des capteurs n’est pas ouverte à votre rôle.</span>
  </div>
  <div id="admContent" class="hidden">
    <div class="adm-tabs" role="tablist" aria-label="Administration">
      ${TABS.map(t => `<button type="button" role="tab" data-tab="${t.id}">${t.icon}<span>${t.label}</span></button>`).join('')}
    </div>

    <!-- Comptes ------------------------------------------------------------ -->
    <section class="adm-panel" data-panel="comptes" role="tabpanel">
      <div class="adm-card">
        <div class="adm-bar">
          <div>
            <h2>Comptes</h2>
            <p class="adm-sub" id="accSummary">Chargement…</p>
          </div>
          <div class="adm-actions">
            <input type="search" id="accSearch" class="adm-input" placeholder="Rechercher un nom, une adresse, une structure" aria-label="Rechercher un compte">
            <button type="button" class="adm-button is-primary" id="accInviteBtn">+ Inviter un compte</button>
          </div>
        </div>
        <div class="adm-setup hidden" id="accSetup"></div>
        <p class="adm-hint adm-note hidden" id="accActiviteHint"></p>
        <div id="accList" class="adm-list"></div>
      </div>
    </section>

    <!-- Stations ----------------------------------------------------------- -->
    <section class="adm-panel" data-panel="stations" role="tabpanel">
      <div class="adm-card">
        <div class="adm-bar">
          <div>
            <h2>Stations</h2>
            <p class="adm-sub" id="staSummary">Chargement…</p>
          </div>
          <div class="adm-actions">
            <button type="button" class="adm-button" id="staSyncAll">Synchroniser toutes les stations</button>
            <button type="button" class="adm-button is-primary" id="staNewBtn">+ Nouvelle station</button>
          </div>
        </div>
        <div id="staAlerts"></div>
        <div id="staList" class="adm-list"></div>
      </div>
    </section>

    <!-- Capteurs ----------------------------------------------------------- -->
    <section class="adm-panel" data-panel="capteurs" role="tabpanel">
      <div class="adm-card">
        <div class="adm-bar">
          <div>
            <h2>Capteurs</h2>
            <p class="adm-sub">Toutes les mesures brutes d’une station, y compris celles qui n’apparaissent pas dans l’onglet Données (batterie, capteurs masqués…).</p>
          </div>
          <div class="adm-actions">
            <label class="adm-field-inline">Station <select id="capStation" class="adm-input"></select></label>
            <label class="adm-field-inline">Période
              <select id="capPeriod" class="adm-input">
                <option value="2">48 heures</option>
                <option value="7">7 jours</option>
                <option value="30">30 jours</option>
                <option value="90">90 jours</option>
              </select>
            </label>
          </div>
        </div>
        <div id="capSensors" class="adm-chips" aria-label="Capteurs affichés"></div>
        <div id="capLatest" class="adm-latest"></div>
        <p class="adm-hint" id="capHint">Glissez sur un graphique pour zoomer · double-clic pour revenir en arrière.</p>
        <div id="capCharts" class="adm-charts"></div>
      </div>
      <div class="adm-card">
        <div class="adm-bar">
          <div>
            <h2>Noms des capteurs</h2>
            <p class="adm-sub">Libellés et unités, communs à toutes les stations. La case « Affiché » vaut pour la station choisie : décochez un capteur absent ou hors service (station sans pluviomètre…) pour le retirer de ses données.</p>
          </div>
          <div class="adm-actions">
            <label class="adm-field-inline">Station <select id="capDicStation" class="adm-input"></select></label>
          </div>
        </div>
        <p class="adm-hint" id="capMaskHint"></p>
        <div id="capDictionary" class="adm-list"></div>
      </div>
    </section>
  </div>

  <!-- Invitation ------------------------------------------------------------ -->
  <dialog class="adm-dialog" id="accDialog" aria-labelledby="accDialogTitle">
    <form method="dialog" id="accForm" class="adm-form" novalidate>
      <h2 id="accDialogTitle">Inviter un compte</h2>
      <p class="adm-sub">La personne reçoit un mail avec un lien pour choisir son mot de passe.</p>
      <label class="adm-field">Adresse mail *<input type="email" id="accEmail" class="adm-input" required autocomplete="off"></label>
      <div class="adm-grid2">
        <label class="adm-field">Prénom<input id="accPrenom" class="adm-input" autocomplete="off"></label>
        <label class="adm-field">Nom<input id="accNom" class="adm-input" autocomplete="off"></label>
      </div>
      <div class="adm-grid2">
        <label class="adm-field">Structure<input id="accStructure" class="adm-input" autocomplete="off" placeholder="Exploitation, OP, chambre…"></label>
        <label class="adm-field">Fonction<input id="accFonction" class="adm-input" autocomplete="off"></label>
      </div>
      <label class="adm-field">Téléphone<input id="accTelephone" class="adm-input" autocomplete="off" inputmode="tel"></label>
      <label class="adm-field">Rôle
        <select id="accRole" class="adm-input">
          <option value="normal">Normal : consultation (producteurs, techniciens)</option>
          <option value="admin">Admin : saisie Phénologie, Tavelure, Piégeage (collègues SudExpé)</option>
          <option value="full">Full admin : tout, y compris comptes et stations</option>
        </select>
      </label>
      <p class="adm-message" id="accMessage" role="status"></p>
      <div class="adm-dialog-actions">
        <button type="button" class="adm-button" data-close>Annuler</button>
        <button type="submit" class="adm-button is-primary" id="accSubmit">Envoyer l’invitation</button>
      </div>
    </form>
  </dialog>

  <!-- Fiche utilisateur ------------------------------------------------------ -->
  <dialog class="adm-dialog is-wide" id="accFiche" aria-labelledby="ficheTitre">
    <div class="adm-form adm-fiche" id="ficheContenu"></div>
  </dialog>

  <!-- Station --------------------------------------------------------------- -->
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
        <button type="button" class="adm-button" data-close>Annuler</button>
        <button type="submit" class="adm-button is-primary" id="staSubmit">Enregistrer</button>
      </div>
    </form>
  </dialog>

  <!-- Confirmation ------------------------------------------------------------ -->
  <dialog class="adm-dialog" id="admConfirm" aria-labelledby="admConfirmTitle">
    <form method="dialog" class="adm-form">
      <h2 id="admConfirmTitle"></h2>
      <p id="admConfirmText"></p>
      <div class="adm-dialog-actions">
        <button type="button" class="adm-button" value="cancel" data-close>Annuler</button>
        <button type="submit" class="adm-button is-danger" value="ok" id="admConfirmOk">Confirmer</button>
      </div>
    </form>
  </dialog>
</div>`;

export async function mount(root, ctx) {
  root.innerHTML = TEMPLATE;
  const $ = id => root.querySelector(`#${id}`);
  const supabase = ctx.supabase;
  const store = ctx.stations.store;
  const state = {
    tab: TABS.some(t => t.id === storage.get('admin.tab')) ? storage.get('admin.tab') : 'comptes',
    accounts: null,
    accountsError: null,
    // Dernière activité réelle disponible (true), fonction à jour sans le SQL (false), ancienne fonction (undefined)
    activite: undefined,
    latest: new Map(),
    dictionary: [],
    sensorRows: [],
    sensorCharts: [],
    capStation: null,
    capSensors: null,
    picker: null,
    pickerMarker: null
  };
  const capZoom = createZoomGroup();

  // ---------------------------------------------------------------------------
  // Accès : administrateurs uniquement (les droits réels sont contrôlés par Supabase)
  // ---------------------------------------------------------------------------
  function applyAccess() {
    $('admDenied').classList.toggle('hidden', ctx.isFullAdmin);
    $('admContent').classList.toggle('hidden', !ctx.isFullAdmin);
    return ctx.isFullAdmin;
  }

  function showTab(id) {
    state.tab = id;
    storage.set('admin.tab', id);
    root.querySelectorAll('.adm-tabs [data-tab]').forEach(b => {
      const on = b.dataset.tab === id;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
    });
    root.querySelectorAll('.adm-panel').forEach(p => { p.hidden = p.dataset.panel !== id; });
    if (id === 'comptes' && !state.accounts && !state.accountsError) loadAccounts();
    if (id === 'stations') loadStations();
    if (id === 'capteurs') loadSensorsTab();
  }

  function confirmAction(title, text, okLabel = 'Confirmer') {
    const dialog = $('admConfirm');
    $('admConfirmTitle').textContent = title;
    $('admConfirmText').textContent = text;
    $('admConfirmOk').textContent = okLabel;
    return new Promise(resolve => {
      const done = () => { dialog.removeEventListener('close', done); resolve(dialog.returnValue === 'ok'); };
      dialog.addEventListener('close', done);
      dialog.returnValue = 'cancel';
      dialog.showModal();
    });
  }
  root.querySelectorAll('dialog [data-close]').forEach(b => b.addEventListener('click', () => {
    const dialog = b.closest('dialog');
    dialog.returnValue = 'cancel';
    dialog.close();
  }));

  // ---------------------------------------------------------------------------
  // Comptes (fonction Supabase « sam-admin »)
  // ---------------------------------------------------------------------------
  async function callAdmin(action, payload = {}) {
    const { data, error } = await supabase.functions.invoke('sam-admin', { body: { action, ...payload } });
    if (error) {
      let message = error.message;
      const status = error.context?.status;
      try {
        const body = await error.context?.json?.();
        if (body?.error) message = body.error;
      } catch { /* réponse non JSON */ }
      const err = new Error(message);
      err.status = status;
      err.missing = error.name === 'FunctionsFetchError' || error.name === 'FunctionsRelayError' || status === 404;
      throw err;
    }
    if (data?.error) throw new Error(data.error);
    // Réponse inattendue : la fonction déployée n'est pas celle du dépôt (ex. modèle « Hello world »).
    const expected = action === 'list' ? Array.isArray(data?.accounts) : data?.ok === true;
    if (!expected) {
      const err = new Error('la fonction « sam-admin » déployée dans Supabase ne correspond pas au fichier du dépôt.');
      err.wrongCode = true;
      throw err;
    }
    return data;
  }

  const appUrl = () => `${window.location.origin}${window.location.pathname}`;

  async function loadAccounts() {
    $('accSummary').textContent = 'Chargement…';
    $('accSetup').classList.add('hidden');
    try {
      const data = await callAdmin('list');
      state.accounts = data.accounts || [];
      state.accountsError = null;
      state.activite = data.activite_disponible;
      renderAccounts();
      if ($('accFiche').open) renderFiche();
    } catch (error) {
      state.accounts = null;
      state.accountsError = error;
      $('accList').innerHTML = '';
      $('accSummary').textContent = '';
      $('accSetup').classList.remove('hidden');
      $('accSetup').innerHTML = error.wrongCode
        ? `<strong>La fonction « sam-admin » ne répond pas comme prévu.</strong>
           <p>Son code dans Supabase n'est pas celui du site (souvent le modèle « Hello world » resté dans l'éditeur).</p>
           <ol>
             <li>Supabase → <em>Edge Functions</em> → <em>sam-admin</em> → onglet <em>Code</em>.</li>
             <li>Remplacez tout le contenu par celui du fichier <code>supabase/functions/sam-admin/index.ts</code> du dépôt GitHub (la première ligne commence par « // ===== »), puis <em>Deploy</em>.</li>
             <li>Vérifiez que <em>Verify JWT</em> est désactivé dans <em>Details</em>.</li>
           </ol>
           <button type="button" class="adm-button" id="accRetry">Réessayer</button>`
        : error.missing
        ? `<strong>La gestion des comptes depuis le site doit être installée une fois dans Supabase.</strong>
           <ol>
             <li>Supabase → <em>Edge Functions</em> → <em>Deploy a new function</em> → <em>Via Editor</em>.</li>
             <li>Nom : <code>sam-admin</code>. Collez le contenu du fichier <code>supabase/functions/sam-admin/index.ts</code> du dépôt GitHub, puis <em>Deploy</em>.</li>
             <li>Dans les réglages de la fonction, désactivez <em>Verify JWT</em> (la fonction vérifie elle-même que vous êtes administrateur).</li>
           </ol>
           <p>En attendant, les comptes se gèrent dans Supabase → <em>Authentication</em> → <em>Users</em>.</p>
           <button type="button" class="adm-button" id="accRetry">Réessayer</button>`
        : `<strong>Comptes indisponibles :</strong> ${escapeHtml(error.message)} <button type="button" class="adm-button" id="accRetry">Réessayer</button>`;
      $('accRetry')?.addEventListener('click', loadAccounts);
    }
  }

  // Rôles : l'ancienne réponse de la fonction (champ « admin » seul) compte comme full admin.
  const ROLES = {
    normal: { label: 'Normal', help: 'consultation seule (producteurs, techniciens).' },
    admin: { label: 'Admin', help: 'saisie dans Phénologie, Tavelure et Piégeage, rien de plus.' },
    full: { label: 'Full admin', help: 'accès complet : comptes, stations, capteurs, fiches stations et saisie.' }
  };
  const roleOf = a => (ROLES[a.role] ? a.role : a.admin ? 'full' : 'normal');

  function accountStatus(a) {
    if (a.banned) return { key: 'banned', label: 'Suspendu' };
    if (!a.confirmed) return { key: 'invited', label: 'Invité, pas encore activé' };
    if (!a.last_sign_in_at) return { key: 'idle', label: 'Jamais connecté' };
    return { key: 'active', label: 'Actif' };
  }

  function renderAccounts() {
    const list = state.accounts || [];
    const query = $('accSearch').value.trim().toLowerCase();
    const shown = query
      ? list.filter(a => [a.email, a.prenom, a.nom, a.structure, a.fonction, a.commune, a.telephone].some(v => String(v || '').toLowerCase().includes(query)))
      : list;
    const count = role => list.filter(a => roleOf(a) === role).length;
    const pending = list.filter(a => !a.confirmed).length;
    $('accSummary').textContent = `${list.length} compte${list.length > 1 ? 's' : ''} · ${count('full')} full admin · ${count('admin')} admin · ${count('normal')} normal${pending ? ` · ${pending} invitation${pending > 1 ? 's' : ''} en attente` : ''}`;
    // Sans la mise à jour, Supabase ne donne que la dernière saisie du mot de passe
    const hint = $('accActiviteHint');
    hint.classList.toggle('hidden', state.activite === true);
    if (state.activite !== true) {
      hint.innerHTML = `<strong>Dernière activité :</strong> la liste affiche pour l’instant la dernière saisie du mot de passe. Une session déjà ouverte se prolonge seule sans changer cette date : un compte utilisé hier peut afficher « il y a 9 jours ». Pour voir la dernière utilisation réelle, ${state.activite === false
        ? 'exécutez une fois <code>supabase/activite_comptes.sql</code> dans Supabase (<em>SQL Editor</em>).'
        : 'exécutez une fois <code>supabase/activite_comptes.sql</code> dans Supabase (<em>SQL Editor</em>), puis mettez à jour la fonction <code>sam-admin</code> (<em>Edge Functions</em> → <em>sam-admin</em> → <em>Code</em> : coller <code>supabase/functions/sam-admin/index.ts</code> → <em>Deploy</em>).'}`;
    }
    if (!shown.length) {
      $('accList').innerHTML = `<p class="adm-empty">${query ? 'Aucun compte ne correspond à la recherche.' : 'Aucun compte.'}</p>`;
      return;
    }
    const meId = ctx.user?.id;
    $('accList').innerHTML = `
      <table class="adm-table">
        <thead><tr><th>Personne</th><th>Structure</th><th>Rôle</th><th>Statut</th><th>Dernière activité</th><th><span class="sr-only">Fiche</span></th></tr></thead>
        <tbody>${shown.map(a => {
          const status = accountStatus(a);
          const name = [a.prenom, a.nom].filter(Boolean).join(' ');
          const self = a.id === meId;
          const role = roleOf(a);
          const derniere = a.derniere_activite ?? a.last_sign_in_at;
          return `<tr data-id="${escapeHtml(a.id)}">
            <td data-label="Personne"><div><button type="button" class="adm-lien" data-fiche="${escapeHtml(a.id)}">${escapeHtml(name || a.email)}</button>${name ? `<span class="adm-muted">${escapeHtml(a.email)}</span>` : ''}${self ? '<span class="adm-tag">vous</span>' : ''}</div></td>
            <td data-label="Structure"><div>${escapeHtml(a.structure || '—')}${a.fonction ? `<span class="adm-muted">${escapeHtml(a.fonction)}</span>` : ''}</div></td>
            <td data-label="Rôle"><div><span class="adm-badge is-${role}" title="${escapeHtml(ROLES[role].help)}">${ROLES[role].label}</span></div></td>
            <td data-label="Statut"><div><span class="adm-status is-${status.key}">${status.label}</span>${!a.confirmed && a.invited_at ? `<span class="adm-muted">le ${escapeHtml(fmtDateTime(a.invited_at))}</span>` : ''}</div></td>
            <td data-label="Dernière activité"><div>${derniere ? `${escapeHtml(fmtDateTime(derniere))}<span class="adm-muted">${ago(derniere)}</span>` : 'jamais'}</div></td>
            <td class="adm-cell-actions"><button type="button" class="adm-button is-small" data-fiche="${escapeHtml(a.id)}">Fiche utilisateur</button></td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
  }

  async function accountAction(id, act, newRole) {
    const a = (state.accounts || []).find(x => x.id === id);
    if (!a) return;
    const who = [a.prenom, a.nom].filter(Boolean).join(' ') || a.email;
    try {
      if (act === 'role' && ROLES[newRole]) {
        if (!await confirmAction(`Passer en « ${ROLES[newRole].label} »`, `${who} : ${ROLES[newRole].help}`)) return;
        await callAdmin('setRole', { email: a.email, role: newRole });
        ctx.ui.toast(`${who} est maintenant « ${ROLES[newRole].label} ».`);
      } else if (act === 'reinvite') {
        await callAdmin('reinvite', { email: a.email, redirectTo: appUrl() });
        ctx.ui.toast(`Invitation renvoyée à ${a.email}.`);
      } else if (act === 'reset') {
        const { error } = await supabase.auth.resetPasswordForEmail(a.email, { redirectTo: appUrl() });
        if (error) throw error;
        ctx.ui.toast(`Lien de mot de passe envoyé à ${a.email}.`);
        return;
      } else if (act === 'suspend' || act === 'unsuspend') {
        const off = act === 'suspend';
        if (off && !await confirmAction('Suspendre l’accès', `${who} ne pourra plus se connecter tant que l’accès n’est pas réactivé. Son compte et ses données sont conservés.`, 'Suspendre')) return;
        await callAdmin('suspend', { id: a.id, suspended: off });
        ctx.ui.toast(off ? `Accès de ${who} suspendu.` : `Accès de ${who} réactivé.`);
      } else if (act === 'delete') {
        if (!await confirmAction('Supprimer le compte', `Le compte de ${who} (${a.email}) sera supprimé définitivement, avec ses parcelles du Bilan irrigation. Cette action est irréversible.`, 'Supprimer définitivement')) return;
        await callAdmin('delete', { id: a.id });
        ctx.ui.toast(`Compte de ${who} supprimé.`);
      }
      await loadAccounts();
      if ($('accFiche').open) renderFiche();
    } catch (error) {
      ctx.ui.toast(`Action impossible : ${error.message}`, 6000);
    }
  }

  $('accList').addEventListener('click', event => {
    const button = event.target.closest('[data-fiche]');
    if (button) ouvrirFiche(button.dataset.fiche);
  });

  // ---------------------------------------------------------------------------
  // Fiche utilisateur : informations renseignées, connexion, rôle, accès
  // ---------------------------------------------------------------------------
  let ficheId = null;
  const nomStation = id => store.list.find(s => s.id === id)?.nom || id;
  const lienTel = t => `tel:${String(t).replace(/[^\d+]/g, '')}`;
  const quand = v => (v ? `${fmtDateTime(v)} · ${ago(v)}` : 'jamais');

  async function ouvrirFiche(id) {
    ficheId = id;
    // Noms des stations (favoris, accès) : la liste des stations peut ne pas être chargée
    if (!store.list.length) await store.load().catch(() => {});
    renderFiche();
    const dialog = $('accFiche');
    if (!dialog.open) dialog.showModal();
  }

  function renderFiche() {
    const dialog = $('accFiche');
    const a = (state.accounts || []).find(x => x.id === ficheId);
    if (!a) { if (dialog.open) dialog.close(); return; }
    const self = a.id === ctx.user?.id;
    const role = roleOf(a);
    const status = accountStatus(a);
    const name = accountLabel(a);
    const initiales = ([a.prenom, a.nom].filter(Boolean).map(x => x.trim()[0]).join('') || a.email[0] || '?').toUpperCase();
    const vide = '<span class="adm-vide">non renseigné</span>';
    const txt = v => (v ? escapeHtml(v) : vide);
    const ligne = (label, value) => `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
    const favoris = (a.stations_favorites || []).map(nomStation);
    const activite = state.activite === true;
    $('ficheContenu').innerHTML = `
      <div class="adm-fiche-tete">
        <span class="adm-avatar" aria-hidden="true">${escapeHtml(initiales)}</span>
        <div class="adm-fiche-id">
          <h2 id="ficheTitre">${escapeHtml(name)}${self ? ' <span class="adm-tag">vous</span>' : ''}</h2>
          <a href="mailto:${escapeHtml(a.email)}">${name === a.email ? 'Écrire un mail' : escapeHtml(a.email)}</a>
          <div class="adm-fiche-badges"><span class="adm-badge is-${role}">${ROLES[role].label}</span><span class="adm-status is-${status.key}">${status.label}</span></div>
        </div>
        <button type="button" class="adm-fermer" data-fiche-fermer aria-label="Fermer la fiche">×</button>
      </div>

      <section class="adm-fiche-bloc">
        <h3>Informations renseignées</h3>
        <dl class="adm-fiche-dl">
          ${ligne('Prénom', txt(a.prenom))}
          ${ligne('Nom', txt(a.nom))}
          ${ligne('Structure / exploitation', txt(a.structure))}
          ${ligne('Fonction', txt(a.fonction))}
          ${ligne('Téléphone', a.telephone ? `<a href="${escapeHtml(lienTel(a.telephone))}">${escapeHtml(a.telephone)}</a>` : vide)}
          ${ligne('Commune', txt(a.commune))}
          ${'stations_favorites' in a ? ligne('Stations favorites', favoris.length ? escapeHtml(favoris.join(', ')) : '<span class="adm-vide">aucune</span>') : ''}
        </dl>
        <p class="adm-hint">Saisies par la personne dans « Mon compte » ou lors de l’invitation${a.profil_maj ? ` ; dernière mise à jour le ${escapeHtml(fmtDateTime(a.profil_maj))}` : ''}.</p>
      </section>

      <section class="adm-fiche-bloc">
        <h3>Connexion</h3>
        <dl class="adm-fiche-dl">
          ${ligne('Compte créé', a.created_at ? escapeHtml(fmtDateTime(a.created_at)) : '—')}
          ${a.confirmed ? ligne('Compte activé', 'oui') : ligne('Invitation envoyée', a.invited_at ? `${escapeHtml(fmtDateTime(a.invited_at))}, pas encore acceptée` : 'pas encore acceptée')}
          ${activite ? ligne('Dernière activité', escapeHtml(quand(a.derniere_activite))) : ''}
          ${ligne('Dernière saisie du mot de passe', escapeHtml(quand(a.last_sign_in_at)))}
        </dl>
        <p class="adm-hint">${activite
          ? 'Dernière activité : dernière utilisation de SAM Outils, à une heure près. Le mot de passe n’est demandé qu’à l’ouverture d’une nouvelle session ; une session ouverte se prolonge seule.'
          : 'Le mot de passe n’est demandé qu’à l’ouverture d’une nouvelle session ; une session ouverte se prolonge seule, sans changer cette date. La dernière utilisation réelle s’affichera une fois la mise à jour installée (voir la liste des comptes).'}</p>
      </section>

      <section class="adm-fiche-bloc">
        <h3>Rôle</h3>
        <div class="adm-fiche-roles">${Object.entries(ROLES).map(([k, r]) => `<label class="adm-check"><input type="radio" name="ficheRole" value="${k}"${k === role ? ' checked' : ''}${self ? ' disabled' : ''}><span><strong>${r.label}</strong> : ${escapeHtml(r.help)}</span></label>`).join('')}</div>
        ${self ? '<p class="adm-hint">Vous ne pouvez pas modifier votre propre rôle.</p>' : '<div><button type="button" class="adm-button is-primary" data-fiche-act="role" disabled>Enregistrer le rôle</button></div>'}
      </section>

      <section class="adm-fiche-bloc">
        <h3>Accès aux données réservées des stations</h3>
        <div id="ficheStations">${role === 'normal' ? '<p class="adm-muted">Chargement…</p>' : '<p class="adm-muted">Les rôles admin et full admin voient toutes les données de toutes les stations.</p>'}</div>
      </section>

      <section class="adm-fiche-bloc">
        <h3>Accès au site</h3>
        <div class="adm-fiche-actions">
          ${a.confirmed ? '<button type="button" class="adm-button" data-fiche-act="reset">Envoyer un lien de mot de passe</button>' : '<button type="button" class="adm-button" data-fiche-act="reinvite">Renvoyer l’invitation</button>'}
          ${self ? '' : a.banned ? '<button type="button" class="adm-button" data-fiche-act="unsuspend">Réactiver l’accès</button>' : '<button type="button" class="adm-button" data-fiche-act="suspend">Suspendre l’accès</button>'}
        </div>
        ${self ? '' : `<p class="adm-hint">${a.banned ? 'Accès suspendu : la personne ne peut plus se connecter. Son compte et ses données sont conservés.' : 'Suspendre : la personne ne peut plus se connecter ; son compte et ses données sont conservés.'}</p>`}
      </section>

      ${self ? '' : `<section class="adm-fiche-bloc is-danger">
        <h3>Supprimer le compte</h3>
        <p class="adm-hint">Définitif : le compte et ses parcelles du Bilan irrigation sont supprimés.</p>
        <div><button type="button" class="adm-button is-danger" data-fiche-act="delete">Supprimer le compte</button></div>
      </section>`}
      <div class="adm-dialog-actions"><button type="button" class="adm-button" data-fiche-fermer>Fermer</button></div>`;
    if (role === 'normal') chargerAccesStations(a.id);
  }

  // Stations dont les données réservées (météo, irrigation) sont ouvertes à ce compte
  async function chargerAccesStations(id) {
    const box = $('ficheStations');
    try {
      const { data, error } = await supabase.from('station_acces').select('station_id,meteo,irrigation').eq('user_id', id);
      if (error) throw error;
      if (ficheId !== id || !box.isConnected) return;
      const lignes = (data || []).filter(g => g.meteo || g.irrigation)
        .map(g => ({ nom: nomStation(g.station_id), quoi: [g.meteo ? 'météo' : '', g.irrigation ? 'irrigation' : ''].filter(Boolean).join(' et ') }))
        .sort((x, y) => x.nom.localeCompare(y.nom, 'fr'));
      box.innerHTML = lignes.length
        ? `<ul class="adm-fiche-liste">${lignes.map(l => `<li><strong>${escapeHtml(l.nom)}</strong> : données ${escapeHtml(l.quoi)}</li>`).join('')}</ul><p class="adm-hint">En plus des stations ouvertes à tous. Se règle dans l’onglet Stations.</p>`
        : '<p class="adm-muted">Aucun accès particulier : la personne voit les stations ouvertes à tous. Se règle dans l’onglet Stations.</p>';
    } catch {
      if (ficheId === id && box.isConnected) box.innerHTML = '<p class="adm-muted">Accès par station pas encore configurés (supabase/acces_stations.sql).</p>';
    }
  }

  $('accFiche').addEventListener('click', async event => {
    if (event.target.closest('[data-fiche-fermer]')) { $('accFiche').close(); return; }
    const button = event.target.closest('[data-fiche-act]');
    if (!button || button.disabled) return;
    const act = button.dataset.ficheAct;
    const role = $('accFiche').querySelector('input[name="ficheRole"]:checked')?.value;
    // Bouton bloqué pendant l'action (pas de double envoi)
    button.disabled = true;
    try {
      await accountAction(ficheId, act, act === 'role' ? role : undefined);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });
  $('accFiche').addEventListener('change', event => {
    if (event.target.name !== 'ficheRole') return;
    const a = (state.accounts || []).find(x => x.id === ficheId);
    const button = $('accFiche').querySelector('[data-fiche-act="role"]');
    if (a && button) button.disabled = event.target.value === roleOf(a);
  });
  $('accSearch').addEventListener('input', () => renderAccounts());

  $('accInviteBtn').addEventListener('click', () => {
    if (state.accountsError?.missing) {
      ctx.ui.toast('Installez d’abord la fonction « sam-admin » (voir les étapes ci-dessous).', 5000);
      return;
    }
    $('accForm').reset();
    $('accMessage').textContent = '';
    $('accDialog').showModal();
    $('accEmail').focus();
  });

  $('accForm').addEventListener('submit', async event => {
    event.preventDefault();
    const email = $('accEmail').value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      $('accMessage').textContent = 'Adresse mail invalide.';
      $('accEmail').focus();
      return;
    }
    $('accSubmit').disabled = true;
    $('accMessage').textContent = 'Envoi de l’invitation…';
    try {
      await callAdmin('invite', {
        email,
        prenom: $('accPrenom').value,
        nom: $('accNom').value,
        structure: $('accStructure').value,
        fonction: $('accFonction').value,
        telephone: $('accTelephone').value,
        role: $('accRole').value,
        redirectTo: appUrl()
      });
      $('accDialog').close();
      ctx.ui.toast(`Invitation envoyée à ${email}.`);
      await loadAccounts();
    } catch (error) {
      $('accMessage').textContent = error.message;
    } finally {
      $('accSubmit').disabled = false;
    }
  });

  // ---------------------------------------------------------------------------
  // Stations
  // ---------------------------------------------------------------------------
  async function loadLatest() {
    const since = new Date(Date.now() - 26 * HOUR).toISOString();
    const { data, error } = await fetchAllRows(() => supabase.from('station_mesures')
      .select('station_id,mesure_le,autres')
      .gte('mesure_le', since)
      .order('mesure_le', { ascending: true }));
    if (error) throw error;
    const dayAgo = Date.now() - 24 * HOUR;
    const next = new Map();
    (data || []).forEach(row => {
      const entry = next.get(row.station_id) || { count24: 0, bat: null, batAt: null };
      if (new Date(row.mesure_le).getTime() >= dayAgo) entry.count24 += 1;
      const bat = num(row.autres?.bat);
      if (bat !== null) { entry.bat = bat; entry.batAt = row.mesure_le; }
      next.set(row.station_id, entry);
    });
    state.latest = next;
  }

  async function loadStations(force = false) {
    await store.load(force);
    if (ctx.scope.disposed) return;
    try { await loadLatest(); } catch (error) { console.warn('Mesures récentes indisponibles', error); }
    if (ctx.scope.disposed) return;
    renderStations();
  }

  // Résumé des accès d'une station non visible par tous.
  function accessBadge(s) {
    if (!('acces_meteo' in s)) return '<span class="adm-badge is-warn">Masquée</span>';
    const label = mode => (mode === 'tous' ? 'tous' : 'comptes choisis');
    return `<span class="adm-badge is-warn" title="Station non visible par tous les comptes">Météo : ${label(s.acces_meteo)} · Irrigation : ${label(s.acces_irrigation)}</span>`;
  }

  function renderStations() {
    if (store.error) {
      $('staSummary').textContent = '';
      $('staList').innerHTML = `<p class="adm-empty">Stations indisponibles : ${escapeHtml(store.error.message || store.error)}</p>`;
      return;
    }
    const list = [...store.list].sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    const counts = {};
    list.forEach(s => { const k = stationState(s).key; counts[k] = (counts[k] || 0) + 1; });
    const parts = [['ok', 'transmettent'], ['late', 'en retard'], ['silent', 'muettes'], ['off', 'collecte arrêtée'], ['never', 'sans donnée'], ['pending', 'pas encore installées']]
      .filter(([k]) => counts[k]).map(([k, label]) => `${counts[k]} ${label}`);
    $('staSummary').textContent = `${list.length} station${list.length > 1 ? 's' : ''} · ${parts.join(' · ')}`;

    // À surveiller : stations posées dont la transmission pose problème
    const watch = list.filter(s => {
      const k = stationState(s).key;
      return s.installee !== false && s.active !== false && (['late', 'silent', 'never'].includes(k) || s.derniere_erreur);
    });
    $('staAlerts').innerHTML = watch.length
      ? `<div class="adm-alert"><strong>À surveiller (${watch.length})</strong><ul>${watch.map(s => {
          const st = stationState(s);
          return `<li><b>${escapeHtml(s.nom)}</b> — ${escapeHtml(st.label)}${s.derniere_mesure ? `, dernière mesure ${ago(s.derniere_mesure)}` : ''}${s.derniere_erreur ? ` · <span class="adm-error">${escapeHtml(s.derniere_erreur)}</span>` : ''}</li>`;
        }).join('')}</ul></div>`
      : '';

    $('staList').innerHTML = `
      <table class="adm-table">
        <thead><tr><th>Station</th><th>Transmission</th><th>Batterie</th><th>Mesures 24 h</th><th>RIMpro</th><th>Réglages</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${list.map(s => {
          const st = stationState(s);
          const info = state.latest.get(s.id);
          const flags = [
            s.installee === false ? '<span class="adm-badge">Pas installée</span>' : '',
            s.active === false ? '<span class="adm-badge is-warn">Collecte arrêtée</span>' : '',
            s.publique === false ? accessBadge(s) : '',
            !Number.isFinite(s.latitude) ? '<span class="adm-badge is-warn">Sans coordonnées</span>' : ''
          ].filter(Boolean).join('') || '<span class="adm-muted">—</span>';
          const empty = !s.premiere_mesure && !s.derniere_mesure;
          return `<tr data-id="${escapeHtml(s.id)}">
            <td data-label="Station"><strong>${escapeHtml(s.nom)}</strong><span class="adm-muted">${escapeHtml(s.id)}${s.commune ? ` · ${escapeHtml(s.commune)}` : ''}</span></td>
            <td data-label="Transmission"><span class="adm-state is-${st.key}">${escapeHtml(st.label)}</span><span class="adm-muted">${s.derniere_mesure ? `dernière mesure ${ago(s.derniere_mesure)}` : 'aucune mesure'}</span>${s.derniere_erreur ? `<span class="adm-error">${escapeHtml(s.derniere_erreur)}</span>` : ''}</td>
            <td data-label="Batterie">${info?.bat !== null && info?.bat !== undefined ? `<strong>${formatNumber(info.bat, 2)} V</strong>` : '<span class="adm-muted">—</span>'}</td>
            <td data-label="Mesures 24 h">${info ? `${info.count24} / 24` : '<span class="adm-muted">0</span>'}</td>
            <td data-label="RIMpro">${s.rimpro_id ? `<span class="adm-badge is-rimpro">R</span> ${escapeHtml(s.rimpro_id)}` : '<span class="adm-muted">—</span>'}</td>
            <td data-label="Réglages">${flags}</td>
            <td class="adm-cell-actions">
              <button type="button" class="adm-button is-small" data-sta="edit">Modifier</button>
              <button type="button" class="adm-button is-small" data-sta="sync"${s.active === false ? ' disabled title="Collecte arrêtée"' : ''}>Synchroniser</button>
              <button type="button" class="adm-button is-small" data-sta="sensors">Capteurs</button>
              ${empty ? '<button type="button" class="adm-button is-small is-danger" data-sta="delete">Supprimer</button>' : ''}
            </td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
  }

  async function synchronise(stationId, button) {
    if (button) button.disabled = true;
    try {
      const { data: count, error } = await supabase.rpc('stations_synchroniser', { p_station: stationId });
      if (error) throw error;
      ctx.ui.toast(`Demande envoyée à Comsag (${count || 0} station${count > 1 ? 's' : ''})…`);
      await new Promise(resolve => ctx.scope.timeout(resolve, stationId ? 6000 : 10000));
      if (ctx.scope.disposed) return;
      const { data: written, error: e2 } = await supabase.rpc('stations_integrer');
      if (e2) throw e2;
      ctx.ui.toast(`${written || 0} mesure${written > 1 ? 's' : ''} mise${written > 1 ? 's' : ''} à jour.`);
      await loadStations(true);
    } catch (error) {
      ctx.ui.toast(`Synchronisation impossible : ${error.message || error}`, 6000);
    } finally {
      if (button) button.disabled = false;
    }
  }

  $('staSyncAll').addEventListener('click', event => synchronise(null, event.currentTarget));
  $('staNewBtn').addEventListener('click', () => openStationDialog(null));
  $('staList').addEventListener('click', async event => {
    const button = event.target.closest('button[data-sta]');
    if (!button) return;
    const id = button.closest('tr').dataset.id;
    const station = store.list.find(s => s.id === id);
    if (!station) return;
    if (button.dataset.sta === 'edit') openStationDialog(station);
    if (button.dataset.sta === 'sync') synchronise(id, button);
    if (button.dataset.sta === 'sensors') {
      state.capStation = id;
      state.capSensors = null;
      showTab('capteurs');
    }
    if (button.dataset.sta === 'delete') {
      if (!await confirmAction('Supprimer la station', `« ${station.nom} » (${station.id}) n’a encore aucune mesure : elle sera retirée de la liste.`, 'Supprimer')) return;
      const { error } = await supabase.from('stations').delete().eq('id', id);
      if (error) ctx.ui.toast(`Suppression impossible : ${error.message}`, 6000);
      else { ctx.ui.toast('Station supprimée.'); await loadStations(true); }
    }
  });

  // Fiche station : création ou modification
  let editing = null;
  async function openStationDialog(station) {
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
    $('staDialog').showModal();
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
  const radio = name => root.querySelector(`input[name="${name}"]:checked`)?.value || 'tous';
  const setRadio = (name, value) => { root.querySelectorAll(`input[name="${name}"]`).forEach(r => { r.checked = r.value === value; }); };

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
      const [grants, accounts] = await Promise.all([
        station ? supabase.from('station_acces').select('user_id,meteo,irrigation').eq('station_id', station.id) : Promise.resolve({ data: [] }),
        state.accounts ? Promise.resolve({ accounts: state.accounts }) : callAdmin('list')
      ]);
      if (grants.error) throw grants.error;
      access.grants = new Map((grants.data || []).map(g => [g.user_id, { meteo: g.meteo, irrigation: g.irrigation }]));
      if (!state.accounts) state.accounts = accounts.accounts || [];
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
    const list = (state.accounts || [])
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
  root.querySelectorAll('input[name="staMeteo"], input[name="staIrrigation"]').forEach(r => r.addEventListener('change', refreshAccess));
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
      $('staDialog').close();
      ctx.ui.toast(editing ? 'Station mise à jour.' : `Station créée${row.active ? ' : la collecte démarrera dans les 30 minutes.' : '.'}`, 5000);
      await loadStations(true);
    } catch (error) {
      fail(`Enregistrement impossible : ${error.message || error}`);
    } finally {
      $('staSubmit').disabled = false;
    }
  });

  // ---------------------------------------------------------------------------
  // Capteurs
  // ---------------------------------------------------------------------------
  async function loadDictionary() {
    // « categorie » (météo / irrigation) existe une fois acces_stations.sql exécuté.
    const { data, error } = await supabase.from('station_capteurs').select('*').order('ordre');
    if (error) throw error;
    state.dictionary = data || [];
    state.hasCategory = state.dictionary.some(d => 'categorie' in d);
  }
  const sensorInfo = code => state.dictionary.find(d => d.code === code) || { code, libelle: code, unite: '', ordre: 999 };
  const sensorLabel = code => { const d = sensorInfo(code); return d.libelle && d.libelle !== code ? d.libelle : code; };

  function stationSensors(station) {
    const codes = [...new Set([...(station?.capteurs || [])])];
    return codes.sort((a, b) => (sensorInfo(a).ordre - sensorInfo(b).ordre) || a.localeCompare(b));
  }

  async function loadSensorsTab() {
    await store.load();
    if (ctx.scope.disposed) return;
    try { await loadDictionary(); } catch (error) { console.warn('Dictionnaire des capteurs indisponible', error); }
    const stations = [...store.list].sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    if (!state.capStation || !stations.some(s => s.id === state.capStation)) {
      // Dernière station consultée dans cet onglet, sinon la première qui a des mesures.
      const remembered = storage.get('admin.capStation');
      state.capStation = stations.some(s => s.id === remembered) ? remembered
        : (stations.find(s => (s.capteurs || []).length) || stations[0])?.id || null;
    }
    const options = stations.map(s => `<option value="${escapeHtml(s.id)}"${s.id === state.capStation ? ' selected' : ''}>${escapeHtml(s.nom)}${(s.capteurs || []).length ? '' : ' (aucune mesure)'}</option>`).join('');
    $('capStation').innerHTML = options;
    $('capDicStation').innerHTML = options;
    $('capPeriod').value = String(storage.get('admin.capPeriod', 7));
    renderDictionary();
    await loadSensorData();
  }

  async function loadSensorData() {
    const station = store.list.find(s => s.id === state.capStation);
    const sensors = stationSensors(station);
    if (!state.capSensors) state.capSensors = sensors.includes('bat') ? ['bat'] : sensors.slice(0, 2);
    state.capSensors = state.capSensors.filter(code => sensors.includes(code));
    renderChips(station, sensors);
    destroySensorCharts();
    $('capLatest').innerHTML = '';
    $('capCharts').innerHTML = '';
    if (!station || !sensors.length) return;
    const days = Number($('capPeriod').value) || 7;
    $('capCharts').innerHTML = '<p class="adm-empty">Chargement des mesures…</p>';
    const since = new Date(Date.now() - days * 24 * HOUR).toISOString();
    const { data, error } = await fetchAllRows(() => supabase.from('station_mesures')
      .select('mesure_le,t_air,hr,pluie,autres')
      .eq('station_id', station.id)
      .gte('mesure_le', since)
      .order('mesure_le', { ascending: true }));
    if (ctx.scope.disposed || state.capStation !== station.id) return;
    if (error) {
      $('capCharts').innerHTML = `<p class="adm-empty">Mesures indisponibles : ${escapeHtml(error.message)}</p>`;
      return;
    }
    state.sensorRows = data || [];
    renderLatest(sensors);
    renderSensorCharts();
  }

  // Puces des capteurs bruts : un capteur masqué dans Données reste consultable ici.
  function renderChips(station, sensors) {
    const masks = station?.capteurs_masques || [];
    $('capSensors').innerHTML = sensors.length
      ? sensors.map(code => {
        const masked = masks.includes(code);
        return `<label class="adm-chip${state.capSensors.includes(code) ? ' is-on' : ''}"${masked ? ' title="Masqué dans l’onglet Données pour cette station"' : ''}><input type="checkbox" value="${escapeHtml(code)}"${state.capSensors.includes(code) ? ' checked' : ''}>${escapeHtml(sensorLabel(code))}<small>${escapeHtml(code)}${masked ? ' · masqué' : ''}</small></label>`;
      }).join('')
      : '<p class="adm-empty">Cette station n’a encore transmis aucune mesure.</p>';
  }

  const valueOf = (row, code) => num(BASE_COLUMNS[code] ? row[BASE_COLUMNS[code]] : row.autres?.[code]);

  function renderLatest(sensors) {
    const rows = state.sensorRows;
    if (!rows.length) {
      $('capLatest').innerHTML = '<p class="adm-empty">Aucune mesure sur la période.</p>';
      return;
    }
    $('capLatest').innerHTML = `<h3>Dernières valeurs</h3><div class="adm-latest-grid">${sensors.map(code => {
      let last = null;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const v = valueOf(rows[i], code);
        if (v !== null) { last = { v, at: rows[i].mesure_le }; break; }
      }
      const info = sensorInfo(code);
      return `<div class="adm-latest-item"><span>${escapeHtml(sensorLabel(code))}</span><strong>${last ? `${formatNumber(last.v, Math.abs(last.v) < 10 ? 2 : 1)}${info.unite ? ` ${escapeHtml(info.unite)}` : ''}` : '—'}</strong><small>${last ? escapeHtml(shortFormat.format(new Date(last.at)).replace(' ', ' à ')) : 'pas de valeur'}</small></div>`;
    }).join('')}</div>`;
  }

  function destroySensorCharts() {
    state.sensorCharts.forEach(chart => { try { chart.destroy(); } catch { /* déjà détruit */ } });
    state.sensorCharts = [];
  }

  function renderSensorCharts() {
    destroySensorCharts();
    resetZoomGroup(capZoom, { apply: false });
    const rows = state.sensorRows;
    if (!rows.length) { $('capCharts').innerHTML = ''; return; }
    if (!state.capSensors.length) {
      $('capCharts').innerHTML = '<p class="adm-empty">Cochez un ou plusieurs capteurs à afficher.</p>';
      return;
    }
    const items = rows.map(r => {
      const at = new Date(r.mesure_le);
      return { day: dayKeyFormat.format(at), hour: hourKeyFormat.format(at) };
    });
    const labels = items.map(i => `${i.day.slice(8, 10)}/${i.day.slice(5, 7)} ${i.hour.slice(0, 2)}h`);
    $('capCharts').innerHTML = state.capSensors.map(code => `
      <div class="adm-chart-card">
        <div class="adm-chart-head"><strong>${escapeHtml(sensorLabel(code))}</strong><span>${escapeHtml(sensorInfo(code).unite || '')} · ${escapeHtml(code)}</span></div>
        <div class="adm-chart"><canvas data-code="${escapeHtml(code)}" aria-label="${escapeHtml(sensorLabel(code))}"></canvas></div>
      </div>`).join('');
    const narrow = window.matchMedia('(max-width: 760px)').matches;
    $('capCharts').querySelectorAll('canvas').forEach(canvas => {
      const code = canvas.dataset.code;
      const info = sensorInfo(code);
      const values = rows.map(r => valueOf(r, code));
      const bar = code === 'pluv';
      const chart = new window.Chart(canvas, {
        type: bar ? 'bar' : 'line',
        data: {
          labels,
          datasets: [{
            label: `${sensorLabel(code)}${info.unite ? ` (${info.unite})` : ''}`,
            data: values,
            borderColor: code === 'bat' ? '#7c3aed' : '#a20117',
            backgroundColor: bar ? 'rgba(59, 138, 217, .75)' : 'rgba(162, 1, 23, .08)',
            borderWidth: 1.8,
            pointRadius: 0,
            spanGaps: false,
            tension: 0.15
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: c => `${c.dataset.label} : ${c.parsed.y === null ? '—' : formatNumber(c.parsed.y, 2)}` } },
            samTimeTicks: { items, mode: 'hourly' }
          },
          scales: {
            x: timeAxis({ items, mode: 'hourly' }, { fontSize: narrow ? 11 : 12 }),
            y: { beginAtZero: bar, grace: '5%', ticks: { font: { size: narrow ? 11 : 12 } } }
          }
        },
        plugins: [timeTicksPlugin]
      });
      enableChartZoom(chart, { group: capZoom });
      state.sensorCharts.push(chart);
    });
  }

  // Les deux listes « Station » de l'onglet (mesures brutes, noms des capteurs) restent alignées.
  function selectCapStation(id) {
    state.capStation = id;
    storage.set('admin.capStation', id);
    state.capSensors = null;
    $('capStation').value = id;
    $('capDicStation').value = id;
    renderDictionary();
    loadSensorData();
  }
  $('capStation').addEventListener('change', () => selectCapStation($('capStation').value));
  $('capDicStation').addEventListener('change', () => selectCapStation($('capDicStation').value));
  $('capPeriod').addEventListener('change', () => {
    storage.set('admin.capPeriod', Number($('capPeriod').value));
    loadSensorData();
  });
  $('capSensors').addEventListener('change', event => {
    const box = event.target.closest('input[type="checkbox"]');
    if (!box) return;
    const code = box.value;
    state.capSensors = box.checked ? [...new Set([...state.capSensors, code])] : state.capSensors.filter(c => c !== code);
    box.closest('.adm-chip').classList.toggle('is-on', box.checked);
    renderSensorCharts();
  });

  // Capteurs affichés dans l'onglet Données, station par station (stations.capteurs_masques,
  // supabase/capteurs_masques.sql). Température, hygrométrie et pluie y sont toujours tracées ;
  // les autres capteurs dès qu'ils ont transmis ; la batterie jamais.
  const ALWAYS_CHARTED = ['t1', 'hyg1', 'pluv'];
  const maskSupported = () => store.list.some(s => Array.isArray(s.capteurs_masques));

  function showCell(code, station) {
    if (!station || !maskSupported()) return '<span class="adm-muted">—</span>';
    if (code === 'bat') return '<span class="adm-muted" title="La batterie n’apparaît jamais dans l’onglet Données">jamais affiché</span>';
    const masks = station.capteurs_masques || [];
    const present = ALWAYS_CHARTED.includes(code) || (station.capteurs || []).includes(code) || masks.includes(code);
    if (!present) return '<span class="adm-muted" title="Ce capteur n’a jamais transmis de mesure pour cette station">absent</span>';
    const on = !masks.includes(code);
    return `<label class="adm-show${on ? '' : ' is-off'}" title="${on ? 'Décocher pour retirer ce capteur' : 'Cocher pour afficher ce capteur'} de l’onglet Données de ${escapeHtml(station.nom)}"><input type="checkbox" data-show="${escapeHtml(code)}"${on ? ' checked' : ''}><span>${on ? 'Affiché' : 'Masqué'}</span></label>`;
  }

  // Dictionnaire des capteurs : codes connus + codes vus dans les mesures
  function renderDictionary() {
    const station = store.list.find(s => s.id === state.capStation) || null;
    const masks = station?.capteurs_masques || [];
    $('capMaskHint').innerHTML = !maskSupported()
      ? 'Pour choisir les capteurs affichés station par station, exécutez une fois <code>supabase/capteurs_masques.sql</code> dans Supabase (SQL Editor).'
      : station
        ? `${escapeHtml(station.nom)} : ${masks.length ? `${masks.length} capteur${masks.length > 1 ? 's' : ''} masqué${masks.length > 1 ? 's' : ''} dans Données (${masks.map(c => escapeHtml(sensorLabel(c))).join(', ')})` : 'tous les capteurs sont affichés dans Données'}. Une case décochée retire le capteur des graphiques, du résumé, des exports, de la carte et du Bilan irrigation ; les mesures restent consultables ci-dessus. Enregistré dès le clic.`
        : '';
    const seen = new Set(store.list.flatMap(s => s.capteurs || []));
    const rows = [...state.dictionary];
    seen.forEach(code => { if (!rows.some(r => r.code === code)) rows.push({ code, libelle: '', unite: '', ordre: 100, missing: true }); });
    rows.sort((a, b) => (a.ordre - b.ordre) || a.code.localeCompare(b.code));
    $('capDictionary').innerHTML = `
      <table class="adm-table is-dictionary">
        <thead><tr><th title="Affiché dans l’onglet Données pour la station choisie">Affiché</th><th>Code</th><th>Libellé</th><th>Unité</th><th>Ordre</th>${state.hasCategory ? '<th title="Famille de données : règle qui peut voir ce capteur (fiche station)">Famille</th>' : ''}<th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${rows.map(r => `<tr data-code="${escapeHtml(r.code)}"${masks.includes(r.code) ? ' class="is-masked"' : ''}>
          <td data-label="Affiché" class="adm-cell-show">${showCell(r.code, station)}</td>
          <td data-label="Code"><code>${escapeHtml(r.code)}</code>${r.missing ? '<span class="adm-badge is-warn">non décrit</span>' : ''}</td>
          <td data-label="Libellé"><input class="adm-input" data-f="libelle" value="${escapeHtml(r.libelle || '')}" placeholder="Nom affiché"></td>
          <td data-label="Unité"><input class="adm-input is-short" data-f="unite" value="${escapeHtml(r.unite || '')}"></td>
          <td data-label="Ordre"><input class="adm-input is-short" data-f="ordre" inputmode="numeric" value="${escapeHtml(String(r.ordre ?? 100))}"></td>
          ${state.hasCategory ? `<td data-label="Famille"><select class="adm-input" data-f="categorie" title="Famille de données : règle qui peut voir ce capteur (fiche station)">
            <option value="meteo"${r.categorie === 'meteo' ? ' selected' : ''}>Météo</option>
            <option value="irrigation"${r.categorie !== 'meteo' ? ' selected' : ''}>Irrigation</option>
          </select></td>` : ''}
          <td class="adm-cell-actions"><button type="button" class="adm-button is-small" data-save>Enregistrer</button></td>
        </tr>`).join('')}</tbody>
      </table>`;
  }

  $('capDictionary').addEventListener('click', async event => {
    const button = event.target.closest('button[data-save]');
    if (!button) return;
    const tr = button.closest('tr');
    const field = f => tr.querySelector(`[data-f="${f}"]`).value.trim();
    const libelle = field('libelle');
    if (!libelle) { ctx.ui.toast('Indiquez un libellé.'); return; }
    const ordre = Number.parseInt(field('ordre'), 10);
    button.disabled = true;
    const row = { code: tr.dataset.code, libelle, unite: field('unite') || null, ordre: Number.isFinite(ordre) ? ordre : 100 };
    if (state.hasCategory) row.categorie = field('categorie');
    const { error } = await supabase.from('station_capteurs').upsert(row, { onConflict: 'code' });
    button.disabled = false;
    if (error) { ctx.ui.toast(`Enregistrement impossible : ${error.message}`, 6000); return; }
    ctx.ui.toast('Libellé enregistré.');
    await loadDictionary();
    renderDictionary();
    if (state.sensorRows.length) {
      const station = store.list.find(s => s.id === state.capStation);
      loadSensorData(station);
    }
  });

  // Case « Affiché » : enregistrée tout de suite dans la fiche de la station.
  $('capDictionary').addEventListener('change', async event => {
    const box = event.target.closest('input[data-show]');
    if (!box) return;
    const station = store.list.find(s => s.id === state.capStation);
    if (!station) return;
    const code = box.dataset.show;
    const show = box.checked;
    const masks = new Set(station.capteurs_masques || []);
    if (show) masks.delete(code); else masks.add(code);
    const next = [...masks].sort();
    $('capDictionary').querySelectorAll('input[data-show]').forEach(input => { input.disabled = true; });
    const { data, error } = await supabase.from('stations').update({ capteurs_masques: next }).eq('id', station.id).select('id');
    if (error || !data?.length) {
      box.checked = !show;
      $('capDictionary').querySelectorAll('input[data-show]').forEach(input => { input.disabled = false; });
      ctx.ui.toast(error ? `Enregistrement impossible : ${error.message}` : 'Enregistrement refusé : seul un full admin peut modifier une station.', 6000);
      return;
    }
    store.patch(station.id, { capteurs_masques: next });
    ctx.ui.toast(`« ${sensorLabel(code)} » ${show ? 'apparaît de nouveau' : 'n’apparaît plus'} dans les données de ${station.nom}.`, 4000);
    renderDictionary();
    renderChips(station, stationSensors(station));
  });

  // ---------------------------------------------------------------------------
  // Démarrage
  // ---------------------------------------------------------------------------
  root.querySelectorAll('.adm-tabs [data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  ctx.onAuthChange(() => { if (applyAccess() && !root.querySelector('.adm-tabs .is-active')) showTab(state.tab); });
  ctx.scope.add(destroySensorCharts);
  if (applyAccess()) showTab(state.tab);
  return {};
}
