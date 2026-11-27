// SAM Programmation irrigation — calculatrice de programmation sur une période.
// Reprise de l'appli « SAM Irrigation » : le lieu et la période se choisissent dans la carte
// « Période de programmation ».
import { presets } from '../core/period.js';
import { enableChartZoom } from '../core/charts.js';
import { todayISO, addDaysISO, diffDaysISO, storage, escapeHtml } from '../core/util.js';
import { CULTURES, FAMILLES, parId } from '../fao56/data/cultures-2025.js';
import * as C from '../fao56/coefficients.js';
import { NOMS_STADE, estAnnuel, stadesModele, dureesModele } from '../fao56/saison.js';

const TEMPLATE = `
<div class="tool-main">
  <section class="card">
    <p class="eyebrow">Paramètres de la parcelle</p>
    <h2>Caractéristiques de la parcelle et de l’irrigation</h2>

    <div class="irr-tabs" role="tablist" aria-label="Paramètres de la parcelle">
      <button type="button" role="tab" id="irrTab-culture" data-tab="culture" aria-controls="irrPanel-culture" aria-selected="true">Culture</button>
      <button type="button" role="tab" id="irrTab-irrigation" data-tab="irrigation" aria-controls="irrPanel-irrigation" aria-selected="false" tabindex="-1">Irrigation</button>
      <button type="button" role="tab" id="irrTab-calcul" data-tab="calcul" aria-controls="irrPanel-calcul" aria-selected="false" tabindex="-1">Calcul</button>
    </div>

    <div class="irr-panel" id="irrPanel-culture" role="tabpanel" aria-labelledby="irrTab-culture">
      <div class="form-grid">
        <label>Espèce<select id="cropSpecies"></select></label>
        <label id="cropClassLabel">Conduite / densité<select id="cropClass"></select></label>
      </div>
      <div class="irr-stade">
        <div class="irr-stade-tete">
          <label for="stagePos">Où en est la culture aujourd’hui ?</label>
          <strong id="stageName">—</strong>
        </div>
        <input id="stagePos" type="range" min="0" max="120" step="1" aria-describedby="stageHelp">
        <div id="stageBand" class="irr-stade-bande" aria-hidden="true"></div>
        <p id="stageHelp" class="irr-stade-aide"></p>
      </div>
      <p id="kcInfo" class="irr-kc"></p>
      <details class="info-box">
        <summary>ⓘ D’où vient le Kc ?</summary>
        <div id="kcExplain"></div>
      </details>
    </div>

    <div class="irr-panel" id="irrPanel-irrigation" role="tabpanel" aria-labelledby="irrTab-irrigation" hidden>
      <div class="form-grid">
        <label>Système d'irrigation
          <select id="systemType">
            <option value="drip">Goutte-à-goutte</option>
            <option value="micro">Micro-aspersion</option>
            <option value="sprinkler">Aspersion</option>
          </select>
        </label>
        <label>Calcul de la pluviométrie
          <select id="rateMode">
            <option value="known">Pluviométrie connue</option>
            <option value="calculated">Calcul à partir des émetteurs</option>
          </select>
        </label>
        <label id="knownRateLabel">Pluviométrie (mm/h)<input id="knownRate" type="number" min="0.01" step="0.01"></label>
        <label id="emitterFlowLabel">Débit de l'émetteur (L/h)<input id="emitterFlow" type="number" min="0.01" step="0.01"></label>
        <label id="emitterSpacingLabel">Espacement entre émetteurs (m)<input id="emitterSpacing" type="number" min="0.01" step="0.01"></label>
        <label id="rowSpacingLabel">Inter-rang (m)<input id="rowSpacing" type="number" min="0.01" step="0.01"></label>
      </div>
    </div>

    <div class="irr-panel" id="irrPanel-calcul" role="tabpanel" aria-labelledby="irrTab-calcul" hidden>
      <div class="form-grid">
        <label>Kc personnalisé (vide = automatique)<input id="kcValue" type="number" min="0" max="2" step="0.05" placeholder="Automatique"></label>
        <label>Part de pluie prise en compte (%)<input id="rainEfficiency" type="number" min="0" max="100" step="5"></label>
        <label>Surface de la parcelle (ha)<input id="surfaceHa" type="number" min="0.01" step="0.01"></label>
      </div>
      <p id="kcOverrideInfo" class="muted"></p>
      <details class="info-box">
        <summary>ⓘ Comprendre la part de pluie prise en compte</summary>
        <p>Cette valeur correspond à la part de la pluie retenue dans le calcul du besoin d’irrigation, en fonction de la zone racinaire généralement alimentée par le système choisi.</p>
        <p id="rainRecommendationInfo"><strong>Valeur indicative : —</strong></p>
      </details>
    </div>
  </section>

  <section class="card">
    <p class="eyebrow">Période de programmation</p>
    <h2>Dates et fréquence d’irrigation</h2>
    <div id="irrFilters" class="irr-filters"></div>
    <div id="periodPreview" class="period-preview"></div>
    <div class="form-grid">
      <label>Dernier arrosage<input id="lastIrrigation" type="date"></label>
      <label>Fréquence d'irrigation
        <select id="frequency">
          <option value="daily">Tous les jours</option>
          <option value="every2">Tous les 2 jours</option>
          <option value="twiceWeekly">2 fois par semaine</option>
          <option value="weekly">1 fois par semaine</option>
        </select>
      </label>
    </div>
    <div class="forecast-notice">
      <strong>Recommandation basée sur les prévisions météo</strong>
      <p>Cette programmation est une estimation calculée avec les prévisions disponibles au moment du calcul. Elles peuvent évoluer, en particulier pour la pluie. Une pluie prévue à plusieurs jours peut être décalée, plus faible ou ne pas se produire. Vérifiez régulièrement les prévisions et ajustez la programmation si nécessaire.</p>
    </div>
    <div class="button-row">
      <button id="calculateButton" class="primary-button" type="button">Calculer la programmation</button>
    </div>
  </section>

  <p id="errorMessage" class="error" hidden></p>

  <section class="card result-card">
    <p class="eyebrow">Programmation recommandée pour la période choisie</p>
    <p id="resultPeriod" class="result-period">—</p>
    <div class="main-result"><strong id="totalNeed">— mm</strong><span>à programmer sur la période</span></div>
    <div class="result-grid">
      <article><span>Nombre d'apports</span><strong id="applicationCount">—</strong></article>
      <article><span>Dose par apport</span><strong id="dosePerApplication">— mm</strong></article>
      <article><span>Volume par apport</span><strong id="volumePerApplication">— m³</strong></article>
      <article><span>Durée par apport</span><strong id="durationPerApplication">—</strong></article>
    </div>
  </section>

  <section class="card">
    <p class="eyebrow">Composition du besoin</p>
    <div class="result-grid">
      <article><span>Déficit avant la période</span><strong id="pastDeficit">— mm</strong></article>
      <article><span>Besoin brut de la période</span><strong id="periodGrossNeed">— mm</strong></article>
      <article><span>Pluie sur la période</span><strong id="periodRain">— mm</strong></article>
      <article><span>Pluie efficace sur la période</span><strong id="periodEffectiveRain">— mm</strong></article>
      <article><span>Besoin net de la période</span><strong id="periodNetNeed">— mm</strong></article>
      <article><span>Kc sur la période</span><strong id="periodKc">—</strong></article>
    </div>
  </section>

  <section class="card">
    <p class="eyebrow">Météo</p>
    <h2>Période de calcul et jours précédents</h2>
    <div class="irr-legend">
      <span><i class="irr-swatch is-et0"></i>ET₀ (mm)</span>
      <span><i class="irr-swatch is-rain"></i>Pluie (mm)</span>
      <span><i class="irr-swatch is-forecast"></i>Début des prévisions</span>
    </div>
    <div class="irr-chart"><canvas id="weatherChart" aria-label="ET0 et pluie journalières"></canvas></div>

  </section>
  <p id="updatedAt" class="muted center"></p>
  <p class="attribution">Données météo : <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo.com</a> (CC BY 4.0).</p>
</div>`;

