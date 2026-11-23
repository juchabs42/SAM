// SAM Données — une station du réseau SAM à la fois (choisie dans le bandeau de gauche).
// Les mesures horaires sont collectées par Supabase (fichier supabase/stations.sql) :
// le site ne contacte jamais Comsag directement, le jeton d'accès reste côté serveur.
import { presets } from '../core/period.js';
import { icons } from '../core/icons.js';
import { stationState } from '../core/stations.js';
import { createStationDialog } from '../core/station-dialog.js';
import { createZoomGroup, enableChartZoom, resetZoomGroup, timeAxis, timeTicksPlugin } from '../core/charts.js';
import { todayISO, addDaysISO, formatNumber, formatDayMonth, formatDateShort, escapeHtml, storage } from '../core/util.js';

const TZ = 'Europe/Paris';
const DATA_START = '2026-09-01';
const PAGE = 1000;
const HOUR = 3600000;
const COLORS = {
  temp: '#db0b1f', tmax: '#7d0a16', tmoy: '#db0b1f', tmin: '#3b8ad9',
  hr: '#2e7d32', hrLight: '#8cc58f', rain: '#3b8ad9', cumul: '#1f3b63', humect: '#0f766e'
};
const SENSOR_COLORS = ['#7c3aed', '#0f766e', '#b45309', '#be185d', '#475569', '#0891b2'];
const BASE_SENSORS = {
  t1: ['Température de l’air', '°C'], hyg1: ['Hygrométrie de l’air', '%'], pluv: ['Pluviométrie', 'mm'],
  hum: ['Humectation du feuillage', '%'], bat: ['Batterie', 'V'],
  ts1: ['Tensiomètre 1', 'cb'], ts2: ['Tensiomètre 2', 'cb'], ts3: ['Tensiomètre 3', 'cb'], ts4: ['Tensiomètre 4', 'cb'], ts5: ['Tensiomètre 5', 'cb'],
  decagon1: ['Humidité du sol 1', '%'], decagon2: ['Humidité du sol 2', '%']
};
// Familles de capteurs complémentaires (champ « autres » des mesures).
const FAMILIES = {
  dendro: { title: 'Dendromètre', unit: 'µm', hint: 'Variation du diamètre du tronc ou de la branche.', test: code => /^dend/i.test(code) },
  tensio: { title: 'Sondes tensiométriques', unit: 'cb', hint: 'Plus la valeur est élevée, plus le sol est sec.', test: code => /^ts\d+$/i.test(code) },
  capa: { title: 'Sondes capacitives', unit: '%', hint: 'Humidité du sol : plus la valeur est élevée, plus le sol est humide.', test: code => /^(decagon|capa)\d*$/i.test(code) },
  humect: { title: 'Humectation foliaire', unit: '%', hint: '', test: code => code === 'hum' }
};
const IGNORED = new Set(['bat', 't1', 'hyg1', 'pluv']);
// Modèles RIMpro publiés pour les stations SudExpé (pages rimpro.eu vérifiées le 20/11/2026 ;
// l'hoplocampe existe chez RIMpro mais sa page renvoie une erreur : non proposé).
const RIMPRO_GROUPS = [
  { label: 'Maladies', models: [
    { id: 'venturia', label: 'Tavelure du pommier', path: 'venturia.xhtml' },
    { id: 'venturia-pyrina', label: 'Tavelure du poirier', path: 'venturiaPyrinaV2.xhtml' },
    { id: 'podosphaera', label: 'Oïdium du pommier', path: 'podosphaera.xhtml' },
    { id: 'erwinia', label: 'Feu bactérien', path: 'erwinia.xhtml' },
    { id: 'neonectria', label: 'Chancre européen', path: 'neonectria.xhtml' },
    { id: 'marssonina', label: 'Marssonina', path: 'marssonina.xhtml' },
    { id: 'stemphylium', label: 'Stemphyliose du poirier', path: 'stemphylium.xhtml' },
    { id: 'monilinia', label: 'Moniliose', path: 'monilinia.xhtml' },
    { id: 'blumeriella', label: 'Cylindrosporiose du cerisier', path: 'blumeriella.xhtml' }
  ] },
  { label: 'Ravageurs', models: [
    { id: 'cydia', label: 'Carpocapse', path: 'cydia.xhtml' },
    { id: 'dysaphis', label: 'Puceron cendré', path: 'dysaphis.xhtml' },
    { id: 'psylla', label: 'Psylle du poirier', path: 'psylla.xhtml' }
  ] },
  { label: 'Vigne', models: [
    { id: 'wine', label: 'Mildiou, oïdium, black-rot', path: 'wine.xhtml' },
    { id: 'lobesia', label: 'Eudémis', path: 'lobesia.xhtml' }
  ] }
];
const RIMPRO_MODELS = RIMPRO_GROUPS.flatMap(group => group.models);

// Départements du réseau (commune saisie « Nîmes (30) ») → lieu des prévisions météo.
const DEPARTEMENTS = {
  '04': ['Alpes-de-Haute-Provence', 'Provence-Alpes-Côte d’Azur'], '05': ['Hautes-Alpes', 'Provence-Alpes-Côte d’Azur'],
  '06': ['Alpes-Maritimes', 'Provence-Alpes-Côte d’Azur'], '07': ['Ardèche', 'Auvergne-Rhône-Alpes'],
  '09': ['Ariège', 'Occitanie'], '11': ['Aude', 'Occitanie'], '12': ['Aveyron', 'Occitanie'],
  '13': ['Bouches-du-Rhône', 'Provence-Alpes-Côte d’Azur'], '26': ['Drôme', 'Auvergne-Rhône-Alpes'],
  '30': ['Gard', 'Occitanie'], '31': ['Haute-Garonne', 'Occitanie'], '32': ['Gers', 'Occitanie'],
  '34': ['Hérault', 'Occitanie'], '38': ['Isère', 'Auvergne-Rhône-Alpes'], '46': ['Lot', 'Occitanie'],
  '47': ['Lot-et-Garonne', 'Nouvelle-Aquitaine'], '48': ['Lozère', 'Occitanie'], '65': ['Hautes-Pyrénées', 'Occitanie'],
  '66': ['Pyrénées-Orientales', 'Occitanie'], '81': ['Tarn', 'Occitanie'], '82': ['Tarn-et-Garonne', 'Occitanie'],
  '83': ['Var', 'Provence-Alpes-Côte d’Azur'], '84': ['Vaucluse', 'Provence-Alpes-Côte d’Azur']
};