const DEFAULTS = {
  surfaceHa: 1,
  lastIrrigation: null,
  frequency: 'daily',
  rainEfficiency: 25,
  rainAutoSystem: null,
  kcOverride: null,
  // Culture (FAO-56, 2025) et position dans la saison (curseur, valeur du jour stageDate)
  cultureId: 'pommier',
  classeId: 'medium-central-leader-1-500-3-000-pl-ha',
  stagePos: null,
  stageDate: null,
  systemType: 'drip',
  rateMode: 'known',
  knownRate: 3,
  emitterFlow: 1.6,
  emitterSpacing: 0.5,
  rowSpacing: 4
};

// Même clé que l'ancienne appli : les réglages déjà saisis sont repris.
const LEGACY_STORAGE_KEY = 'samIrrigationPeriodV1';

function num(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }

// Comme le Bilan hydrique et les Indicateurs : réanalyse (ERA5) jusqu'à J−8,
// modèles de prévision pour les 7 derniers jours et les jours à venir. Les jours
// vides (null) renvoyés par l'une ou l'autre source sont ignorés.
function mergeWeatherRows(forecastDaily, archiveDaily, modelsFrom) {
  const map = new Map();
  const add = (daily, before) => (daily?.time || []).forEach((date, index) => {
    const etp = daily.et0_fao_evapotranspiration?.[index];
    const rain = daily.precipitation_sum?.[index];
    if (etp == null || rain == null || (before && date >= before)) return;
    map.set(date, { date, etp: num(etp), rain: num(rain) });
  });
  add(forecastDaily);
  add(archiveDaily, modelsFrom);
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}
function round(value, decimals = 2) { const f = 10 ** decimals; return Math.round((num(value) + Number.EPSILON) * f) / f; }
function fr(value, decimals = 2) { return round(value, decimals).toLocaleString('fr-FR', { maximumFractionDigits: decimals }); }
function sum(values) { return values.reduce((total, value) => total + num(value), 0); }
function formatLongDate(iso) { return new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
function formatShortDate(iso) { return new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }); }
function formatDuration(hours) {
  if (!Number.isFinite(hours) || hours <= 0) return '0 h 00';
  const totalMinutes = Math.round(hours * 60);
  return `${Math.floor(totalMinutes / 60)} h ${String(totalMinutes % 60).padStart(2, '0')}`;
}

export async function mount(root, ctx) {
  root.innerHTML = TEMPLATE;
  const q = selector => root.querySelector(selector);
  const val = id => q(`#${id}`).value;
  let weatherRows = [];
  let weatherMeta = null;

  ctx.filters({ location: true, period: true, hint: 'La période choisie est la période de programmation (jusqu’à 16 jours).', mountIn: q('#irrFilters') });
  ctx.period.configure({
    presets: [
      presets.nextDays(7),
      presets.nextDays(3),
      presets.nextDays(10),
      presets.nextDays(14),
      presets.lastDays(7, '7 derniers jours (a posteriori)')
    ],
    defaultPreset: 'next7',
    min: () => addDaysISO(todayISO(), -90),
    max: () => addDaysISO(todayISO(), 15),
    maxDays: 16,
    hint: 'Données disponibles : 3 derniers mois et 16 jours de prévisions.'
  });

  function settings() {
    try {
      const raw = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || '{}');
      return { ...DEFAULTS, ...raw };
    } catch {
      return { ...DEFAULTS };
    }
  }
  function persist(value) {
    try { localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(value)); } catch { /* stockage indisponible */ }
  }

  function programPeriod() {
    const p = ctx.period.get();
    const start = p?.start || todayISO();
    const end = p?.end || addDaysISO(start, 6);
    return { start, end, days: diffDaysISO(start, end) + 1 };
  }

  function rainEfficiencyCoefficient(s) {
    const stored = num(s.rainEfficiency, 80);
    return stored > 1 ? stored / 100 : stored;
  }
  // ---------------------------------------------------------------------------
  // Culture et Kc (FAO-56, 2025) : mêmes coefficients et même calendrier que le Bilan irrigation
  // ---------------------------------------------------------------------------
  // Curseur de 0 à 120 : 0–10 avant la saison, 10–110 la saison (début → fin), 110–120 après.
  const AVANT = 10;
  const APRES = 110;
  const cultureDe = s => parId(s.cultureId) || parId('pommier');
  const classeDe = (cult, id) => cult.classes.find(c => c.id === id) || classeParDefaut(cult);
  function classeParDefaut(cult) {
    return cult.classes.find(c => /moyenne/i.test(c.nom)) || cult.classes[cult.classes.length > 2 ? 1 : 0];
  }
  const longueurSaison = cult => dureesModele(cult).reduce((a, b) => a + b, 0);

  /** Position estimée d'après la date du jour et le calendrier moyen de l'espèce. */
  function positionEstimee(cult) {
    const today = todayISO();
    const m = stadesModele(cult, Number(today.slice(0, 4)));
    if (today < m.debut) return AVANT / 2;
    if (today > m.fin) return (APRES + 120) / 2;
    return AVANT + (100 * C.ecartJours(m.debut, today)) / longueurSaison(cult);
  }
  /** Position du jour : celle réglée au curseur, avancée du temps écoulé depuis (la culture progresse). */
  function positionDuJour(s) {
    const cult = cultureDe(s);
    if (s.stagePos === null || s.stagePos === undefined || s.stagePos === '') return { pos: positionEstimee(cult), estimee: true };
    const pos = num(s.stagePos);
    const ecoule = s.stageDate ? Math.max(0, diffDaysISO(s.stageDate, todayISO())) : 0;
    if (pos < AVANT || pos > APRES || !ecoule) return { pos, avancee: false };
    const avance = pos + (100 * ecoule) / longueurSaison(cult);
    return { pos: avance > APRES ? (APRES + 120) / 2 : avance, avancee: true, depuis: s.stageDate };
  }
  /** Dates des stades qui placent aujourd'hui à la position donnée (rythme moyen de l'espèce). */
  function stadesVirtuels(cult, pos) {
    const durees = dureesModele(cult);
    const L = durees.reduce((a, b) => a + b, 0);
    const debut = addDaysISO(todayISO(), -Math.round(((pos - AVANT) / 100) * L));
    return C.stadesDepuisDurees(debut, durees);
  }
  function zoneDe(cult, pos) {
    if (pos < AVANT) return 'avant';
    if (pos > APRES) return 'apres';
    return C.stadeDuJour(todayISO(), stadesVirtuels(cult, pos)).stade;
  }
  const valeursKc = cl => ({ ini: cl.kc.ini, mi: cl.kc.mid, fin: cl.kc.end });

  /** Kc d'un jour : FAO-56 (2025) selon l'espèce, la conduite et le stade ; 0 hors saison. */
  function kcForDate(iso, s) {
    if (s.kcOverride !== null && s.kcOverride !== '') return num(s.kcOverride);
    const cult = cultureDe(s);
    const { pos } = positionDuJour(s);
    if (pos < AVANT || pos > APRES) return 0;
    return C.coefDuJour(iso, stadesVirtuels(cult, pos), valeursKc(classeDe(cult, s.classeId)), 0);
  }

  const f2 = v => num(v).toFixed(2).replace('.', ',');
  function texteZone(cult, zone) {
    const annuel = estAnnuel(cult);
    const textes = annuel ? {
      avant: ['Avant le semis', 'Avant le semis ou la plantation : aucun apport n’est calculé.'],
      ini: [NOMS_STADE.ini, 'Du semis ou de la plantation jusqu’à environ 10 % du sol couvert par la culture.'],
      dev: [NOMS_STADE.dev, 'La culture couvre de plus en plus le sol.'],
      mi: [NOMS_STADE.mi, 'La culture couvre le sol au maximum, souvent vers la floraison.'],
      fin: [NOMS_STADE.fin, 'Les feuilles jaunissent, les fruits ou les grains mûrissent.'],
      apres: ['Récolte faite', 'Culture récoltée : aucun apport n’est calculé.']
    } : {
      avant: ['Repos hivernal', 'Les bourgeons ne sont pas encore ouverts : aucun apport n’est calculé.'],
      ini: [NOMS_STADE.ini, 'Du débourrement aux premières feuilles étalées.'],
      dev: [NOMS_STADE.dev, 'Les pousses s’allongent et le feuillage couvre de plus en plus le sol.'],
      mi: [NOMS_STADE.mi, 'Le feuillage a atteint son volume maximal : les pousses ne s’allongent presque plus.'],
      fin: [NOMS_STADE.fin, 'Les feuilles vieillissent ou jaunissent, souvent après la récolte.'],
      apres: ['Feuilles tombées', 'La plupart des feuilles sont tombées : aucun apport n’est calculé.']
    };
    return textes[zone] || textes.mi;
  }

  function remplirEspeces(s) {
    const cult = cultureDe(s);
    q('#cropSpecies').innerHTML = Object.entries(FAMILLES).map(([k, v]) => {
      const liste = CULTURES.filter(c => c.famille === k);
      return liste.length ? `<optgroup label="${escapeHtml(v)}">${liste.map(c => `<option value="${c.id}"${c.id === cult.id ? ' selected' : ''}>${escapeHtml(c.nom)}</option>`).join('')}</optgroup>` : '';
    }).join('');
    remplirClasses(cult, classeDe(cult, s.classeId).id);
  }
  function remplirClasses(cult, classeId) {
    q('#cropClass').innerHTML = cult.classes.map(c => `<option value="${c.id}"${c.id === classeId ? ' selected' : ''}>${escapeHtml(c.nom)}</option>`).join('');
    q('#cropClassLabel').hidden = cult.classes.length < 2;
  }
  /** Bande colorée des stades sous le curseur, aux proportions du calendrier moyen de l'espèce. */
  function dessinerBande(cult) {
    const durees = dureesModele(cult);
    const L = durees.reduce((a, b) => a + b, 0);
    const parts = [['avant', AVANT], ...['ini', 'dev', 'mi', 'fin'].map((k, i) => [k, (100 * durees[i]) / L]), ['apres', 120 - APRES]];
    q('#stageBand').innerHTML = parts.map(([k, w]) => `<span class="is-${k}" style="flex:${w.toFixed(2)} 1 0" title="${escapeHtml(texteZone(cult, k)[0])}">${escapeHtml(texteZone(cult, k)[0])}</span>`).join('');
  }

  /** Stade et Kc du jour affichés sous le curseur (pendant le glissement aussi). */
  function updateKcInfo() {
    const s = settings();
    const cult = parId(val('cropSpecies')) || cultureDe(s);
    const cl = classeDe(cult, val('cropClass'));
    const etat = positionDuJour(s);
    // Position exacte enregistrée tant que le curseur n'a pas été déplacé (même Kc que le calcul)
    const touche = q('#stagePos').dataset.touche === '1' || cult.id !== cultureDe(s).id;
    const pos = touche ? num(q('#stagePos').value) : etat.pos;
    const zone = zoneDe(cult, pos);
    const [nom, aide] = texteZone(cult, zone);
    q('#stageName').textContent = nom;
    const suivi = touche ? ''
      : etat.estimee ? ' Position estimée d’après la date et le calendrier moyen de l’espèce : déplacez le curseur si besoin.'
      : etat.avancee ? ` Position avancée automatiquement depuis le ${formatShortDate(etat.depuis)} : la culture a progressé.` : '';
    q('#stageHelp').textContent = aide + suivi;
    const kcPerso = val('kcValue');
    const horsSaison = zone === 'avant' || zone === 'apres';
    const kcJour = horsSaison ? 0 : C.coefDuJour(todayISO(), stadesVirtuels(cult, pos), valeursKc(cl), 0);
    q('#kcInfo').innerHTML = kcPerso !== ''
      ? `Kc personnalisé appliqué à toute la période : <strong>${f2(kcPerso)}</strong> (onglet Calcul). Le Kc de la culture serait aujourd’hui de ${f2(kcJour)}.`
      : horsSaison ? 'Hors saison : <strong>aucun apport n’est calculé</strong>.'
        : `Kc aujourd’hui : <strong>${f2(kcJour)}</strong> · ${escapeHtml(nom.toLowerCase())}`;
    q('#kcOverrideInfo').textContent = kcPerso !== ''
      ? `Ce Kc remplace celui de la culture (${f2(kcJour)} aujourd’hui) sur toute la période. Videz le champ pour revenir au calcul automatique.`
      : '';
    const k = cl.kc;
    q('#kcExplain').innerHTML = `<p>Valeurs de la FAO (FAO-56, révision 2025) pour <strong>${escapeHtml(cult.nom)}</strong>${cult.classes.length > 1 ? ` — ${escapeHtml(cl.nom)}` : ''} : <strong>${f2(k.ini)}</strong> au démarrage, <strong>${f2(k.mid)}</strong> en pleine végétation, <strong>${f2(k.end)}</strong> en fin de saison. Entre deux stades, le Kc change progressivement, comme dans le Bilan irrigation.</p>`
      + '<p>Le curseur indique où en est la culture aujourd’hui. Pour chaque jour de la période, l’outil fait avancer la culture au rythme moyen de l’espèce. Hors saison, aucun apport n’est calculé.</p>'
      + `<p>Le Kc ne dépend pas du système d’irrigation et n’est pas ajusté au vent ni à l’humidité du lieu.${cult.type === 'ligneux' ? ' Il a été établi surtout sur des parcelles sans enherbement : l’herbe de l’inter-rang n’est pas comptée.' : ''}</p>`;
  }

  function rainRecommendationForSystem(systemType) {
    if (systemType === 'micro') return { percent: 60, label: 'micro-aspersion' };
    if (systemType === 'sprinkler') return { percent: 90, label: 'aspersion' };
    return { percent: 25, label: 'goutte-à-goutte' };
  }
  function updateRainRecommendation(applyValue = false) {
    const recommendation = rainRecommendationForSystem(val('systemType') || 'drip');
    if (applyValue) q('#rainEfficiency').value = recommendation.percent;
    q('#rainRecommendationInfo').innerHTML = `<strong>Valeur indicative pour ${recommendation.label} : ${recommendation.percent} %.</strong>`;
  }

  function toggleRateFields() {
    const calculated = val('rateMode') === 'calculated';
    q('#knownRateLabel').hidden = calculated;
    q('#emitterFlowLabel').hidden = !calculated;
    q('#emitterSpacingLabel').hidden = !calculated;
    q('#rowSpacingLabel').hidden = !calculated;
  }

  function defaultLastIrrigation() {
    return addDaysISO(programPeriod().start, -1);
  }

  function loadForm() {
    const s = settings();
    ['surfaceHa', 'frequency', 'systemType', 'rateMode', 'knownRate', 'emitterFlow', 'emitterSpacing', 'rowSpacing']
      .forEach(id => { q(`#${id}`).value = s[id]; });
    q('#lastIrrigation').value = s.lastIrrigation || defaultLastIrrigation();
    const rainPercent = num(s.rainEfficiency, 80) <= 1 ? num(s.rainEfficiency, 0.8) * 100 : num(s.rainEfficiency, 80);
    if (s.rainAutoSystem === null) {
      const recommendation = rainRecommendationForSystem(s.systemType);
      s.rainEfficiency = recommendation.percent;
      s.rainAutoSystem = s.systemType;
      persist(s);
      q('#rainEfficiency').value = recommendation.percent;
    } else {
      q('#rainEfficiency').value = round(rainPercent, 0);
    }
    q('#kcValue').value = s.kcOverride === null ? '' : s.kcOverride;
    remplirEspeces(s);
    dessinerBande(cultureDe(s));
    q('#stagePos').value = String(Math.round(positionDuJour(s).pos));
    updateKcInfo();
    updateRainRecommendation(false);
    toggleRateFields();
  }

  function saveForm() {
    const s = settings();
    s.surfaceHa = num(val('surfaceHa'), 1);
    s.lastIrrigation = val('lastIrrigation') || null;
    s.frequency = val('frequency');
    s.rainEfficiency = num(val('rainEfficiency'), 80);
    s.kcOverride = val('kcValue') === '' ? null : num(val('kcValue'));
    s.systemType = val('systemType');
    s.cultureId = val('cropSpecies') || s.cultureId;
    s.classeId = val('cropClass') || s.classeId;
    s.rainAutoSystem = s.systemType;
    s.rateMode = val('rateMode');
    s.knownRate = num(val('knownRate'), 3);
    s.emitterFlow = num(val('emitterFlow'), 1.6);
    s.emitterSpacing = num(val('emitterSpacing'), 0.5);
    s.rowSpacing = num(val('rowSpacing'), 4);
    persist(s);
    return s;
  }

  function updatePeriodPreview() {
    const { start, end, days } = programPeriod();
    const place = ctx.location.get();
    const past = end < todayISO();
    q('#periodPreview').innerHTML = `<strong>Période calculée :</strong> du ${formatLongDate(start)} au ${formatLongDate(end)} inclus (${days} jour${days > 1 ? 's' : ''}) · <strong>Lieu :</strong> ${place?.name || '—'}`
      + (past ? '<br><span class="muted">Cette période est entièrement passée : le calcul sert de bilan a posteriori. Choisissez « 7 prochains jours » pour programmer les prochains apports.</span>' : '');
  }

  function showError(message) { q('#errorMessage').hidden = false; q('#errorMessage').textContent = message; }
  function hideError() { q('#errorMessage').hidden = true; }
  function setLoading(loading) {
    q('#calculateButton').disabled = loading;
    root.querySelector('.tool-main')?.setAttribute('aria-busy', String(loading));
  }

  function updateDateLimits() {
    if (!weatherRows.length) return;
    const input = q('#lastIrrigation');
    input.min = weatherRows[0].date;
    input.max = addDaysISO(programPeriod().start, -1);
  }

  async function refreshWeather() {
    const place = ctx.location.get();
    if (!place) return;
    setLoading(true);
    hideError();
    const cacheKey = `irrigation.weather.${place.latitude.toFixed(4)}_${place.longitude.toFixed(4)}`;
    try {
      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.search = new URLSearchParams({
        latitude: place.latitude.toFixed(4),
        longitude: place.longitude.toFixed(4),
        daily: 'et0_fao_evapotranspiration,precipitation_sum',
        timezone: 'Europe/Paris',
        past_days: '92',
        forecast_days: '16'
      }).toString();
      const modelsFrom = addDaysISO(todayISO(), -7);
      const archiveUrl = new URL('https://archive-api.open-meteo.com/v1/archive');
      archiveUrl.search = new URLSearchParams({
        latitude: place.latitude.toFixed(4),
        longitude: place.longitude.toFixed(4),
        daily: 'et0_fao_evapotranspiration,precipitation_sum',
        timezone: 'Europe/Paris',
        start_date: addDaysISO(todayISO(), -92),
        end_date: addDaysISO(modelsFrom, -1)
      }).toString();
      const archivePromise = fetch(archiveUrl, { cache: 'no-store' })
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null); // réanalyse indisponible : les modèles suffisent pour les jours récents
      let response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        response = await fetch(url, { cache: 'no-store' });
      }
      if (!response.ok) throw new Error(`Open-Meteo répond ${response.status}.`);
      const data = await response.json();
      const archive = await archivePromise;
      if (ctx.scope.disposed) return;
      weatherRows = mergeWeatherRows(data.daily, archive?.daily, modelsFrom);
      weatherMeta = { place: place.name, savedAt: null };
      storage.set(cacheKey, { savedAt: new Date().toISOString(), rows: weatherRows });
      updateDateLimits();
      render();
    } catch (error) {
      const cached = storage.get(cacheKey, null);
      if (cached?.rows?.length) {
        weatherRows = cached.rows;
        weatherMeta = { place: place.name, savedAt: cached.savedAt };
        updateDateLimits();
        render();
        showError('Données hors connexion : dernière météo enregistrée utilisée.');
      } else {
        showError(`Impossible de récupérer la météo. ${error.message}`);
      }
    } finally {
      if (!ctx.scope.disposed) setLoading(false);
    }
  }

  function systemRate(s) {
    if (s.rateMode === 'calculated') {
      const denominator = num(s.emitterSpacing) * num(s.rowSpacing);
      return denominator > 0 ? num(s.emitterFlow) / denominator : 0;
    }
    return num(s.knownRate);
  }
  function numberOfApplications(frequency, days) {
    switch (frequency) {
      case 'every2': return Math.ceil(days / 2);
      case 'twiceWeekly': return Math.max(1, Math.ceil(days * 2 / 7));
      case 'weekly': return Math.max(1, Math.ceil(days / 7));
      default: return days;
    }
  }
  function rowsBetween(start, end) { return weatherRows.filter(row => row.date >= start && row.date <= end); }

  function render() {
    updatePeriodPreview();
    if (!weatherRows.length) return;
    const s = settings();
    const { start, end, days } = programPeriod();
    const dayBeforeStart = addDaysISO(start, -1);
    let lastIrrigation = val('lastIrrigation') || s.lastIrrigation || dayBeforeStart;
    q('#lastIrrigation').max = dayBeforeStart;

    if (lastIrrigation > dayBeforeStart) {
      showError('Le dernier arrosage doit être antérieur à la date de début de programmation.');
      return;
    }
    const availableStart = weatherRows[0].date;
    const availableEnd = weatherRows[weatherRows.length - 1].date;
    if (lastIrrigation < availableStart || end > availableEnd) {
      showError(`La période choisie dépasse les données disponibles (${formatLongDate(availableStart)} au ${formatLongDate(availableEnd)}).`);
      return;
    }
    hideError();

    const deficitRows = rowsBetween(addDaysISO(lastIrrigation, 1), dayBeforeStart);
    const periodRows = rowsBetween(start, end);
    if (periodRows.length !== days) {
      showError('Toutes les journées de la période choisie ne sont pas disponibles.');
      return;
    }
    const pastEtc = sum(deficitRows.map(row => row.etp * kcForDate(row.date, s)));
    const pastEffectiveRain = sum(deficitRows.map(row => row.rain)) * rainEfficiencyCoefficient(s);
    const pastDeficit = Math.max(0, pastEtc - pastEffectiveRain);
    const periodGross = sum(periodRows.map(row => row.etp * kcForDate(row.date, s)));
    const periodRain = sum(periodRows.map(row => row.rain));
    const periodEffectiveRain = periodRain * rainEfficiencyCoefficient(s);
    const periodNet = Math.max(0, periodGross - periodEffectiveRain);
    const totalNeed = pastDeficit + periodNet;
    const count = numberOfApplications(s.frequency, days);
    const dose = totalNeed / count;
    const volume = dose * num(s.surfaceHa) * 10;
    const rate = systemRate(s);
    const duration = rate > 0 ? dose / rate : 0;

    q('#resultPeriod').textContent = `Du ${formatLongDate(start)} au ${formatLongDate(end)} inclus · ${ctx.location.get()?.name || ''}`;
    q('#totalNeed').textContent = `${fr(totalNeed, 1)} mm`;
    q('#applicationCount').textContent = String(count);
    q('#dosePerApplication').textContent = `${fr(dose, 1)} mm`;
    q('#volumePerApplication').textContent = `${fr(volume, 1)} m³`;
    q('#durationPerApplication').textContent = formatDuration(duration);
    q('#pastDeficit').textContent = `${fr(pastDeficit, 1)} mm`;
    q('#periodGrossNeed').textContent = `${fr(periodGross, 1)} mm`;
    q('#periodRain').textContent = `${fr(periodRain, 1)} mm`;
    q('#periodEffectiveRain').textContent = `${fr(periodEffectiveRain, 1)} mm`;
    q('#periodNetNeed').textContent = `${fr(periodNet, 1)} mm`;
    const kcs = periodRows.map(row => kcForDate(row.date, s));
    const kcMin = Math.min(...kcs);
    const kcMaxi = Math.max(...kcs);
    q('#periodKc').textContent = kcMaxi === 0 ? '0 (hors saison)'
      : Math.abs(kcMaxi - kcMin) < 0.005 ? f2(kcMin) : `${f2(kcMin)} à ${f2(kcMaxi)}`;
    q('#updatedAt').textContent = weatherMeta?.savedAt
      ? `Données enregistrées le ${new Date(weatherMeta.savedAt).toLocaleString('fr-FR')}`
      : `Météo actualisée à ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
    renderChart();
  }

  const ET0_COLOR = '#f0892c';
  const ET0_COLOR_LIGHT = 'rgba(240,137,44,.42)';
  const RAIN_COLOR = '#3b8ad9';
  const RAIN_COLOR_LIGHT = 'rgba(59,138,217,.42)';
  let weatherChart = null;

  // Trait pointillé rouge entre aujourd'hui et le premier jour de prévision.
  const forecastLinePlugin = {
    id: 'irrForecastLine',
    afterDatasetsDraw(chart, _args, options) {
      const index = options?.index;
      if (!Number.isInteger(index) || index <= 0) return;
      const { ctx: c, chartArea, scales } = chart;
      const x = (scales.x.getPixelForValue(index - 1) + scales.x.getPixelForValue(index)) / 2;
      if (x < chartArea.left - 1 || x > chartArea.right + 1) return; // hors de la partie zoomée
      c.save();
      c.strokeStyle = '#D30D43';
      c.lineWidth = 1.5;
      c.setLineDash([5, 4]);
      c.beginPath();
      c.moveTo(x, chartArea.top);
      c.lineTo(x, chartArea.bottom);
      c.stroke();
      c.restore();
    }
  };

  function renderChart() {
    const canvas = q('#weatherChart');
    const Chart = window.Chart;
    if (!canvas || !Chart || !weatherRows.length) return;
    const { start, end } = programPeriod();
    const rows = weatherRows.filter(row => row.date >= addDaysISO(start, -7) && row.date <= end);
    if (weatherChart) { weatherChart.destroy(); weatherChart = null; }
    if (!rows.length) return;
    const today = todayISO();
    const forecastIndex = rows.findIndex(row => row.date > today);
    const dayName = iso => new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    weatherChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: rows.map(row => formatShortDate(row.date)),
        datasets: [
          { label: 'ET₀', data: rows.map(row => round(row.etp, 1)), backgroundColor: rows.map(row => (row.date < start ? ET0_COLOR_LIGHT : ET0_COLOR)), borderRadius: 3, maxBarThickness: 18, categoryPercentage: 0.7, barPercentage: 0.9 },
          { label: 'Pluie', data: rows.map(row => round(row.rain, 1)), backgroundColor: rows.map(row => (row.date < start ? RAIN_COLOR_LIGHT : RAIN_COLOR)), borderRadius: 3, maxBarThickness: 18, categoryPercentage: 0.7, barPercentage: 0.9 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          irrForecastLine: { index: forecastIndex },
          tooltip: {
            padding: 10,
            cornerRadius: 8,
            callbacks: {
              title: items => {
                const row = rows[items[0].dataIndex];
                const tag = row.date > today ? ' · prévision' : row.date < start ? ' · avant la période' : '';
                return `${dayName(row.date)}${tag}`;
              },
              label: item => ` ${item.dataset.label} : ${fr(item.parsed.y, 1)} mm`
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, color: item => (rows[item.tick?.value ?? item.index]?.date > today ? '#D30D43' : '#57494d') } },
          y: { beginAtZero: true, grid: { color: '#efe7e9' }, border: { display: false }, title: { display: true, text: 'mm / jour', color: '#75686c' }, ticks: { color: '#75686c' } }
        }
      },
      plugins: [forecastLinePlugin]
    });
    enableChartZoom(weatherChart); // glisser = zoom, double-clic = retour
  }

  // Événements
  q('#calculateButton').addEventListener('click', () => { saveForm(); render(); });
  q('#rateMode').addEventListener('change', toggleRateFields);
  q('#systemType').addEventListener('change', () => updateRainRecommendation(true));
  q('#kcValue').addEventListener('input', updateKcInfo);

  // Onglets Culture / Irrigation / Calcul
  const onglets = [...root.querySelectorAll('.irr-tabs [role="tab"]')];
  function ouvrirOnglet(nom, focus = false) {
    onglets.forEach(b => {
      const actif = b.dataset.tab === nom;
      b.setAttribute('aria-selected', String(actif));
      b.tabIndex = actif ? 0 : -1;
      q(`#irrPanel-${b.dataset.tab}`).hidden = !actif;
      if (actif && focus) b.focus();
    });
  }
  onglets.forEach((b, i) => {
    b.addEventListener('click', () => ouvrirOnglet(b.dataset.tab));
    b.addEventListener('keydown', e => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (d) { e.preventDefault(); ouvrirOnglet(onglets[(i + d + onglets.length) % onglets.length].dataset.tab, true); }
    });
  });

  // Culture : espèce, conduite, stade
  q('#cropSpecies').addEventListener('change', () => {
    const cult = parId(val('cropSpecies'));
    if (!cult) return;
    remplirClasses(cult, classeParDefaut(cult).id);
    dessinerBande(cult);
    const s = saveForm();
    s.stagePos = null; // nouvelle espèce : position estimée d'après la date
    s.stageDate = null;
    persist(s);
    delete q('#stagePos').dataset.touche;
    q('#stagePos').value = String(Math.round(positionEstimee(cult)));
    updateKcInfo();
    render();
  });
  q('#cropClass').addEventListener('change', () => { saveForm(); updateKcInfo(); render(); });
  q('#stagePos').addEventListener('input', () => { q('#stagePos').dataset.touche = '1'; updateKcInfo(); });
  q('#stagePos').addEventListener('change', () => {
    const s = saveForm();
    s.stagePos = num(val('stagePos'));
    s.stageDate = todayISO();
    persist(s);
    updateKcInfo();
    render();
  });
  q('#kcValue').addEventListener('change', () => { saveForm(); updateKcInfo(); render(); });
  q('#lastIrrigation').addEventListener('change', () => { saveForm(); render(); });
  ctx.location.onChange(() => refreshWeather());
  ctx.period.onChange(() => {
    const s = settings();
    const last = val('lastIrrigation');
    if (!last || last >= programPeriod().start) {
      q('#lastIrrigation').value = defaultLastIrrigation();
      s.lastIrrigation = q('#lastIrrigation').value;
      persist(s);
    }
    updateDateLimits();
    render();
  });

  loadForm();
  if (q('#lastIrrigation').value >= programPeriod().start) q('#lastIrrigation').value = defaultLastIrrigation();
  updatePeriodPreview();
  await refreshWeather();

  return {
    unmount() {
      if (weatherChart) weatherChart.destroy();
    }
  };
}