/** Lieu des prévisions météo = position exacte de la station, nommé d'après sa commune. */
function stationPlace(station) {
  if (!station || station.latitude == null || station.longitude == null || station.latitude === '' || station.longitude === '') return null;
  const latitude = Number(station.latitude);
  const longitude = Number(station.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const match = String(station.commune || '').trim().match(/^(.*?)\s*\((\d{2,3}|2A|2B)\)\s*$/i);
  const name = (match ? match[1] : String(station.commune || '').trim()) || station.nom;
  const [admin2, admin1] = DEPARTEMENTS[match?.[2]] || ['', ''];
  return {
    name,
    admin2,
    admin1,
    country: 'France',
    latitude,
    longitude,
    elevation: Number.isFinite(Number(station.altitude)) ? Number(station.altitude) : null,
    timezone: 'Europe/Paris'
  };
}
const VIEWS = [
  { id: 'meteo', label: 'Météo', icon: 'viewMeteo' },
  { id: 'irrigation', label: 'Irrigation', icon: 'viewIrrigation' },
  { id: 'maladies', label: 'Maladies / ravageurs', icon: 'viewSanitaire' }
];

const TEMPLATE = `
<div class="don-main">
  <div class="don-setup hidden" id="donSetup"></div>

  <section class="don-card don-station" id="donStation">
    <header class="don-station-head">
      <div class="don-station-title">
        <div class="don-station-name-row">
          <h2 id="donStationName">—</h2>
          <button class="don-btn don-btn-small don-forecast" type="button" id="donForecast">${icons.viewMeteo}<span>Voir les prévisions</span></button>
        </div>
        <p class="don-station-sub" id="donStationSub"></p>
      </div>
      <div class="don-head-actions">
        <span id="donStationState" class="don-state"></span>
        <button class="don-btn don-export hidden" type="button" id="donExport" title="Toutes les mesures horaires et le résumé journalier de la période, dans un fichier Excel">Exporter (Excel)</button>
        <button class="don-btn don-admin hidden" type="button" id="donEditStation">Fiche station</button>
      </div>
    </header>
    <div class="don-kpis" id="donKpis"></div>
  </section>

  <section class="don-toolbar" id="donToolbar">
    <div class="don-views" role="tablist" aria-label="Données affichées">
      ${VIEWS.map(v => `<button type="button" role="tab" class="don-view-tab" data-view="${v.id}" aria-selected="false"><span class="don-view-icon">${icons[v.icon]}</span><span class="don-view-label">${v.label}</span></button>`).join('')}
    </div>
    <div class="don-filters" id="donFilters"></div>
  </section>

  <div class="don-zoombar" id="donZoomBar">
    <span class="don-zoom-hint" id="donZoomHint">Glissez sur un graphique pour zoomer · double-clic pour revenir en arrière</span>
    <button class="don-btn don-btn-small hidden" type="button" id="donZoomReset">Toute la période</button>
  </div>

  <section class="don-view" data-panel="meteo">
    <p class="don-empty hidden" id="donMeteoEmpty"></p>
    <div class="don-chart-list" id="donMeteoCharts"></div>
    <article class="don-card don-daily" id="donDaily">
      <header class="don-chart-head">
        <div><h3>Résumé journalier</h3></div>
        <button class="sam-csv-button" type="button" id="donDailyCsv" title="Télécharger le résumé journalier (CSV)">CSV</button>
      </header>
      <div class="don-table-wrap">
        <table class="don-table">
          <thead id="donDailyHead"></thead>
          <tbody id="donDailyBody"></tbody>
        </table>
      </div>
      <button class="don-btn don-more hidden" type="button" id="donDailyMore"></button>
    </article>
  </section>

  <section class="don-view" data-panel="irrigation" hidden>
    <p class="don-empty hidden" id="donIrrigationEmpty"></p>
    <div class="don-chart-list" id="donIrrigationCharts"></div>
  </section>

  <section class="don-view" data-panel="maladies" hidden>
    <div id="donRimpro"></div>
  </section>

</div>`;

// ---------------------------------------------------------------------------
// Dates (heure de Paris)
// ---------------------------------------------------------------------------
const dayKeyFormat = new Intl.DateTimeFormat('fr-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hourFormat = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const dayKey = date => dayKeyFormat.format(date);
const hourOf = date => hourFormat.format(date);

function parisOffsetMinutes(iso) {
  const label = new Date(`${iso}T12:00:00Z`).toLocaleString('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' });
  const m = label.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
  if (!m) return 60;
  const h = Number(m[1]);
  return h * 60 + Math.sign(h || 1) * Number(m[2] || 0);
}
function parisInstant(iso, endOfDay = false) {
  const offset = parisOffsetMinutes(iso);
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const tz = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return new Date(`${iso}T${endOfDay ? '23:59:59' : '00:00:00'}${tz}`);
}
function whenLabel(date) {
  if (!date) return '—';
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return 'à l’instant';
  if (minutes < 60) return `il y a ${minutes} min`;
  if (minutes < 24 * 60) return `il y a ${Math.round(minutes / 60)} h`;
  return `le ${formatDateShort(dayKey(date))} à ${hourOf(date)}`;
}
const num = value => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));
const round = (value, digits = 1) => (value === null || value === undefined ? null : Math.round(value * 10 ** digits) / 10 ** digits);
const csvNumber = value => (value === null || value === undefined ? '' : String(value).replace('.', ','));
const avg = list => (list?.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
const safeName = text => String(text || 'station').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');

export async function mount(root, ctx) {
  root.innerHTML = TEMPLATE;
  const $ = id => root.querySelector(`#${id}`);
  const supabase = ctx.supabase;
  const store = ctx.stations.store;
  const charts = new Map(); // id → { chart, spec }
  let sensorLabels = {};
  let hourly = [];
  let recent = { rows: [], last: null };
  let loadToken = 0;
  let view = VIEWS.some(v => v.id === storage.get('donnees.view')) ? storage.get('donnees.view') : 'meteo';
  let mode = storage.get('donnees.mode', 'hourly') === 'daily' ? 'daily' : 'hourly';
  let rimproModel = RIMPRO_MODELS.some(m => m.id === storage.get('donnees.rimpro')) ? storage.get('donnees.rimpro') : 'venturia';
  let dailyExpanded = false;
  // Zoom partagé par tous les graphiques de l'onglet (même période affichée).
  const zoom = createZoomGroup(range => updateZoomBar(range));

  // Période et pas de temps à côté, sous les onglets.
  ctx.filters({ location: false, period: true, mountIn: $('donFilters') });
  ctx.period.configure({
    presets: [
      presets.lastDays(7),
      presets.lastDays(2, '48 dernières heures'),
      presets.lastDays(30),
      { id: 'all', label: 'Depuis le début des mesures', resolve: today => ({ start: DATA_START, end: today }) }
    ],
    defaultPreset: 'last7',
    remember: 'session',
    min: DATA_START,
    max: () => todayISO(),
    hint: 'Mesures horaires des stations Comsag du réseau SAM, collectées automatiquement toutes les 30 minutes.'
  });
  const slot = ctx.filterActions();
  slot.innerHTML = `<div class="sam-filter don-mode-filter">
    <span class="sam-filter-label">Pas de temps</span>
    <div class="don-seg don-mode" role="group" aria-label="Pas de temps">
      <button type="button" data-mode="hourly">Horaire</button><button type="button" data-mode="daily">Journalier</button>
    </div>
  </div>`;
  const modeButtons = [...slot.querySelectorAll('[data-mode]')];

  const isAdmin = () => Boolean(ctx.isFullAdmin); // fiche station, RIMpro : full admin
  const sensorName = code => sensorLabels[code]?.libelle || BASE_SENSORS[code]?.[0] || code;
  const sensorUnit = code => sensorLabels[code]?.unite || BASE_SENSORS[code]?.[1] || '';
  const selected = () => store.selected;
  // Droits du compte sur la station (Administration > Stations > accès).
  const access = () => selected()?.acces || { meteo: true, irrigation: true };
  // Capteurs décochés dans Administration > Capteurs pour cette station (absents ou hors service :
  // station sans pluviomètre…). La base les retire déjà de la vue filtrée ; on les retire aussi ici.
  const masked = () => new Set(selected()?.capteurs_masques || []);
  const shown = code => !masked().has(code);

  function renderAdmin() {
    root.querySelectorAll('.don-admin').forEach(el => el.classList.toggle('hidden', !isAdmin()));
    // Export Excel : conseillers, admins et full admins
    $('donExport').classList.toggle('hidden', !['conseiller', 'admin', 'full'].includes(ctx.role));
  }

  // -------------------------------------------------------------------------
  // Chargement
  // -------------------------------------------------------------------------
  async function fetchAll(build) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await build().range(from, from + PAGE - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    return rows;
  }

  async function loadSensors() {
    const { data } = await supabase.from('station_capteurs').select('*').order('ordre');
    sensorLabels = Object.fromEntries((data || []).map(c => [c.code, c]));
  }

  const toRow = (row, hide) => ({
    at: new Date(row.mesure_le),
    t: hide.has('t1') ? null : num(row.t_air),
    hr: hide.has('hyg1') ? null : num(row.hr),
    rain: hide.has('pluv') ? null : num(row.pluie),
    others: hide.size ? Object.fromEntries(Object.entries(row.autres || {}).filter(([code]) => !hide.has(code))) : row.autres || {}
  });

  async function loadStationData() {
    const station = selected();
    const p = ctx.period.get();
    if (!station || !p?.start) { hourly = []; recent = { rows: [], last: null }; return; }
    const token = ++loadToken;
    const hide = new Set(station.capteurs_masques || []);
    const since = new Date(Date.now() - 24 * HOUR).toISOString();
    const [rows, last24] = await Promise.all([
      fetchAll(() => supabase.from(store.mesuresTable)
        .select('mesure_le,t_air,hr,pluie,autres')
        .eq('station_id', station.id)
        .gte('mesure_le', parisInstant(p.start).toISOString())
        .lte('mesure_le', parisInstant(p.end, true).toISOString())
        .order('mesure_le', { ascending: true })),
      fetchAll(() => supabase.from(store.mesuresTable)
        .select('mesure_le,t_air,hr,pluie,autres')
        .eq('station_id', station.id)
        .gte('mesure_le', since)
        .order('mesure_le', { ascending: true }))
    ]);
    let last = last24.length ? toRow(last24[last24.length - 1], hide) : null;
    if (!last && station.derniere_mesure) {
      const { data } = await supabase.from(store.mesuresTable).select('mesure_le,t_air,hr,pluie,autres')
        .eq('station_id', station.id).order('mesure_le', { ascending: false }).limit(1);
      if (data?.[0]) last = toRow(data[0], hide);
    }
    if (token !== loadToken) return;
    hourly = rows.map(row => toRow(row, hide));
    recent = { rows: last24.map(row => toRow(row, hide)), last };
  }

  // -------------------------------------------------------------------------
  // En-tête de la station et encarts du jour
  // -------------------------------------------------------------------------
  function kpi(label, value, foot) {
    return `<article class="don-kpi"><span class="don-kpi-label">${label}</span><strong class="don-kpi-value">${value}</strong><span class="don-kpi-foot">${escapeHtml(foot)}</span></article>`;
  }

  function renderHeader() {
    const station = selected();
    if (!station) return;
    const state = stationState(station);
    $('donStationName').textContent = station.nom;
    const place = stationPlace(station);
    $('donForecast').disabled = !place;
    $('donForecast').title = place
      ? `Prévisions météo à 7 jours à l’emplacement de la station (${place.name})`
      : 'Position de la station inconnue : prévisions indisponibles';
    const sub = [
      station.commune,
      Number.isFinite(station.altitude) ? `${Math.round(station.altitude)} m d’altitude` : '',
      station.premiere_mesure ? `données depuis le ${formatDateShort(dayKey(new Date(station.premiere_mesure)), true)}` : '',
      station.commentaire
    ].filter(Boolean);
    $('donStationSub').textContent = sub.join(' · ');
    $('donStationState').className = `don-state is-${state.key}`;
    $('donStationState').textContent = state.label;
    $('donStationState').title = station.derniere_erreur || (station.derniere_mesure ? `Dernière mesure ${whenLabel(new Date(station.derniere_mesure))}` : '');

    const today = todayISO();
    const last = recent.last;
    const rain24 = recent.rows.reduce((s, r) => s + (r.rain || 0), 0);
    const todayRows = recent.rows.filter(r => r.t !== null && dayKey(r.at) === today);
    const minRow = todayRows.reduce((m, r) => (m && m.t <= r.t ? m : r), null);
    const maxRow = todayRows.reduce((m, r) => (m && m.t >= r.t ? m : r), null);
    // Encarts des seuls capteurs affichés (un capteur masqué n'a pas d'encart).
    const kpis = [
      shown('t1') && kpi('Température', last?.t !== null && last ? `${formatNumber(last.t, 1)}<small> °C</small>` : '—', last ? whenLabel(last.at) : 'aucune mesure'),
      shown('hyg1') && kpi('Humidité relative', last?.hr !== null && last ? `${formatNumber(last.hr, 0)}<small> %</small>` : '—', last ? whenLabel(last.at) : ''),
      shown('pluv') && kpi('Pluviométrie 24 h', recent.rows.length && access().meteo ? `${formatNumber(rain24, 1)}<small> mm</small>` : '—', 'dernières 24 heures'),
      shown('t1') && kpi('T min / T max du jour', minRow ? `${formatNumber(minRow.t, 1)} / ${formatNumber(maxRow.t, 1)}<small> °C</small>` : '—',
        minRow ? `aujourd’hui · min ${hourOf(minRow.at)} · max ${hourOf(maxRow.at)}` : 'aucune mesure aujourd’hui')
    ].filter(Boolean);
    $('donKpis').innerHTML = kpis.join('');
    $('donKpis').style.setProperty('--kpis', String(Math.max(kpis.length, 1)));
    $('donKpis').classList.toggle('hidden', !kpis.length);
  }

  // -------------------------------------------------------------------------
  // Base de temps (horaire ou journalière) et agrégats
  // -------------------------------------------------------------------------
  function timeBase() {
    const p = ctx.period.get();
    if (!p?.start) return { mode, labels: [], items: [] };
    if (mode === 'hourly') {
      const start = parisInstant(p.start).getTime();
      const end = Math.min(parisInstant(p.end, true).getTime(), Date.now());
      const bySlot = new Map(hourly.map(row => [Math.floor(row.at.getTime() / HOUR), row]));
      const items = [];
      for (let s = Math.floor(start / HOUR); s <= Math.floor(end / HOUR); s += 1) {
        const at = new Date(s * HOUR);
        items.push({ at, day: dayKey(at), hour: hourOf(at), row: bySlot.get(s) || null });
      }
      return { mode, items, labels: items.map(i => `${formatDayMonth(i.day)} ${i.hour.slice(0, 2)}h`) };
    }
    const items = dailyRows();
    return { mode, items, labels: items.map(d => formatDayMonth(d.day)) };
  }

  function dailyRows() {
    const p = ctx.period.get();
    if (!p?.start) return [];
    const byDay = new Map();
    hourly.forEach(row => {
      const key = dayKey(row.at);
      const d = byDay.get(key) || { t: [], hr: [], rain: 0, rainSeen: false, n: 0, others: {} };
      if (row.t !== null) d.t.push(row.t);
      if (row.hr !== null) d.hr.push(row.hr);
      if (row.rain !== null) { d.rain += row.rain; d.rainSeen = true; }
      Object.entries(row.others).forEach(([code, value]) => {
        const v = num(value);
        if (v !== null) (d.others[code] = d.others[code] || []).push(v);
      });
      d.n += 1;
      byDay.set(key, d);
    });
    const days = [];
    const last = p.end > todayISO() ? todayISO() : p.end;
    for (let day = p.start; day <= last; day = addDaysISO(day, 1)) {
      const d = byDay.get(day);
      days.push({
        day,
        tmin: d?.t.length ? Math.min(...d.t) : null,
        tmax: d?.t.length ? Math.max(...d.t) : null,
        tmoy: avg(d?.t),
        hrmin: d?.hr.length ? Math.min(...d.hr) : null,
        hrmax: d?.hr.length ? Math.max(...d.hr) : null,
        hr: avg(d?.hr),
        rain: d?.rainSeen ? d.rain : null,
        n: d?.n || 0,
        others: Object.fromEntries(Object.entries(d?.others || {}).map(([code, list]) => [code, avg(list)]))
      });
    }
    return days;
  }

  /** Codes des capteurs complémentaires présents (fiche station + mesures), hors capteurs masqués. */
  function sensorCodes() {
    const hide = masked();
    const keep = code => !IGNORED.has(code) && !hide.has(code);
    const codes = new Set((selected()?.capteurs || []).filter(keep));
    hourly.forEach(row => Object.keys(row.others).forEach(code => { if (keep(code)) codes.add(code); }));
    return [...codes].sort((a, b) => (sensorLabels[a]?.ordre ?? 100) - (sensorLabels[b]?.ordre ?? 100) || a.localeCompare(b));
  }

  // -------------------------------------------------------------------------
  // Graphiques : définitions par onglet
  // -------------------------------------------------------------------------
  function series(base, pick) {
    return base.items.map(item => round(pick(item)));
  }

  function lineSpec(id, title, unit, datasets, { hint = '', yMin, yMax } = {}) {
    return { id, title, unit, hint, kind: 'line', datasets, yMin, yMax };
  }

  function rainSpec(id, base, title = 'Pluviométrie') {
    const values = base.items.map(item => (base.mode === 'hourly' ? item.row?.rain ?? null : item.rain));
    let total = 0;
    const cumul = values.map(v => { total += v || 0; return round(total); });
    return {
      id, title, unit: 'mm', hint: '', kind: 'rain',
      datasets: [
        { label: base.mode === 'hourly' ? 'Pluviométrie horaire (mm)' : 'Pluviométrie journalière (mm)', data: values.map(v => round(v)), color: COLORS.rain, type: 'bar' },
        { label: 'Cumul (mm)', data: cumul, color: COLORS.cumul, type: 'line', axis: 'y2' }
      ]
    };
  }

  function familySpec(id, family, codes, base) {
    const def = FAMILIES[family];
    const unit = def.unit || sensorUnit(codes[0]);
    return lineSpec(id, def.title, unit, codes.map((code, i) => ({
      label: `${sensorName(code)}${base.mode === 'daily' ? ' · moyenne du jour' : ''}`,
      data: base.mode === 'hourly' ? base.items.map(it => round(num(it.row?.others?.[code]))) : base.items.map(d => round(d.others[code] ?? null)),
      color: family === 'humect' ? COLORS.humect : SENSOR_COLORS[i % SENSOR_COLORS.length]
    })), { hint: def.hint, yMin: unit === '%' ? 0 : undefined, yMax: family === 'humect' ? 100 : undefined });
  }

  function meteoSpecs(base) {
    const specs = [];
    if (base.mode === 'hourly') {
      if (shown('t1')) specs.push(lineSpec('temp', 'Température', '°C', [{ label: 'Température (°C)', data: series(base, it => it.row?.t ?? null), color: COLORS.temp }]));
      if (shown('hyg1')) specs.push(lineSpec('hr', 'Humidité relative', '%', [{ label: 'Humidité relative (%)', data: series(base, it => it.row?.hr ?? null), color: COLORS.hr }], { yMin: 0, yMax: 100 }));
    } else {
      if (shown('t1')) {
        specs.push(lineSpec('temp', 'Température', '°C', [
          { label: 'T max (°C)', data: series(base, d => d.tmax), color: COLORS.tmax, dash: [6, 4], width: 1.8 },
          { label: 'T moy. (°C)', data: series(base, d => d.tmoy), color: COLORS.tmoy, width: 2.2 },
          { label: 'T min (°C)', data: series(base, d => d.tmin), color: COLORS.tmin, dash: [6, 4], width: 1.8 }
        ]));
      }
      if (shown('hyg1')) {
        specs.push(lineSpec('hr', 'Humidité relative', '%', [
          { label: 'HR max (%)', data: series(base, d => d.hrmax), color: COLORS.hrLight, dash: [5, 4], width: 1.4 },
          { label: 'HR moy. (%)', data: series(base, d => d.hr), color: COLORS.hr },
          { label: 'HR min (%)', data: series(base, d => d.hrmin), color: COLORS.hrLight, dash: [2, 3], width: 1.4 }
        ], { yMin: 0, yMax: 100 }));
      }
    }
    // La pluviométrie n'est tracée que dans l'onglet Météo.
    if (shown('pluv')) specs.push(rainSpec('rain', base));
    const humect = sensorCodes().filter(FAMILIES.humect.test);
    if (humect.length) specs.push(familySpec('humect', 'humect', humect, base));
    return specs;
  }

  function irrigationSpecs(base) {
    const codes = sensorCodes();
    const specs = [];
    ['dendro', 'tensio', 'capa'].forEach(family => {
      const list = codes.filter(FAMILIES[family].test);
      if (list.length) specs.push(familySpec(family, family, list, base));
    });
    const known = Object.values(FAMILIES);
    const others = codes.filter(code => !known.some(f => f.test(code)));
    if (others.length) {
      specs.push(lineSpec('autres', 'Autres capteurs', '', others.map((code, i) => ({
        label: `${sensorName(code)}${sensorUnit(code) ? ` (${sensorUnit(code)})` : ''}`,
        data: base.mode === 'hourly' ? base.items.map(it => round(num(it.row?.others?.[code]))) : base.items.map(d => round(d.others[code] ?? null)),
        color: SENSOR_COLORS[(i + 3) % SENSOR_COLORS.length]
      }))));
    }
    return specs;
  }

  // -------------------------------------------------------------------------
  // Dessin, zoom et export
  // -------------------------------------------------------------------------
  const narrow = () => window.innerWidth < 600;

  function chartConfig(spec, base) {
    const labels = base.labels;
    const time = { items: base.items, mode: base.mode };
    const datasets = spec.datasets.map(ds => {
      if (ds.type === 'bar') {
        return { type: 'bar', label: ds.label, data: ds.data, backgroundColor: ds.color, borderRadius: 2, maxBarThickness: 14, yAxisID: 'y' };
      }
      return {
        type: 'line', label: ds.label, data: ds.data, borderColor: ds.color, backgroundColor: ds.color,
        borderWidth: ds.width || 2, borderDash: ds.dash || [], pointRadius: 0, pointHoverRadius: 3, tension: 0.25, spanGaps: false,
        yAxisID: ds.axis === 'y2' ? 'y2' : 'y'
      };
    });
    const scales = {
      // Petits traits au-dessus des dates : heures, jours, semaines selon la place disponible.
      x: timeAxis(time, { fontSize: narrow() ? 11 : 12 }),
      y: {
        beginAtZero: spec.kind === 'rain',
        min: spec.yMin, max: spec.yMax,
        grid: { color: '#eef0f3' }, border: { display: false },
        ticks: { color: '#4b5058' },
        title: { display: Boolean(spec.unit), text: spec.unit, color: '#4b5058', font: { size: 12, weight: '600' } }
      }
    };
    if (spec.kind === 'rain') {
      scales.y2 = { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, border: { display: false }, ticks: { color: '#4b5058' }, title: { display: true, text: 'cumul (mm)', color: '#4b5058', font: { size: 12, weight: '600' } } };
    }
    return {
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 9, boxHeight: 8, padding: 16, font: { size: 13 }, color: '#2b3038' } },
          tooltip: {
            padding: 10, cornerRadius: 8,
            callbacks: { label: c => `${c.dataset.label} : ${c.parsed.y === null ? '—' : formatNumber(c.parsed.y, spec.unit === '%' || spec.unit === 'cb' ? 0 : 1)}` }
          },
          samTimeTicks: time
        },
        scales
      },
      plugins: [timeTicksPlugin]
    };
  }

  function updateZoomBar(range) {
    $('donZoomReset').classList.toggle('hidden', !range);
    const labels = [...charts.values()][0]?.chart.data.labels || [];
    $('donZoomHint').textContent = range
      ? `Zoom : ${labels[range.min] || ''} → ${labels[range.max] || ''} · double-clic pour revenir en arrière`
      : 'Glissez sur un graphique pour zoomer · double-clic pour revenir en arrière';
  }

  function resetZoom() {
    resetZoomGroup(zoom, { apply: false });
  }

  function destroyCharts() {
    charts.forEach(({ chart }) => chart.destroy());
    charts.clear();
  }

  function renderChartList(container, specs, base) {
    destroyCharts();
    container.innerHTML = specs.map(spec => `<article class="don-card don-chart-card" data-chart="${spec.id}">
      <header class="don-chart-head">
        <div>
          <h3>${escapeHtml(spec.title)}${spec.unit ? ` <small>(${escapeHtml(spec.unit)})</small>` : ''}</h3>
          ${spec.hint ? `<p class="don-chart-hint">${escapeHtml(spec.hint)}</p>` : ''}
        </div>
        <button class="sam-csv-button" type="button" data-csv="${spec.id}" title="Télécharger les données de ce graphique (CSV)">CSV</button>
      </header>
      <div class="don-chart${spec.kind === 'rain' ? ' is-short' : ''}"><canvas aria-label="${escapeHtml(spec.title)}"></canvas></div>
    </article>`).join('');
    specs.forEach(spec => {
      const canvas = container.querySelector(`[data-chart="${spec.id}"] canvas`);
      const chart = new window.Chart(canvas, chartConfig(spec, base));
      enableChartZoom(chart, { group: zoom, resetButton: false });
      charts.set(spec.id, { chart, spec, base });
    });
    updateZoomBar(zoom.range);
  }

  function download(name, lines) {
    const csv = lines.map(line => line.map(cell => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportChart(id) {
    const entry = charts.get(id);
    const station = selected();
    const p = ctx.period.get();
    if (!entry || !station) return;
    const { spec, base } = entry;
    const timeHeader = base.mode === 'hourly' ? ['date', 'heure'] : ['jour'];
    const header = [...timeHeader, ...spec.datasets.map(ds => ds.label)];
    const lines = base.items.map((item, i) => [
      ...(base.mode === 'hourly' ? [item.day, item.hour] : [item.day]),
      ...spec.datasets.map(ds => csvNumber(ds.data[i]))
    ]);
    download(`SAM_${safeName(station.nom)}_${safeName(spec.title)}_${base.mode === 'hourly' ? 'horaire' : 'journalier'}_${p.start}_${p.end}.csv`, [header, ...lines]);
  }

  // -------------------------------------------------------------------------
  // Onglets
  // -------------------------------------------------------------------------
  const NOT_SHARED = {
    meteo: 'Les données météo de cette station ne sont pas partagées avec votre compte.',
    irrigation: 'Les données d’irrigation de cette station (tensiomètres, sondes, dendromètres) ne sont pas partagées avec votre compte.'
  };

  function renderMeteo() {
    const base = timeBase();
    const blocked = !access().meteo;
    const specs = blocked ? [] : meteoSpecs(base);
    const columns = blocked ? [] : dailyColumns();
    const message = blocked ? NOT_SHARED.meteo
      : !specs.length ? 'Aucun capteur météo affiché pour cette station.'
        : !hourly.length ? 'Aucune mesure reçue sur cette période.' : '';
    $('donMeteoEmpty').textContent = message;
    $('donMeteoEmpty').classList.toggle('hidden', !message);
    $('donDaily').classList.toggle('hidden', !columns.length);
    if (message) { destroyCharts(); $('donMeteoCharts').innerHTML = ''; }
    else renderChartList($('donMeteoCharts'), specs, base);
    if (columns.length) renderDailyTable();
  }

  function renderIrrigation() {
    const base = timeBase();
    const blocked = !access().irrigation;
    const specs = blocked ? [] : irrigationSpecs(base);
    const message = blocked ? NOT_SHARED.irrigation
      : !hourly.length ? 'Aucune mesure reçue sur cette période.'
        : !specs.length ? 'Aucun capteur d’irrigation (tensiomètre, sonde capacitive, dendromètre) affiché pour cette station.' : '';
    $('donIrrigationEmpty').textContent = message;
    $('donIrrigationEmpty').classList.toggle('hidden', !message);
    if (message) { destroyCharts(); $('donIrrigationCharts').innerHTML = ''; }
    else renderChartList($('donIrrigationCharts'), specs, base);
  }

  function renderMaladies() {
    destroyCharts();
    const station = selected();
    const box = $('donRimpro');
    if (!station) { box.innerHTML = ''; return; }
    if (!access().meteo) {
      box.innerHTML = `<div class="don-card don-rim-empty"><h3>Données non partagées</h3><p>${NOT_SHARED.meteo} Les modèles RIMpro, calculés à partir de la météo de la station, ne sont donc pas affichés.</p></div>`;
      return;
    }
    const id = (station.rimpro_id || '').trim();
    if (!id) {
      box.innerHTML = `<div class="don-card don-rim-empty">
        <h3>Pas de modèle RIMpro pour cette station</h3>
        <p>Les modèles maladies et ravageurs calculés par RIMpro (tavelure, feu bactérien, carpocapse, psylle…) s’affichent ici pour les stations abonnées.</p>
        ${isAdmin() ? '<p class="don-hint">Administrateur : renseignez l’identifiant RIMpro de la station dans la « Fiche station ».</p>' : ''}
      </div>`;
      return;
    }
    const model = RIMPRO_MODELS.find(m => m.id === rimproModel) || RIMPRO_MODELS[0];
    const url = `https://www.rimpro.eu/${model.path}?id=${encodeURIComponent(id)}&lang=fr`;
    box.innerHTML = `<article class="don-card don-rim">
      <header class="don-rim-head">
        <div class="don-rim-models" role="group" aria-label="Modèle RIMpro">
          ${RIMPRO_GROUPS.map(group => `<div class="don-rim-group">
            <span class="don-rim-group-label">${group.label}</span>
            <div class="don-rim-chips">${group.models.map(m => `<button type="button" data-rim="${m.id}" class="don-rim-chip${m.id === model.id ? ' is-active' : ''}" aria-pressed="${m.id === model.id}">${m.label}</button>`).join('')}</div>
          </div>`).join('')}
        </div>
        <label class="don-rim-select">
          <span>Modèle RIMpro</span>
          <select id="donRimSelect">
            ${RIMPRO_GROUPS.map(group => `<optgroup label="${group.label}">${group.models.map(m => `<option value="${m.id}"${m.id === model.id ? ' selected' : ''}>${m.label}</option>`).join('')}</optgroup>`).join('')}
          </select>
        </label>
        <a class="don-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener">Ouvrir dans RIMpro ↗</a>
      </header>
      <div class="don-rim-frame is-loading">
        <div class="don-rim-loading" role="status"><span class="don-rim-spinner" aria-hidden="true"></span><span id="donRimLoadingText">Chargement du modèle RIMpro…</span></div>
        <iframe src="${escapeHtml(url)}" title="RIMpro — ${escapeHtml(model.label)} — ${escapeHtml(station.nom)}" referrerpolicy="no-referrer-when-downgrade"></iframe>
      </div>
      <p class="don-hint">Modèle ${escapeHtml(model.label.toLowerCase())} calculé par RIMpro à partir de la station. Si le graphique ne s’affiche pas, utilisez « Ouvrir dans RIMpro ».</p>
    </article>`;
    box.querySelector('#donRimSelect').addEventListener('change', event => {
      rimproModel = event.target.value;
      storage.set('donnees.rimpro', rimproModel);
      renderMaladies();
    });
    const frame = box.querySelector('.don-rim-frame');
    const iframe = frame.querySelector('iframe');
    iframe.addEventListener('load', () => frame.classList.remove('is-loading'), { once: true });
    ctx.scope.timeout(() => {
      const text = box.querySelector('#donRimLoadingText');
      if (text && frame.classList.contains('is-loading')) text.textContent = 'RIMpro met un peu de temps à répondre…';
    }, 12000);
  }

  /** Colonnes du résumé journalier (tableau et CSV) : seulement les capteurs affichés. */
  function dailyColumns() {
    const temp = v => (v === null ? '—' : `${formatNumber(v, 1)} °C`);
    const hasHumect = sensorCodes().includes('hum');
    return [
      shown('t1') && { head: 'T min', csv: 't_min_C', html: d => temp(d.tmin), value: d => round(d.tmin) },
      shown('t1') && { head: 'T max', csv: 't_max_C', html: d => temp(d.tmax), value: d => round(d.tmax) },
      shown('t1') && { head: 'T moy.', csv: 't_moy_C', html: d => temp(d.tmoy), value: d => round(d.tmoy, 2) },
      shown('hyg1') && { head: 'HR moy.', csv: 'hr_moy_pct', html: d => (d.hr === null ? '—' : `${formatNumber(d.hr, 0)} %`), value: d => round(d.hr) },
      shown('pluv') && { head: 'Pluviométrie', csv: 'pluviometrie_mm', html: d => (d.rain === null ? '—' : `${formatNumber(d.rain, 1)} mm`), value: d => (d.rain === null ? null : round(d.rain)) },
      hasHumect && { head: 'Humect. moy.', csv: 'humectation_moy_pct', html: d => ((d.others.hum ?? null) === null ? '—' : `${formatNumber(d.others.hum, 0)} %`), value: d => round(d.others.hum ?? null) }
    ].filter(Boolean);
  }

  function renderDailyTable() {
    const days = dailyRows();
    const columns = dailyColumns();
    $('donDailyHead').innerHTML = `<tr><th>Jour</th>${columns.map(c => `<th>${c.head}</th>`).join('')}</tr>`;
    const body = $('donDailyBody');
    const more = $('donDailyMore');
    if (!days.length) {
      body.innerHTML = `<tr><td colspan="${columns.length + 1}" class="don-empty-cell">Aucune donnée.</td></tr>`;
      more.classList.add('hidden');
      return;
    }
    const ordered = [...days].reverse();
    const visible = dailyExpanded ? ordered : ordered.slice(0, 7);
    body.innerHTML = visible.map(d => `<tr class="${d.n === 0 ? 'is-empty' : ''}">
      <td data-label="Jour">${formatDateShort(d.day, true)}</td>
      ${columns.map(c => `<td data-label="${c.head}">${c.html(d)}</td>`).join('')}
    </tr>`).join('');
    const hidden = ordered.length - 7;
    more.classList.toggle('hidden', hidden <= 0);
    more.textContent = dailyExpanded ? 'Voir moins' : `Voir plus (${hidden} jour${hidden > 1 ? 's' : ''})`;
  }

  function exportDaily() {
    const station = selected();
    const p = ctx.period.get();
    const days = dailyRows();
    const columns = dailyColumns();
    if (!station || !days.length || !columns.length) return ctx.ui.toast('Aucune donnée à exporter.');
    const header = ['jour', ...columns.map(c => c.csv)];
    const lines = days.map(d => [d.day, ...columns.map(c => csvNumber(c.value(d)))]);
    download(`SAM_${safeName(station.nom)}_resume_journalier_${p.start}_${p.end}.csv`, [header, ...lines]);
  }

  /** Export Excel de la période : mesures horaires (tous les capteurs visibles) et résumé journalier. */
  async function exportExcel(button) {
    const station = selected();
    const p = ctx.period.get();
    if (!station || !hourly.length) return ctx.ui.toast('Aucune mesure à exporter sur cette période.');
    button.disabled = true;
    try {
      await ctx.vendor.xlsx();
      const XLSX = window.XLSX;
      const codes = [...new Set(hourly.flatMap(r => Object.keys(r.others)))].filter(shown).sort();
      const base = [
        shown('t1') && { head: 'Température air (°C)', get: r => r.t },
        shown('hyg1') && { head: 'Humidité relative (%)', get: r => r.hr },
        shown('pluv') && { head: 'Pluviométrie (mm)', get: r => r.rain }
      ].filter(Boolean);
      const autres = codes.map(code => ({ head: `${sensorName(code)}${sensorUnit(code) ? ` (${sensorUnit(code)})` : ''}`, get: r => num(r.others[code]) }));
      const cols = [...base, ...autres];
      const horaire = [['Date', 'Heure', ...cols.map(c => c.head)], ...hourly.map(r => [dayKey(r.at), hourOf(r.at), ...cols.map(c => round(c.get(r)))])];
      const daily = dailyColumns();
      const journalier = [['Jour', ...daily.map(c => c.head)], ...dailyRows().map(d => [d.day, ...daily.map(c => c.value(d))])];
      const wb = XLSX.utils.book_new();
      const ws1 = XLSX.utils.aoa_to_sheet(horaire);
      ws1['!cols'] = [{ wch: 11 }, { wch: 7 }, ...cols.map(c => ({ wch: Math.max(10, Math.min(28, c.head.length + 2)) }))];
      const ws2 = XLSX.utils.aoa_to_sheet(journalier);
      ws2['!cols'] = [{ wch: 11 }, ...daily.map(() => ({ wch: 13 }))];
      XLSX.utils.book_append_sheet(wb, ws1, 'Horaire');
      XLSX.utils.book_append_sheet(wb, ws2, 'Journalier');
      XLSX.writeFile(wb, `SAM_${safeName(station.nom)}_${p.start}_${p.end}.xlsx`);
    } catch (error) {
      ctx.ui.toast(`Export impossible : ${error.message || error}`, 5000);
    } finally {
      button.disabled = false;
    }
  }

  function renderView() {
    root.querySelectorAll('.don-view-tab').forEach(tab => {
      const on = tab.dataset.view === view;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
    });
    root.querySelectorAll('.don-view').forEach(panel => { panel.hidden = panel.dataset.panel !== view; });
    // Les graphiques des onglets masqués sont retirés (ils seront redessinés à l'ouverture).
    destroyCharts();
    if (view !== 'meteo') $('donMeteoCharts').innerHTML = '';
    if (view !== 'irrigation') $('donIrrigationCharts').innerHTML = '';
    if (view !== 'maladies') $('donRimpro').innerHTML = '';
    const timed = view !== 'maladies';
    $('donFilters').classList.toggle('hidden', !timed);
    modeButtons.forEach(b => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    if (view === 'meteo') renderMeteo();
    else if (view === 'irrigation') renderIrrigation();
    else renderMaladies();
    // Aide au zoom seulement quand des graphiques sont affichés.
    $('donZoomBar').classList.toggle('hidden', !timed || !charts.size);
  }

  function renderAll() {
    const station = selected();
    $('donStation').classList.toggle('hidden', !station);
    $('donToolbar').classList.toggle('hidden', !station);
    root.querySelectorAll('.don-view').forEach(panel => panel.classList.toggle('hidden', !station));
    $('donZoomBar').classList.toggle('hidden', !station);
    if (!station) return;
    renderHeader();
    renderView();
  }

  // -------------------------------------------------------------------------
  // Administration
  // -------------------------------------------------------------------------
  // Fiche station : la même fenêtre que Administration → Stations → « Modifier » (full admin).
  let stationDialog = null;
  function openEditor() {
    const station = selected();
    if (!station || !isAdmin()) return;
    stationDialog ||= createStationDialog(ctx, { host: root, onSaved: () => refreshAll() });
    stationDialog.open(station);
  }

  // -------------------------------------------------------------------------
  // Orchestration
  // -------------------------------------------------------------------------
  function showSetupMessage(error) {
    const missing = /relation|does not exist|schema cache|stations/i.test(error?.message || '');
    $('donSetup').innerHTML = missing
      ? 'Les tables des stations ne sont pas encore créées dans Supabase (fichier « supabase/stations.sql »).'
      : `Impossible de charger les stations : ${escapeHtml(error?.message || String(error))}`;
    $('donSetup').classList.remove('hidden');
  }

  async function refreshStation({ keepZoom = false } = {}) {
    if (!keepZoom) resetZoom();
    try {
      await loadStationData();
      if (!ctx.scope.disposed) renderAll();
    } catch (error) {
      console.error(error);
      ctx.ui.toast(`Mesures indisponibles : ${error.message || error}`, 6000);
    }
  }

  async function refreshAll() {
    await store.load(true);
    if (ctx.scope.disposed) return;
    if (store.error) {
      showSetupMessage(store.error);
      renderAll();
      return;
    }
    $('donSetup').classList.add('hidden');
    if (!store.list.length) {
      $('donSetup').textContent = 'Aucune station visible pour le moment.';
      $('donSetup').classList.remove('hidden');
    }
    await refreshStation({ keepZoom: true });
  }

  // Événements
  root.querySelectorAll('.don-view-tab').forEach(tab => tab.addEventListener('click', () => {
    if (view === tab.dataset.view) return;
    view = tab.dataset.view;
    storage.set('donnees.view', view);
    renderView();
  }));
  modeButtons.forEach(button => button.addEventListener('click', () => {
    if (mode === button.dataset.mode) return;
    mode = button.dataset.mode;
    storage.set('donnees.mode', mode);
    resetZoom();
    renderView();
  }));
  $('donZoomReset').addEventListener('click', () => resetZoomGroup(zoom));
  root.addEventListener('click', event => {
    const csv = event.target.closest('[data-csv]');
    if (csv) exportChart(csv.dataset.csv);
    const rim = event.target.closest('[data-rim]');
    if (rim) { rimproModel = rim.dataset.rim; storage.set('donnees.rimpro', rimproModel); renderMaladies(); }
  });
  $('donDailyMore').addEventListener('click', () => { dailyExpanded = !dailyExpanded; renderDailyTable(); });
  $('donDailyCsv').addEventListener('click', exportDaily);
  $('donExport').addEventListener('click', event => exportExcel(event.currentTarget));
  $('donForecast').addEventListener('click', () => {
    const place = stationPlace(selected());
    if (!place) { ctx.ui.toast('Position de la station inconnue : prévisions indisponibles.'); return; }
    ctx.location.set(place, { save: false });
    storage.set('indicateurs.tab', 'meteo');
    ctx.navigate('indicateurs');
  });
  $('donEditStation').addEventListener('click', openEditor);
  ctx.stations.onChange(event => {
    if (event.type === 'select') {
      dailyExpanded = false;
      refreshStation();
    }
  });
  ctx.period.onChange(() => { dailyExpanded = false; refreshStation(); });
  ctx.onAuthChange(() => { renderAdmin(); renderAll(); });
  // Mise à jour automatique toutes les 10 minutes tant que la page est ouverte
  ctx.scope.interval(() => { if (document.visibilityState === 'visible') refreshAll(); }, 10 * 60 * 1000);

  renderAdmin();
  await Promise.all([store.load(), loadSensors().catch(() => null)]);
  if (ctx.scope.disposed) return {};
  if (store.error) showSetupMessage(store.error);
  else if (!store.list.length) {
    $('donSetup').textContent = 'Aucune station visible pour le moment.';
    $('donSetup').classList.remove('hidden');
  }
  await refreshStation();

  return {
    unmount() {
      destroyCharts();
    }
  };
}
