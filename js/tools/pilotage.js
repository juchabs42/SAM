// SAM Pilotage irrigation — conseil d'irrigation multi-cultures fondé sur FAO-56 Rev.1 (2025).
//
// Bilan hydrique journalier (Kcb + Ke, chap. 7 ; zone racinaire, chap. 8), ET₀ FAO
// Penman-Monteith recalculée (Éq. 2.4), planification des irrigations sur J à J+7.
// Outil en aperçu : visible des seuls administrateurs SAM tant qu'il n'est pas validé.

import { storage, escapeHtml, todayISO, addDaysISO, formatNumber } from '../core/util.js';
import { enableChartZoom } from '../core/charts.js';
import { searchPlaces, locateMe } from '../core/places.js';
import { CULTURES, FAMILLES, parId, source, REFERENCE } from '../fao56/data/cultures-2025.js';
import { SOLS, SOLS_VOISINS, solParId, SYSTEMES, systemeParId, PAILLAGE_KC, PAILLAGE_ES, DEFAUTS_TERRAIN } from '../fao56/data/references.js';
import * as C from '../fao56/coefficients.js';
import { simuler, synthese, climatParStade } from '../fao56/bilan.js';
import * as IR from '../fao56/irrigation.js';
import { jourAnnee } from '../fao56/meteo.js';
import { chargerMeteo } from '../fao56/meteo-source.js';
import { creerStockage } from '../fao56/stockage.js';

// ---------------------------------------------------------------------------
// Utilitaires d'affichage
// ---------------------------------------------------------------------------
const finite = v => typeof v === 'number' && Number.isFinite(v);
const f0 = v => formatNumber(v, 0);
const f1 = v => formatNumber(v, 1);
const f2 = v => formatNumber(v, 2);
const pct = v => (finite(v) ? `${formatNumber(v * 100, 0)} %` : '—');
const esc = escapeHtml;
const num = v => {
  const n = parseFloat(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const dateFr = iso => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—');
const jourMois = iso => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');
const dateLongue = iso => new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const dateCourte = iso => new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const ecartJours = (a, b) => C.ecartJours(a, b);

/** Valeur représentative d'une plage FAO {min,max} / {max, op:'<'} / {min, op:'>'}. */
function milieu(r) {
  if (r == null) return null;
  if (typeof r === 'number') return r;
  if (finite(r.min) && finite(r.max)) return (r.min + r.max) / 2;
  if (finite(r.max)) return r.op === '<' ? 0.85 * r.max : r.max;
  if (finite(r.min)) return r.op === '>' ? 1.1 * r.min : r.min;
  return null;
}
function plage(r, d = 2) {
  if (r == null) return '—';
  if (typeof r === 'number') return formatNumber(r, d);
  if (r.text) return esc(r.text);
  if (finite(r.min) && finite(r.max)) return r.min === r.max ? formatNumber(r.min, d) : `${formatNumber(r.min, d)} – ${formatNumber(r.max, d)}`;
  if (finite(r.max)) return `${r.op || '≤'} ${formatNumber(r.max, d)}`;
  if (finite(r.min)) return `${r.op || '≥'} ${formatNumber(r.min, d)}`;
  return '—';
}
const src = s => (s ? `<span class="pil-src" title="${esc(source(s))}">${esc(source(s).replace('FAO-56 Rev.1 (2025), ', ''))}</span>` : '');

// ---------------------------------------------------------------------------
// Valeurs par défaut (hors FAO-56 : affichées comme indicatives)
// ---------------------------------------------------------------------------
const STADES_MODELES = {
  precoce: ['03-10', '04-05', '06-01', '08-31', '10-31'],
  pepins: ['03-25', '04-20', '06-15', '09-15', '11-15'],
  tardif: ['04-01', '05-01', '06-30', '09-15', '10-31'],
  vigne: ['04-01', '05-01', '06-15', '08-31', '10-31'],
  persistant: ['03-01', '03-31', '05-31', '09-30', '11-30'],
  prairie: ['03-15', '04-15', '05-31', '09-30', '10-31']
};
const GROUPE_STADES = {
  pecher: 'precoce', abricotier: 'precoce', prunier: 'precoce', cerisier: 'precoce', amandier: 'precoce',
  pommier: 'pepins', poirier: 'pepins',
  olivier: 'persistant', clementinier: 'persistant', citronnier: 'persistant', oranger: 'persistant', avocatier: 'persistant', neflier: 'persistant',
  'vigne-cuve': 'vigne', 'vigne-table': 'vigne'
};
const DUREES_ANNUELLES = [25, 35, 40, 20];
const LIBELLES_STADES = {
  annuel: ['Semis / plantation', 'Fin du stade initial (≈ 10 % de couverture)', 'Couverture maximale (fin du développement)', 'Début de la maturation / sénescence', 'Récolte (fin de saison)'],
  perenne: ['Débourrement / reprise de végétation', 'Fin du stade initial', 'Frondaison complète (fin du développement)', 'Début de la sénescence (fin de mi-saison)', 'Chute des feuilles / fin de saison']
};
const SALINITE = { S: 'sensible', MS: 'modérément sensible', MT: 'modérément tolérante', T: 'tolérante' };
const NOMS_STADE = { hors: 'Hors saison', ini: 'Initial', dev: 'Développement', mi: 'Mi-saison', fin: 'Fin de saison' };
const STRATEGIES = {
  fao: 'FAO-56 : seuil = RFU (p × RU)',
  confort: 'Confort : seuil = ½ RFU',
  perso: 'Seuil personnalisé (% RU)'
};

const estAnnuel = cult => cult?.type === 'annuel';
const classeDe = (cult, id) => cult?.classes.find(c => c.id === id) || cult?.classes[0] || null;
const anneeDe = iso => Number(String(iso).slice(0, 4));

function stadesModele(cult, annee) {
  if (estAnnuel(cult)) {
    const debut = `${annee}-04-15`;
    return C.stadesDepuisDurees(debut, DUREES_ANNUELLES);
  }
  const g = cult.type === 'perenne' ? 'prairie' : (GROUPE_STADES[cult.id] || 'tardif');
  const [a, b, c, d, e] = STADES_MODELES[g];
  return { debut: `${annee}-${a}`, finIni: `${annee}-${b}`, finDev: `${annee}-${c}`, finMi: `${annee}-${d}`, fin: `${annee}-${e}` };
}

/** Configuration par défaut d'une parcelle pour une culture et une classe. */
function configDefaut(cult, cl, annee) {
  const annuel = estAnnuel(cult);
  const sys = systemeParId(annuel ? 'aspersion' : 'goutte-a-goutte');
  const sol = solParId('loam');
  const stades = stadesModele(cult, annee);
  return {
    version: 1,
    reference: 'FAO-56 Rev.1 (2025)',
    methode: 'double',
    culture: defautsCulture(cult, cl),
    stades,
    sol: { texture: sol.id, thetaFC: sol.thetaFC, thetaWP: sol.thetaWP, rew: sol.rewDefaut, ze: 0.1, cailloux: 0, ruParM: null },
    irrigation: { systeme: sys.id, fw: sys.fwDefaut, efficience: sys.efficience, pluvio: null, localise: null, dureeMaxPoste: null, doseMaxNette: null, fractionHumectee: 1 },
    strategie: { mode: sys.frequent ? 'confort' : 'fao', mad: null, cible: 1, pluiePrevue: DEFAUTS_TERRAIN.pluiePrevue.valeur },
    paillage: { type: 'aucun', couverture: 0 },
    debutBilan: annuel ? addDaysISO(stades.debut, -30) : '01-01',
    etatInitial: 1
  };
}

function defautsCulture(cult, cl) {
  const annuel = estAnnuel(cult);
  const h = milieu(cl?.h) ?? (annuel ? 0.5 : 2.5);
  const zr = milieu(cl?.zr) ?? (annuel ? 0.6 : DEFAUTS_TERRAIN.zrLigneux.valeur);
  const apMid = Array.isArray(cl?.ap) ? cl.ap.find(a => /mid/i.test(a.stade)) || cl.ap[1] || cl.ap[0] : null;
  return {
    p: finite(cult?.p?.p) ? cult.p.p : 0.5,
    h: +h.toFixed(2),
    zr: +zr.toFixed(2),
    zrMin: annuel ? DEFAUTS_TERRAIN.zrMinAnnuel.valeur : null,
    kcbHorsSaison: annuel ? C.KC_MIN : +(cl?.kcb?.ini ?? C.KC_MIN).toFixed(2),
    ajusterClimat: true,
    kcbPerso: null,
    kcPerso: null,
    ap: {
      actif: false,
      fc: +(milieu(apMid?.fc) ?? milieu(cl?.fc) ?? 0.5).toFixed(2),
      forme: annuel ? 'rangs' : (/trellis|hedge|palissé|haie/i.test(`${cl?.nom_en} ${cl?.nom}`) ? 'rangs' : 'arbres'),
      hauteurCanopee: +(h * 0.7).toFixed(2),
      largeur: 1.5,
      angleRang: 90,
      ml: apMid?.ML ?? 1.5,
      fr: apMid?.Fr ?? 1,
      kcbCouvert: null
    }
  };
}

/** Décale les dates de stades (année de référence) sur l'année demandée (cultures pérennes). */
function stadesPourAnnee(stades, annee, annuel) {
  if (annuel) return stades;
  const ref = anneeDe(stades.debut);
  const decale = iso => {
    let y = anneeDe(iso) + (annee - ref);
    let md = iso.slice(5);
    if (md === '02-29' && !((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)) md = '02-28';
    return `${y}-${md}`;
  };
  return { debut: decale(stades.debut), finIni: decale(stades.finIni), finDev: decale(stades.finDev), finMi: decale(stades.finMi), fin: decale(stades.fin) };
}

function periodeBilan(p, annee, today) {
  const cult = parId(p.culture_id);
  const cfg = p.config;
  if (estAnnuel(cult)) {
    const debut = /^\d{4}-/.test(cfg.debutBilan || '') ? cfg.debutBilan : addDaysISO(cfg.stades.debut, -30);
    const finSaison = addDaysISO(cfg.stades.fin, 30);
    const fin = finSaison < addDaysISO(today, 7) ? finSaison : addDaysISO(today, 7);
    return { debut, fin, enCours: fin >= today };
  }
  const md = /^\d{2}-\d{2}$/.test(cfg.debutBilan || '') ? cfg.debutBilan : '01-01';
  // Début après le débourrement (ex. 1er octobre) : le bilan part de l'automne précédent.
  const debut = `${md > cfg.stades.debut.slice(5) ? annee - 1 : annee}-${md}`;
  const courante = annee === anneeDe(today);
  return { debut, fin: courante ? addDaysISO(today, 7) : `${annee}-12-31`, enCours: courante };
}

/**
 * Dose nette maximale d'une irrigation : valeur saisie, sinon, pour l'irrigation localisée,
 * capacité du poste (pluviométrie × durée maximale, 12 h par défaut × efficience) pour obtenir
 * un programme d'apports fréquents plutôt qu'un seul apport massif.
 */
function doseMax(irr, sys) {
  if (finite(irr.doseMaxNette) && irr.doseMaxNette > 0) return irr.doseMaxNette;
  if (sys?.frequent && finite(irr.pluvio) && irr.pluvio > 0) return irr.pluvio * (irr.dureeMaxPoste || 12) * (irr.efficience || 0.9);
  return null;
}

/** Paramètres du moteur pour une parcelle, une campagne et la série météo chargée. */
function versMoteur(p, annee, meteo) {
  const cult = parId(p.culture_id);
  const cl = classeDe(cult, p.classe_id);
  const cfg = p.config;
  const annuel = estAnnuel(cult);
  const stades = stadesPourAnnee(cfg.stades, annee, annuel);
  const climat = climatParStade(meteo, stades);
  const cu = cfg.culture;
  const base = cu.kcbPerso || { ini: cl.kcb.ini, mi: cl.kcb.mid, fin: cl.kcb.end };
  let ajuster = cu.ajusterClimat !== false;
  let kcb = base;
  let ap = null;
  if (cu.ap?.actif) {
    ap = calculAP(cult, cu, stades, climat, p.latitude);
    kcb = { ini: base.ini, mi: ap.kcb, fin: ajuster ? C.ajusterFin(base.fin, climat.fin.u2, climat.fin.hrmin, cu.h) : base.fin };
    ajuster = false;
  }
  const kc = cu.kcPerso || (cl.kc ? { ini: cl.kc.ini, mi: cl.kc.mid, fin: cl.kc.end } : null);
  const irr = cfg.irrigation;
  const sys = systemeParId(irr.systeme);
  const strat = cfg.strategie || {};
  const mad = strat.mode === 'confort' ? 0.5 * cu.p : strat.mode === 'perso' && finite(strat.mad) ? strat.mad : null;
  return {
    cult, cl, stades, climat, ap,
    moteur: {
      annuel, stades, kcb, kc,
      kcbHorsSaison: cu.kcbHorsSaison ?? C.KC_MIN,
      kcHorsSaison: kc ? (annuel ? 0.3 : kc.ini) : null,
      h: cu.h, zr: cu.zr, zrMin: cu.zrMin ?? 0.2, p: cu.p,
      sol: { thetaFC: cfg.sol.thetaFC, thetaWP: cfg.sol.thetaWP, rew: cfg.sol.rew, ze: cfg.sol.ze ?? 0.1, cailloux: (cfg.sol.cailloux || 0) / 100, ruParM: cfg.sol.ruParM },
      fw: irr.fw, goutte: !!sys?.goutte, efficience: irr.efficience,
      paillage: cfg.paillage?.type && cfg.paillage.type !== 'aucun' ? { type: cfg.paillage.type, couverture: (cfg.paillage.couverture || 0) / 100 } : null,
      fractionHumectee: irr.fractionHumectee ?? 1,
      etatInitial: { drFraction: 1 - (finite(cfg.etatInitial) ? cfg.etatInitial : 1) }
    },
    options: {
      methode: cfg.methode === 'simple' && kc ? 'simple' : 'double',
      ajusterClimat: ajuster,
      mad,
      cible: strat.cible ?? 1,
      pluiePrevue: strat.pluiePrevue ?? 0.5,
      doseMaxNette: doseMax(irr, sys)
    }
  };
}

function calculAP(cult, cu, stades, climat, latitude) {
  const a = cu.ap;
  const milieuMi = C.ajouterJours(stades.finDev, Math.round(C.ecartJours(stades.finDev, stades.finMi) / 2));
  const J = jourAnnee(milieuMi);
  const fcEff = a.forme === 'rangs'
    ? C.fcEffRangs(a.fc, { hauteurCanopee: a.hauteurCanopee, largeur: a.largeur, angleRangDeg: a.angleRang, latitude, J })
    : C.fcEffArbres(a.fc, latitude, J);
  const kd = C.kdDensite({ fcEff, ml: a.ml ?? 1.5, h: cu.h });
  const kh = !estAnnuel(cult) || cu.h > 1.5 ? 0.1 : 0.2;
  const kcbFull = C.kcbPlein({ fr: a.fr ?? 1, h: cu.h, u2: climat.mi.u2, hrMin: climat.mi.hrmin, kh });
  const kcb = C.kcbAP({ kd, kcbFull, kcbCouvert: finite(a.kcbCouvert) ? a.kcbCouvert : null });
  return { fcEff, kd, kcbFull, kcb, kh, J, date: milieuMi };
}

/** Complète une configuration enregistrée avec les clés ajoutées depuis (compatibilité). */
function normaliser(p) {
  const cult = parId(p.culture_id);
  if (!cult) return p;
  const cl = classeDe(cult, p.classe_id);
  const def = configDefaut(cult, cl, anneeDe(p.config?.stades?.debut || todayISO()));
  const cfg = p.config && typeof p.config === 'object' ? p.config : {};
  for (const [k, v] of Object.entries(def)) {
    if (cfg[k] === undefined || cfg[k] === null) cfg[k] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v) && typeof cfg[k] === 'object') {
      for (const [k2, v2] of Object.entries(v)) if (cfg[k][k2] === undefined) cfg[k][k2] = v2;
    }
  }
  if (!cfg.culture.ap || typeof cfg.culture.ap !== 'object') cfg.culture.ap = def.culture.ap;
  p.config = cfg;
  return p;
}

function debutBilanAffiche(cfg) {
  const md = /^\d{2}-\d{2}$/.test(cfg.debutBilan || '') ? cfg.debutBilan : '01-01';
  const a = anneeDe(todayISO());
  return `${md > cfg.stades.debut.slice(5) ? a - 1 : a}-${md}`;
}

// ---------------------------------------------------------------------------
// Montage
// ---------------------------------------------------------------------------
export async function mount(root, ctx) {
  ctx.filters({ location: false, period: false });
  if (!ctx.isAdmin) {
    root.innerHTML = `<div class="pil"><div class="pil-card pil-vide"><h2>Pilotage irrigation</h2>
      <p>Cet outil est en préparation et réservé pour l’instant à l’équipe SAM.</p></div></div>`;
    return {};
  }
  const today = todayISO();
  const store = creerStockage(ctx.supabase || null, storage);
  const S = {
    parcelles: [], id: storage.get('pilotage.courante', null), onglet: storage.get('pilotage.onglet', 'conseil'),
    annee: anneeDe(today), calc: null, irrigations: [], pluies: [], charge: false, erreur: null, token: 0,
    chart: null, toutVoir: false, brouillon: null, anciennes: null
  };

  root.innerHTML = `<div class="pil">
    <div class="pil-bar">
      <label class="pil-parcelle"><span>Parcelle</span><select id="pil-parcelle" class="sam-input"></select></label>
      <button type="button" class="sam-button" data-action="nouvelle">＋ Nouvelle parcelle</button>
      <span class="pil-badge" title="${esc(REFERENCE)}">Aperçu équipe · FAO-56 Rev.1 (2025)</span>
    </div>
    <div id="pil-mode" class="pil-alerte hidden"></div>
    <nav class="pil-tabs" role="tablist">
      <button type="button" role="tab" data-tab="conseil">Conseil</button>
      <button type="button" role="tab" data-tab="saisies">Irrigations et pluies</button>
      <button type="button" role="tab" data-tab="parcelle">Parcelle</button>
      <button type="button" role="tab" data-tab="referentiel">Référentiel FAO</button>
    </nav>
    <section id="pil-panel" class="pil-panel"></section>
  </div>`;
  const $ = sel => root.querySelector(sel);
  const panel = $('#pil-panel');

  // ---------------------------------------------------------------------------
  // Chargement des données
  // ---------------------------------------------------------------------------
  async function chargerParcelles() {
    S.parcelles = (await store.parcelles()).map(normaliser);
    if (!S.parcelles.some(p => p.id === S.id)) S.id = S.parcelles[0]?.id ?? null;
    const sel = $('#pil-parcelle');
    sel.innerHTML = S.parcelles.length
      ? S.parcelles.map(p => `<option value="${esc(p.id)}"${p.id === S.id ? ' selected' : ''}>${esc(p.nom)} — ${esc(parId(p.culture_id)?.nom ?? p.culture_id)}</option>`).join('')
      : '<option value="">Aucune parcelle</option>';
    sel.disabled = !S.parcelles.length;
  }
  const courante = () => S.parcelles.find(p => p.id === S.id) || null;

  async function ouvrir(id) {
    S.id = id;
    storage.set('pilotage.courante', id);
    S.calc = null;
    S.erreur = null;
    const p = courante();
    if (!p) { render(); return; }
    if (estAnnuel(parId(p.culture_id))) S.annee = anneeDe(p.config.stades.debut);
    else if (S.annee > anneeDe(today)) S.annee = anneeDe(today);
    [S.irrigations, S.pluies] = await Promise.all([store.irrigations(id), store.pluies(id)]);
    render();
    calculer();
  }

  async function calculer() {
    const p = courante();
    if (!p) return;
    const token = ++S.token;
    S.charge = true;
    S.erreur = null;
    if (S.onglet === 'conseil') renderConseil();
    try {
      const per = periodeBilan(p, S.annee, today);
      if (per.debut > per.fin) throw new Error('La période du bilan est vide : vérifiez la date de début du bilan et les stades.');
      const place = { latitude: p.latitude, longitude: p.longitude, altitude: p.altitude };
      const met = await chargerMeteo(place, per.debut, per.fin, { client: ctx.supabase, stationId: p.station_id, aujourdhui: today, cache: storage });
      if (token !== S.token) return;
      if (!met.jours.length) throw new Error('Aucune donnée météo pour cette période.');
      const corrections = new Map(S.pluies.map(r => [r.jour, Number(r.pluie_mm)]));
      const meteo = met.jours.map(j => (corrections.has(j.date) ? { ...j, pluieModele: j.pluie, pluie: corrections.get(j.date), origine: `${j.origine} + pluie saisie` } : j));
      const param = versMoteur(p, S.annee, meteo);
      const irrig = S.irrigations.map(r => ({ date: r.jour, brut: Number(r.dose_brute_mm) }));
      const res = simuler(param.moteur, meteo, irrig, { ...param.options, planifier: per.enCours }, per.enCours ? today : null);
      const syn = per.enCours ? synthese(res, today, 7) : null;
      S.calc = { p, per, met, meteo, param, res, syn };
    } catch (error) {
      if (token !== S.token) return;
      console.error(error);
      S.erreur = error.message || String(error);
    } finally {
      if (token === S.token) {
        S.charge = false;
        if (S.onglet === 'conseil') renderConseil();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Rendu général
  // ---------------------------------------------------------------------------
  function render() {
    root.querySelectorAll('[data-tab]').forEach(b => {
      const on = b.dataset.tab === S.onglet;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const mode = $('#pil-mode');
    mode.classList.toggle('hidden', store.mode !== 'local');
    mode.innerHTML = store.mode === 'local'
      ? `<strong>Mode local.</strong> ${esc(store.erreur || 'Connexion à la base indisponible.')} Les parcelles saisies ici ne sont visibles que sur cet appareil.`
      : '';
    if (S.chart) { S.chart.destroy(); S.chart = null; }
    if (!courante() && S.onglet !== 'referentiel' && S.onglet !== 'parcelle') return renderVide();
    switch (S.onglet) {
      case 'saisies': return renderSaisies();
      case 'parcelle': return renderParcelle();
      case 'referentiel': return renderReferentiel();
      default: return renderConseil();
    }
  }

  function renderVide() {
    panel.innerHTML = `<div class="pil-card pil-vide">
      <h2>Pilotage de l’irrigation selon FAO-56 (édition 2025)</h2>
      <p>Créez une parcelle : culture et classe FAO, sol, système d’irrigation et dates des stades. L’outil calcule chaque jour le bilan hydrique et propose les irrigations des 7 prochains jours (dose en mm et en m³/ha, durée de poste).</p>
      <div class="pil-actions">
        <button type="button" class="sam-button sam-button-primary" data-action="nouvelle">＋ Créer une parcelle</button>
        <button type="button" class="sam-button" data-action="anciennes">Reprendre mes parcelles du Bilan hydrique</button>
      </div>
      <div id="pil-anciennes"></div>
    </div>`;
  }

  // ---------------------------------------------------------------------------
  // Onglet Conseil
  // ---------------------------------------------------------------------------
  function renderConseil() {
    if (S.onglet !== 'conseil') return;
    if (S.chart) { S.chart.destroy(); S.chart = null; }
    const p = courante();
    if (!p) return renderVide();
    const cult = parId(p.culture_id);
    const annees = estAnnuel(cult) ? [anneeDe(p.config.stades.debut)] : [0, 1, 2, 3].map(k => anneeDe(today) - k);
    const entete = `<div class="pil-head">
      <div><h2>${esc(p.nom)}</h2><p class="pil-muted">${esc(cult?.nom ?? '')} · ${esc(classeDe(cult, p.classe_id)?.nom ?? '')}${p.lieu ? ` · ${esc(p.lieu)}` : ''}</p></div>
      <label class="pil-inline">Campagne <select id="pil-annee" class="sam-input"${annees.length < 2 ? ' disabled' : ''}>${annees.map(a => `<option value="${a}"${a === S.annee ? ' selected' : ''}>${a}</option>`).join('')}</select></label>
    </div>`;
    if (S.charge && !S.calc) {
      panel.innerHTML = `${entete}<div class="pil-card pil-attente"><span class="sam-spinner"></span> Calcul du bilan hydrique (données météo, ET₀ Penman-Monteith)…</div>`;
      return;
    }
    if (S.erreur) {
      panel.innerHTML = `${entete}<div class="pil-card pil-erreur"><p><strong>Le bilan n’a pas pu être calculé.</strong> ${esc(S.erreur)}</p>
        <button type="button" class="sam-button" data-action="recalculer">Réessayer</button></div>`;
      return;
    }
    if (!S.calc) { panel.innerHTML = entete; return; }
    const { res, syn, per, param, met } = S.calc;
    panel.innerHTML = `${entete}
      ${per.enCours ? renderReco(p, syn, res) : renderBilanSaison(p, res)}
      <div class="pil-card">
        <div class="pil-card-head"><h3>Réserve en eau du sol</h3><span class="pil-muted">${dateFr(per.debut)} → ${dateFr(per.fin)}${per.enCours ? ' · pointillés = prévision' : ''}</span></div>
        <div class="pil-chart"><canvas id="pil-canvas" aria-label="Réserve en eau du sol"></canvas></div>
        <p class="pil-note">Eau disponible = RU − épuisement (Dr). En dessous du seuil, la culture consomme la réserve difficilement utilisable : le stress commence (Ks &lt; 1, Éq. 8.6).</p>
      </div>
      <details class="pil-card" id="pil-details">
        <summary>Détail jour par jour</summary>
        <div class="pil-actions pil-actions-tight">
          <label class="pil-check"><input type="checkbox" id="pil-tout"${S.toutVoir ? ' checked' : ''}> Toute la période</label>
          <button type="button" class="sam-button" data-action="csv">Exporter (CSV)</button>
        </div>
        <div class="pil-table-wrap">${tableJours(res.jours, S.toutVoir)}</div>
      </details>
      ${renderHypotheses(p, param, met, res)}`;
    dessiner(res.jours, per.enCours ? today : null);
  }

  function renderReco(p, syn, res) {
    const cfg = p.config;
    const irr = cfg.irrigation;
    const pluvio = irr.pluvio;
    const sys = systemeParId(irr.systeme);
    const ru = syn.taw;
    const dispo = finite(ru) ? ru - syn.drDebut : null;
    const marge = finite(syn.seuil) && finite(syn.drDebut) ? syn.seuil - syn.drDebut : null;
    const atteint = finite(marge) && marge <= 0;
    const ligneDose = (net, brut) => {
      const d = IR.decouperPostes(brut, pluvio, irr.dureeMaxPoste);
      const duree = finite(pluvio) && pluvio > 0
        ? (d.postes > 1 ? `${d.postes} postes de ${IR.formatDuree(d.dureeParPoste)}` : `durée ${IR.formatDuree(d.dureeTotale)}`)
        : '<span class="pil-muted">durée : renseignez la pluviométrie</span>';
      const vol = p.surface_ha ? ` · ${f0(IR.mmVersM3ha(brut) * p.surface_ha)} m³ sur ${f2(p.surface_ha)} ha` : '';
      return `<b>${f1(brut)} mm</b> bruts · <b>${f0(IR.mmVersM3ha(brut))} m³/ha</b> · ${duree}${vol}<br><span class="pil-muted">dose nette ${f1(net)} mm, efficience ${pct(irr.efficience)}</span>`;
    };
    let principal;
    if (syn.horsSaison && !syn.planifiees.length) {
      const st = S.calc.param.stades;
      const avant = today < st.debut;
      principal = `<p class="pil-reco-titre is-ok">Hors saison d’irrigation</p>
        <p class="pil-reco-dose">${avant ? `La saison commence le ${esc(dateLongue(st.debut))} (${esc(LIBELLES_STADES[estAnnuel(parId(p.culture_id)) ? 'annuel' : 'perenne'][0].toLowerCase())}).` : `La saison s’est terminée le ${esc(dateLongue(st.fin))}.`} Le bilan continue de suivre la recharge du sol par les pluies.</p>`;
    } else if (syn.planifiees.length) {
      const first = syn.planifiees[0];
      const quand = first.date === today ? 'Irriguer aujourd’hui' : `Prochaine irrigation : ${dateLongue(first.date)}`;
      principal = `<p class="pil-reco-titre is-irriguer">${esc(quand)}</p><p class="pil-reco-dose">${ligneDose(first.net, first.brut)}</p>`;
    } else {
      const fin = res.jours.find(j => j.date === syn.horizon);
      principal = `<p class="pil-reco-titre is-ok">Pas d’irrigation nécessaire${syn.horizon ? ` d’ici le ${esc(dateCourte(syn.horizon))}` : ''}</p>
        <p class="pil-reco-dose">La réserve reste au-dessus du seuil${fin ? ` : ${f0(fin.taw - fin.dr)} mm disponibles prévus en fin de période` : ''}.</p>`;
    }
    // Apports identiques sur des jours consécutifs : une seule ligne « chaque jour du … au … »
    const groupes = [];
    for (const x of syn.planifiees) {
      const g = groupes[groupes.length - 1];
      if (g && Math.abs(g.brut - x.brut) < 0.05 && ecartJours(g.fin, x.date) === 1) { g.fin = x.date; g.n++; }
      else groupes.push({ debut: x.date, fin: x.date, brut: x.brut, n: 1 });
    }
    const liste = syn.planifiees.length > 1
      ? `<ul class="pil-plan">${groupes.map(g => `<li><span>${g.n > 1 ? `Chaque jour du ${esc(dateCourte(g.debut))} au ${esc(dateCourte(g.fin))}` : esc(dateCourte(g.debut))}</span><span>${f1(g.brut)} mm bruts · ${f0(IR.mmVersM3ha(g.brut))} m³/ha${finite(pluvio) && pluvio > 0 ? ` · ${IR.formatDuree(g.brut / pluvio)}` : ''}</span></li>`).join('')}</ul>`
      : '';
    const besoin7 = syn.besoinBrut;
    const frequent = sys?.frequent && besoin7 > 0;
    const quotidien = frequent
      ? `<p class="pil-muted">En apport quotidien (${esc(sys.nom.toLowerCase())}) : ${f1(besoin7 / 8)} mm bruts par jour${finite(pluvio) && pluvio > 0 ? `, soit ${IR.formatDuree(besoin7 / 8 / pluvio)} par jour` : ''}, sur les 8 jours d’aujourd’hui à J+7.</p>`
      : '';
    const pluieTxt = syn.pluiePrevue > 0.2
      ? `Pluie prévue : ${f1(syn.pluiePrevue)} mm, dont ${f1(syn.pluieRetenue)} mm retenus (${pct(cfg.strategie?.pluiePrevue ?? 0.5)}).`
      : 'Pas de pluie significative prévue.';
    const ks = syn.ksAvant;
    return `<div class="pil-grid">
      <div class="pil-card pil-reco">
        <p class="pil-kicker">Conseil du ${esc(dateLongue(today))}</p>
        ${principal}
        ${liste}
        <p>Sur 8 jours (aujourd’hui à J+7) : <b>${f1(besoin7)} mm bruts</b> (${f0(IR.mmVersM3ha(besoin7))} m³/ha) pour une ETc prévue de ${f1(syn.etcPrevue)} mm. ${esc(pluieTxt)}</p>
        ${quotidien}
        <div class="pil-actions pil-actions-tight"><button type="button" class="sam-button" data-tab-go="saisies">Saisir une irrigation</button></div>
      </div>
      <div class="pil-kpis">
        <div class="pil-kpi"><span>Eau disponible</span><b>${f0(dispo)} mm</b><small>${pct(syn.fractionRU)} de la RU (${f0(ru)} mm)</small></div>
        <div class="pil-kpi ${atteint ? 'is-alerte' : ''}"><span>Avant le seuil</span><b>${atteint ? 'Seuil atteint' : `${f0(marge)} mm`}</b><small>seuil : ${f0(syn.seuil)} mm consommés</small></div>
        <div class="pil-kpi ${ks < 0.999 ? 'is-alerte' : ''}"><span>Confort hydrique</span><b>${ks < 0.999 ? `Stress (Ks ${f2(ks)})` : 'Sans stress'}</b><small>${syn.joursStress7 ? `${syn.joursStress7} j de stress sur 7` : 'aucun stress sur 7 jours'}</small></div>
        <div class="pil-kpi"><span>ETc 7 derniers jours</span><b>${f1(syn.etcPasse7)} mm</b><small>pluie ${f1(syn.pluiePasse7)} mm · irrigation ${f1(syn.irrigationPasse7)} mm</small></div>
      </div>
    </div>`;
  }

  function renderBilanSaison(p, res) {
    const j = res.jours.filter(x => x.stade !== 'hors');
    const s = (arr, k) => arr.reduce((a, x) => a + (x[k] || 0), 0);
    const all = res.jours;
    return `<div class="pil-card"><h3>Bilan de la campagne</h3>
      <div class="pil-kpis pil-kpis-row">
        <div class="pil-kpi"><span>ET₀</span><b>${f0(s(all, 'et0'))} mm</b><small>sur la période</small></div>
        <div class="pil-kpi"><span>ETc réelle (saison)</span><b>${f0(s(j, 'etcAct'))} mm</b><small>potentielle ${f0(s(j, 'etcPot'))} mm</small></div>
        <div class="pil-kpi"><span>Pluie</span><b>${f0(s(all, 'pluie'))} mm</b><small>percolation ${f0(s(all, 'dp'))} mm</small></div>
        <div class="pil-kpi"><span>Irrigation saisie</span><b>${f0(s(all, 'irrigationBrute'))} mm</b><small>${f0(IR.mmVersM3ha(s(all, 'irrigationBrute')))} m³/ha · ${all.filter(x => x.stress && x.stade !== 'hors').length} j de stress</small></div>
      </div></div>`;
  }

  function renderHypotheses(p, param, met, res) {
    const cfg = p.config;
    const cl = param.cl;
    const comp = met.jours.filter(j => finite(j.et0OM) && finite(j.et0));
    const ecart = comp.length ? comp.reduce((s, j) => s + (j.et0 - j.et0OM), 0) / comp.length : null;
    const estim = new Set(met.jours.flatMap(j => j.estimations || []));
    const k = res.parametres.kcb;
    const st = param.stades;
    const apTxt = param.ap
      ? `<li>Kcb de mi-saison par l’approche A&amp;P (chap. 9) : fc ${pct(cfg.culture.ap.fc)} → fc effectif ${pct(param.ap.fcEff)}, Kd ${f2(param.ap.kd)}, Kcb plein ${f2(param.ap.kcbFull)} (Éq. 9.9 à 9.13) → <b>${f2(param.ap.kcb)}</b>.</li>`
      : '';
    const stationNom = p.station_id ? (ctx.stations.store.list.find(s => s.id === p.station_id)?.nom || p.station_id) : null;
    return `<details class="pil-card pil-hyp"><summary>Sources, paramètres et hypothèses</summary>
      <ul>
        <li><b>ET₀</b> FAO Penman-Monteith (Éq. 2.4) recalculée chaque jour à partir des données horaires Open-Meteo (réanalyse ERA5 jusqu’à J−8, modèles de prévision ensuite). ${met.sources.station ? `Station SAM ${esc(stationNom)} : températures, humidité et pluie mesurées sur ${met.sources.station} jours.` : 'Aucune station SAM associée.'} ${finite(ecart) ? `Écart moyen avec l’ET₀ publiée par Open-Meteo : ${f2(ecart)} mm/j.` : ''}${estim.size ? ` Estimations FAO pour données manquantes : ${esc([...estim].join(' ; '))}.` : ''}</li>
        <li><b>Coefficients</b> (${cfg.methode === 'simple' ? 'Kc simple, chap. 6' : 'Kcb + Ke, chap. 7, couche de surface Éq. 7.11–7.14'}) : Kcb ini ${f2(k.ini)}, mi ${f2(k.mi)}, fin ${f2(k.fin)} ${cfg.culture.kcbPerso ? '(valeurs personnalisées)' : `— ${src(cl.kcb.src)}`}${res.parametres.options.ajusterClimat ? ' ajustés au climat (Éq. 7.2)' : ''} ; climat de mi-saison : u₂ ${f1(param.climat.mi.u2)} m/s, HRmin ${f0(param.climat.mi.hrmin)} %.</li>
        ${apTxt}
        <li><b>Stades ${S.annee}</b> : ${dateFr(st.debut)}, ${dateFr(st.finIni)}, ${dateFr(st.finDev)}, ${dateFr(st.finMi)}, ${dateFr(st.fin)}. FAO-56 (2025) recommande d’observer les stades sur place.</li>
        <li><b>Sol</b> : θcc ${f2(cfg.sol.thetaFC)}, θpf ${f2(cfg.sol.thetaWP)} m³/m³ (${esc(solParId(cfg.sol.texture)?.nom ?? '')}, tableau 7.5), RU ${f0(res.parametres.ruParM)} mm/m${cfg.sol.cailloux ? `, cailloux ${f0(cfg.sol.cailloux)} %` : ''} ; TEW ${f1(res.parametres.tew)} mm, REW ${f1(res.parametres.rew)} mm (Ze ${f2(cfg.sol.ze ?? 0.1)} m). Zr ${f2(cfg.culture.zr)} m, p ${f2(cfg.culture.p)} ${parId(p.culture_id)?.p?.src ? src(parId(p.culture_id).p.src) : ''}, ajusté chaque jour à l’ETc (Éq. 8.5).</li>
        <li><b>Irrigation</b> : ${esc(systemeParId(cfg.irrigation.systeme)?.nom ?? '')}, fw ${f2(cfg.irrigation.fw)} (tableau 7.6), efficience ${pct(cfg.irrigation.efficience)} (valeur à vérifier sur le réseau)${(cfg.irrigation.fractionHumectee ?? 1) < 1 ? `, fraction humectée ${pct(cfg.irrigation.fractionHumectee)} (ajustement de terrain hors FAO-56)` : ''}.</li>
        <li><b>Hypothèses</b> : ${finite(cfg.etatInitial) && cfg.etatInitial < 1 ? `réserve à ${pct(cfg.etatInitial)}` : 'réserve pleine (capacité au champ)'} le ${dateFr(S.calc.per.debut)} ; sous-sol à la capacité au champ quand les racines progressent ; pluie prévue retenue à ${pct(cfg.strategie?.pluiePrevue ?? 0.5)} ; pas de ruissellement ni de remontée capillaire.</li>
      </ul>
      <p class="pil-muted">${esc(REFERENCE)}</p>
    </details>`;
  }

  function tableJours(jours, tout) {
    const debut = tout ? 0 : Math.max(0, jours.findIndex(j => j.date >= addDaysISO(today, -21)));
    const lignes = jours.slice(debut).reverse();
    return `<table class="pil-table">
      <thead><tr><th>Date</th><th>Stade</th><th>ET₀</th><th>Kcb</th><th>Ke</th><th>Ks</th><th>ETc</th><th>Pluie</th><th>Irrig. brute</th><th>Eau dispo.</th><th>Seuil</th><th>Météo</th></tr></thead>
      <tbody>${lignes.map(j => `<tr class="${j.prevision ? 'is-prev' : ''}${j.stress ? ' is-stress' : ''}">
        <td>${esc(dateCourte(j.date))}</td><td>${NOMS_STADE[j.stade] || ''}</td><td>${f1(j.et0)}</td><td>${f2(j.kcb)}</td><td>${finite(j.ke) ? f2(j.ke) : '—'}</td>
        <td>${f2(j.ks)}</td><td>${f1(j.etcAct)}</td><td>${j.pluie ? f1(j.pluie) : ''}</td>
        <td>${j.irrigationBrute ? `${f1(j.irrigationBrute)}${j.planifiee ? ' <em>conseil</em>' : ''}` : ''}</td>
        <td>${f0(j.taw - j.dr)} / ${f0(j.taw)}</td><td>${f0(j.taw - j.seuil)}</td><td class="pil-muted">${esc(S.calc?.meteo.find(m => m.date === j.date)?.origine ?? '')}</td></tr>`).join('')}</tbody></table>`;
  }

  function exporterCsv() {
    if (!S.calc) return;
    const { res, meteo, p } = S.calc;
    const m = new Map(meteo.map(x => [x.date, x]));
    const cols = [
      ['date', j => j.date], ['prevision', j => (j.prevision ? 1 : 0)], ['stade', j => j.stade],
      ['tmax', j => m.get(j.date)?.tmax], ['tmin', j => m.get(j.date)?.tmin], ['hrmin', j => m.get(j.date)?.hrmin], ['u2', j => m.get(j.date)?.u2], ['rs', j => m.get(j.date)?.rs],
      ['et0_fao_pm', j => j.et0], ['et0_open_meteo', j => m.get(j.date)?.et0OM], ['source_meteo', j => m.get(j.date)?.origine],
      ['pluie', j => j.pluie], ['pluie_retenue', j => j.pluieRetenue], ['irrigation_brute', j => j.irrigationBrute], ['irrigation_nette', j => j.irrigationNette], ['conseil', j => (j.planifiee ? 1 : 0)],
      ['kcb', j => j.kcb], ['kc_max', j => j.kcMax], ['fc', j => j.fc], ['few', j => j.few], ['kr', j => j.kr], ['ke', j => j.ke], ['ks', j => j.ks], ['kc_act', j => j.kc],
      ['h', j => j.h], ['zr', j => j.zr], ['taw', j => j.taw], ['p', j => j.p], ['raw', j => j.raw], ['seuil', j => j.seuil],
      ['de', j => j.de], ['dr', j => j.dr], ['dp', j => j.dp], ['etc_pot', j => j.etcPot], ['etc_act', j => j.etcAct], ['transpiration', j => j.transpiration], ['evaporation', j => j.evaporation]
    ];
    const cell = v => (v === null || v === undefined ? '' : typeof v === 'number' ? String(+v.toFixed(4)).replace('.', ',') : `"${String(v).replace(/"/g, '""')}"`);
    const csv = [cols.map(c => c[0]).join(';'), ...res.jours.map(j => cols.map(c => cell(c[1](j))).join(';'))].join('\n');
    const blob = new Blob([`﻿# ${REFERENCE}\n${csv}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pilotage_${p.nom.replace(/[^\w-]+/g, '_')}_${S.annee}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function dessiner(jours, jourJ) {
    const canvas = root.querySelector('#pil-canvas');
    if (!canvas || !window.Chart) return;
    const labels = jours.map(j => j.date);
    const iJ = jourJ ? labels.findIndex(d => d >= jourJ) : -1;
    const prev = i => iJ >= 0 && i >= iJ;
    const reserve = jours.map(j => +(j.taw - j.dr).toFixed(1));
    const pluie = jours.map(j => (j.pluie > 0 ? +j.pluie.toFixed(1) : null));
    const irrig = jours.map(j => (j.irrigationBrute > 0 && !j.planifiee ? +j.irrigationBrute.toFixed(1) : null));
    const conseil = jours.map(j => (j.planifiee ? +j.planifiee.brut.toFixed(1) : null));
    const aujourdhuiPlugin = {
      id: 'pilAujourdhui',
      afterDatasetsDraw(chart) {
        if (iJ < 0) return;
        const x = chart.scales.x.getPixelForValue(iJ);
        const { top, bottom } = chart.chartArea;
        const g = chart.ctx;
        g.save();
        g.strokeStyle = 'rgba(30,33,38,.45)';
        g.setLineDash([4, 4]);
        g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke();
        g.setLineDash([]);
        g.fillStyle = '#3a3f47';
        g.font = '600 11px Inter, system-ui, sans-serif';
        g.fillText('Aujourd’hui', x + 4, top + 12);
        g.restore();
      }
    };
    S.chart = new window.Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { type: 'line', label: 'Eau disponible', data: reserve, borderColor: '#c5011a', backgroundColor: 'rgba(197,1,26,.08)', fill: 'origin', borderWidth: 2.2, pointRadius: 0, tension: 0.15, yAxisID: 'y', order: 1,
            segment: { borderDash: c => (prev(c.p1DataIndex) ? [6, 4] : undefined) } },
          { type: 'line', label: 'RU (capacité au champ)', data: jours.map(j => +j.taw.toFixed(1)), borderColor: '#6b717b', borderWidth: 1.4, pointRadius: 0, yAxisID: 'y', order: 2 },
          { type: 'line', label: 'Seuil de déclenchement', data: jours.map(j => +(j.taw - j.seuil).toFixed(1)), borderColor: '#e08a00', borderDash: [5, 4], borderWidth: 1.6, pointRadius: 0, yAxisID: 'y', order: 3 },
          { type: 'bar', label: 'Pluie', data: pluie, backgroundColor: 'rgba(43,121,194,.65)', yAxisID: 'y2', order: 5, barPercentage: 1, categoryPercentage: 0.9 },
          { type: 'bar', label: 'Irrigation saisie', data: irrig, backgroundColor: 'rgba(46,125,50,.8)', yAxisID: 'y2', order: 4, barPercentage: 1, categoryPercentage: 0.9 },
          { type: 'bar', label: 'Irrigation conseillée', data: conseil, backgroundColor: 'rgba(87,165,61,.35)', borderColor: '#2e7d32', borderWidth: 1, borderDash: [3, 2], yAxisID: 'y2', order: 4, barPercentage: 1, categoryPercentage: 0.9 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 14, usePointStyle: false, font: { size: 12 } } },
          tooltip: {
            callbacks: {
              title: items => (items[0] ? `${dateCourte(labels[items[0].dataIndex])}${prev(items[0].dataIndex) ? ' (prévision)' : ''}` : ''),
              label: c => (c.raw === null || c.raw === undefined ? null : `${c.dataset.label} : ${f1(c.raw)} mm`)
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10, callback: (v, i) => jourMois(labels[i]) } },
          y: { min: 0, title: { display: true, text: 'Eau du sol (mm)' }, grid: { color: 'rgba(101,114,126,.13)' } },
          y2: { position: 'right', reverse: true, min: 0, suggestedMax: 60, grid: { drawOnChartArea: false }, title: { display: true, text: 'Pluie, irrigation (mm)' } }
        }
      },
      plugins: [aujourdhuiPlugin]
    });
    try { enableChartZoom(S.chart); } catch (error) { console.warn(error); }
  }

  // ---------------------------------------------------------------------------
  // Onglet Irrigations et pluies
  // ---------------------------------------------------------------------------
  function renderSaisies() {
    const p = courante();
    const pluvio = p.config.irrigation.pluvio;
    const irr = [...S.irrigations].sort((a, b) => b.jour.localeCompare(a.jour));
    const pl = [...S.pluies].sort((a, b) => b.jour.localeCompare(a.jour));
    panel.innerHTML = `<div class="pil-grid pil-grid-2">
      <form class="pil-card" id="pil-form-irr" autocomplete="off">
        <h3>Ajouter une irrigation</h3>
        <div class="pil-fields">
          <label class="sam-field">Date<input type="date" name="jour" value="${today}" max="${addDaysISO(today, 7)}" required></label>
          <label class="sam-field">Quantité<input name="valeur" inputmode="decimal" placeholder="ex. 12" required></label>
          <label class="sam-field">Unité<select name="unite" class="sam-input">
            <option value="mm">mm bruts</option><option value="m3ha">m³/ha</option>
            <option value="heures"${finite(pluvio) && pluvio > 0 ? '' : ' disabled'}>heures de poste${finite(pluvio) && pluvio > 0 ? ` (${f2(pluvio)} mm/h)` : ' (pluviométrie à renseigner)'}</option>
          </select></label>
        </div>
        <details class="pil-sub"><summary>Répéter sur une période (goutte-à-goutte, micro-aspersion)</summary>
          <div class="pil-fields">
            <label class="sam-field">Jusqu’au<input type="date" name="jusqu" max="${addDaysISO(today, 7)}"></label>
            <label class="sam-field">Tous les (jours)<input name="pas" inputmode="numeric" value="1"></label>
          </div>
        </details>
        <label class="sam-field">Note<input name="note" maxlength="200" placeholder="facultatif"></label>
        <p class="pil-muted" id="pil-irr-apercu">Dose brute = eau apportée par le réseau. La dose nette (efficience ${pct(p.config.irrigation.efficience)}) est déduite par le calcul.</p>
        <div class="pil-actions"><button type="submit" class="sam-button sam-button-primary">Enregistrer</button></div>
        <p class="sam-form-message" id="pil-irr-msg"></p>
      </form>
      <form class="pil-card" id="pil-form-pluie" autocomplete="off">
        <h3>Corriger la pluie (pluviomètre de la parcelle)</h3>
        <p class="pil-muted">La valeur saisie remplace la pluie Open-Meteo ou celle de la station pour ce jour.</p>
        <div class="pil-fields">
          <label class="sam-field">Date<input type="date" name="jour" value="${addDaysISO(today, -1)}" max="${today}" required></label>
          <label class="sam-field">Pluie (mm)<input name="mm" inputmode="decimal" required></label>
        </div>
        <div class="pil-actions"><button type="submit" class="sam-button">Enregistrer</button></div>
        <p class="sam-form-message" id="pil-pluie-msg"></p>
      </form>
    </div>
    <div class="pil-grid pil-grid-2">
      <div class="pil-card"><h3>Irrigations saisies <span class="pil-muted">(${irr.length})</span></h3>
        ${irr.length ? `<table class="pil-table"><thead><tr><th>Date</th><th>Brut (mm)</th><th>m³/ha</th><th>Saisie</th><th></th></tr></thead><tbody>
          ${irr.map(r => `<tr><td>${esc(dateCourte(r.jour))}</td><td>${f1(Number(r.dose_brute_mm))}</td><td>${f0(IR.mmVersM3ha(Number(r.dose_brute_mm)))}</td>
            <td class="pil-muted">${esc(r.saisie ? `${f2(r.saisie.valeur)} ${r.saisie.unite === 'm3ha' ? 'm³/ha' : r.saisie.unite === 'heures' ? 'h' : 'mm'}` : '')}${r.note ? ` · ${esc(r.note)}` : ''}</td>
            <td><button type="button" class="pil-suppr" data-action="suppr-irr" data-id="${esc(r.id)}" aria-label="Supprimer">✕</button></td></tr>`).join('')}
        </tbody></table>` : '<p class="pil-muted">Aucune irrigation saisie.</p>'}
      </div>
      <div class="pil-card"><h3>Pluies corrigées <span class="pil-muted">(${pl.length})</span></h3>
        ${pl.length ? `<table class="pil-table"><thead><tr><th>Date</th><th>Pluie (mm)</th><th></th></tr></thead><tbody>
          ${pl.map(r => `<tr><td>${esc(dateCourte(r.jour))}</td><td>${f1(Number(r.pluie_mm))}</td><td><button type="button" class="pil-suppr" data-action="suppr-pluie" data-id="${esc(r.id)}" aria-label="Supprimer">✕</button></td></tr>`).join('')}
        </tbody></table>` : '<p class="pil-muted">Aucune correction.</p>'}
      </div>
    </div>`;
    const formIrr = $('#pil-form-irr');
    const apercu = () => {
      const brut = IR.brutDepuisSaisie({ unite: formIrr.unite.value, valeur: num(formIrr.valeur.value), pluvioMmH: pluvio });
      $('#pil-irr-apercu').textContent = finite(brut)
        ? `= ${f1(brut)} mm bruts · ${f0(IR.mmVersM3ha(brut))} m³/ha · dose nette ${f1(IR.netDepuisBrut(brut, p.config.irrigation.efficience))} mm${finite(pluvio) && pluvio > 0 ? ` · ${IR.formatDuree(brut / pluvio)}` : ''}`
        : `Dose brute = eau apportée par le réseau. La dose nette (efficience ${pct(p.config.irrigation.efficience)}) est déduite par le calcul.`;
    };
    formIrr.addEventListener('input', apercu);
    formIrr.addEventListener('submit', async e => {
      e.preventDefault();
      const msg = $('#pil-irr-msg');
      const unite = formIrr.unite.value;
      const valeur = num(formIrr.valeur.value);
      const brut = IR.brutDepuisSaisie({ unite, valeur, pluvioMmH: pluvio });
      if (!finite(brut) || brut <= 0 || brut > 500) { msg.textContent = 'Quantité invalide.'; msg.classList.add('is-error'); return; }
      const debut = formIrr.jour.value;
      const fin = formIrr.jusqu.value || debut;
      const pas = Math.max(1, Math.round(num(formIrr.pas.value) || 1));
      if (fin < debut) { msg.textContent = 'La date de fin précède la date de début.'; msg.classList.add('is-error'); return; }
      const lignes = [];
      for (let d = debut; d <= fin && lignes.length < 400; d = addDaysISO(d, pas)) {
        lignes.push({ parcelle_id: p.id, jour: d, dose_brute_mm: +brut.toFixed(2), saisie: { unite, valeur, pluvio: unite === 'heures' ? pluvio : null }, note: formIrr.note.value.trim() || null });
      }
      try {
        await store.ajouterIrrigations(lignes);
        S.irrigations = await store.irrigations(p.id);
        ctx.ui.toast(lignes.length > 1 ? `${lignes.length} irrigations enregistrées` : 'Irrigation enregistrée');
        renderSaisies();
        calculer();
      } catch (error) {
        msg.textContent = error.message || 'Enregistrement impossible.';
        msg.classList.add('is-error');
      }
    });
    const formPl = $('#pil-form-pluie');
    formPl.addEventListener('submit', async e => {
      e.preventDefault();
      const mm = num(formPl.mm.value);
      const msg = $('#pil-pluie-msg');
      if (!finite(mm) || mm < 0 || mm > 1000) { msg.textContent = 'Valeur invalide.'; msg.classList.add('is-error'); return; }
      try {
        await store.enregistrerPluies([{ parcelle_id: p.id, jour: formPl.jour.value, pluie_mm: mm }]);
        S.pluies = await store.pluies(p.id);
        ctx.ui.toast('Pluie enregistrée');
        renderSaisies();
        calculer();
      } catch (error) {
        msg.textContent = error.message || 'Enregistrement impossible.';
        msg.classList.add('is-error');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Onglet Parcelle (création et réglages)
  // ---------------------------------------------------------------------------
  function nouvelleParcelle() {
    const place = ctx.location.get?.() || {};
    const cult = parId('pommier');
    const cl = cult.classes[2] || cult.classes[0];
    return {
      id: null, nom: '', lieu: place.name || '', latitude: place.latitude ?? null, longitude: place.longitude ?? null,
      altitude: finite(place.elevation) ? place.elevation : null, surface_ha: null, station_id: null,
      culture_id: cult.id, classe_id: cl.id, config: configDefaut(cult, cl, anneeDe(today))
    };
  }

  function renderParcelle() {
    const d = S.brouillon || (courante() ? structuredClone(courante()) : nouvelleParcelle());
    S.brouillon = d;
    const cfg = d.config;
    const cult = parId(d.culture_id);
    const cl = classeDe(cult, d.classe_id);
    const annuel = estAnnuel(cult);
    const sys = systemeParId(cfg.irrigation.systeme);
    const stations = ctx.stations.store.list || [];
    const loc = cfg.irrigation.localise || {};
    const libStades = annuel ? LIBELLES_STADES.annuel : LIBELLES_STADES.perenne;
    const champsStades = ['debut', 'finIni', 'finDev', 'finMi', 'fin'];
    const familles = Object.entries(FAMILLES).filter(([k]) => CULTURES.some(c => c.famille === k));
    const ap = cfg.culture.ap || {};
    const opt = (v, cur, label) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(label)}</option>`;
    const n = (v, dgt = 2) => (finite(v) ? String(+v.toFixed(dgt)).replace('.', ',') : '');
    const ru = finite(cfg.sol.ruParM) ? cfg.sol.ruParM : 1000 * (cfg.sol.thetaFC - cfg.sol.thetaWP);
    const taw = ru * cfg.culture.zr * (1 - (cfg.sol.cailloux || 0) / 100) * (cfg.irrigation.fractionHumectee ?? 1);
    const gddOptions = (cult.gdd || []).map((g, i) => opt(i, 0, `${g.type} — ${f0(g.total)} °C·j`)).join('');
    panel.innerHTML = `<form id="pil-form" class="pil-form" autocomplete="off" novalidate>
      <div class="pil-card pil-form-head">
        <h2>${d.id ? `Réglages — ${esc(d.nom)}` : 'Nouvelle parcelle'}</h2>
        <div class="pil-actions">
          ${d.id ? '<button type="button" class="sam-button" data-action="dupliquer">Dupliquer</button><button type="button" class="sam-button pil-danger" data-action="supprimer">Supprimer</button>' : '<button type="button" class="sam-button" data-action="anciennes">Reprendre une parcelle du Bilan hydrique</button>'}
          <button type="submit" class="sam-button sam-button-primary">Enregistrer</button>
        </div>
        <div id="pil-anciennes"></div>
        <p class="sam-form-message" id="pil-form-msg"></p>
      </div>

      <fieldset class="pil-card"><legend>Parcelle</legend>
        <div class="pil-fields">
          <label class="sam-field">Nom<input name="nom" value="${esc(d.nom)}" required maxlength="80" placeholder="ex. Gala — bloc 3"></label>
          <label class="sam-field">Surface (ha)<input name="surface_ha" inputmode="decimal" value="${n(d.surface_ha, 3)}" placeholder="facultatif"></label>
          <label class="sam-field pil-lieu">Commune<input name="lieu" value="${esc(d.lieu || '')}" placeholder="Rechercher une commune…"><div class="pil-lieu-res" id="pil-lieu-res"></div></label>
          <label class="sam-field">Latitude (°)<input name="latitude" inputmode="decimal" value="${n(d.latitude, 4)}" required></label>
          <label class="sam-field">Longitude (°)<input name="longitude" inputmode="decimal" value="${n(d.longitude, 4)}" required></label>
          <label class="sam-field">Altitude (m)<input name="altitude" inputmode="decimal" value="${n(d.altitude, 0)}" placeholder="auto"></label>
          <label class="sam-field">Station SAM (T, HR, pluie mesurées)<select name="station_id" class="sam-input">${opt('', d.station_id || '', 'Aucune — Open-Meteo seul')}${stations.map(s => opt(s.id, d.station_id || '', `${s.nom}${s.commune ? ` (${s.commune})` : ''}`)).join('')}</select></label>
        </div>
        <div class="pil-actions pil-actions-tight"><button type="button" class="sam-button" data-action="gps">Utiliser ma position</button></div>
      </fieldset>

      <fieldset class="pil-card"><legend>Culture (tableaux 6.x, 7.x et 8.x)</legend>
        <div class="pil-fields">
          <label class="sam-field">Famille<select name="famille" class="sam-input">${familles.map(([k, v]) => opt(k, cult.famille, v)).join('')}</select></label>
          <label class="sam-field">Culture<select name="culture_id" class="sam-input">${CULTURES.filter(c => c.famille === cult.famille).map(c => opt(c.id, cult.id, c.nom)).join('')}</select></label>
          <label class="sam-field pil-large">Classe FAO (densité, conduite, couvert)<select name="classe_id" class="sam-input">${cult.classes.map(c => opt(c.id, cl.id, c.nom)).join('')}</select></label>
        </div>
        <div class="pil-ref">
          <span>Kcb ini <b>${f2(cl.kcb.ini)}</b> · mi <b>${f2(cl.kcb.mid)}</b> · fin <b>${f2(cl.kcb.end)}</b> ${src(cl.kcb.src)}</span>
          ${cl.kc ? `<span>Kc ${f2(cl.kc.ini)} · ${f2(cl.kc.mid)} · ${f2(cl.kc.end)} ${src(cl.kc.src)}</span>` : ''}
          <span>fc ${plage(cl.fc)} · h ${plage(cl.h)} m${cl.zr ? ` · Zr ${plage(cl.zr)} m` : ''}</span>
          <span>p ${cult.p?.p != null ? f2(cult.p.p) : esc(cult.p?.txt || '—')} ${cult.p?.src ? src(cult.p.src) : ''}</span>
          ${cult.note ? `<span class="pil-muted">${esc(cult.note)}</span>` : ''}
        </div>
        <div class="pil-fields">
          <label class="sam-field">Fraction p (RFU / RU)<input name="p" inputmode="decimal" value="${n(cfg.culture.p)}"></label>
          <label class="sam-field">Hauteur h (m)<input name="h" inputmode="decimal" value="${n(cfg.culture.h)}"></label>
          <label class="sam-field">Profondeur racinaire Zr (m)<input name="zr" inputmode="decimal" value="${n(cfg.culture.zr)}"></label>
          ${annuel ? `<label class="sam-field">Zr au semis (m)<input name="zrMin" inputmode="decimal" value="${n(cfg.culture.zrMin)}"></label>` : ''}
          <label class="sam-field">Kcb hors saison<input name="kcbHorsSaison" inputmode="decimal" value="${n(cfg.culture.kcbHorsSaison)}"></label>
          <label class="sam-field">Méthode<select name="methode" class="sam-input">${opt('double', cfg.methode, 'Double : Kcb + Ke')}${cl.kc ? opt('simple', cfg.methode, 'Simple : Kc') : ''}</select></label>
        </div>
        ${!annuel && !cl.zr ? `<p class="pil-note">${esc(DEFAUTS_TERRAIN.zrLigneux.note)}</p>` : ''}
        ${cult.p?.p == null && cult.p?.txt ? `<p class="pil-note">FAO : ${esc(cult.p.txt)} — saisissez une fraction p adaptée.</p>` : ''}
        <details class="pil-sub"${cfg.culture.kcbPerso ? ' open' : ''}><summary>Kcb personnalisés (calage local)</summary>
          <label class="pil-check"><input type="checkbox" name="kcbPersoActif"${cfg.culture.kcbPerso ? ' checked' : ''}> Remplacer les valeurs du tableau</label>
          <div class="pil-fields">
            <label class="sam-field">Kcb ini<input name="kcbIni" inputmode="decimal" value="${n(cfg.culture.kcbPerso?.ini ?? cl.kcb.ini)}"></label>
            <label class="sam-field">Kcb mi-saison<input name="kcbMi" inputmode="decimal" value="${n(cfg.culture.kcbPerso?.mi ?? cl.kcb.mid)}"></label>
            <label class="sam-field">Kcb fin<input name="kcbFin" inputmode="decimal" value="${n(cfg.culture.kcbPerso?.fin ?? cl.kcb.end)}"></label>
          </div>
          <label class="pil-check"><input type="checkbox" name="ajusterClimat"${cfg.culture.ajusterClimat !== false ? ' checked' : ''}> Ajuster mi-saison et fin au climat local (Éq. 7.2 : vent, HRmin, hauteur)</label>
        </details>
        <details class="pil-sub"${ap.actif ? ' open' : ''}><summary>Kcb de mi-saison d’après la couverture mesurée (approche A&amp;P, chap. 9)</summary>
          <label class="pil-check"><input type="checkbox" name="apActif"${ap.actif ? ' checked' : ''}> Utiliser l’approche A&amp;P (Éq. 9.9 à 9.13)</label>
          <div class="pil-fields">
            <label class="sam-field">Couverture fc (%)<input name="apFc" inputmode="decimal" value="${n((ap.fc ?? 0.5) * 100, 0)}"></label>
            <label class="sam-field">Forme<select name="apForme" class="sam-input">${opt('arbres', ap.forme, 'Arbres isolés (couronne)')}${opt('rangs', ap.forme, 'Rangs / haie fruitière / vigne palissée')}</select></label>
            <label class="sam-field">Hauteur de la haie (m)<input name="apHaut" inputmode="decimal" value="${n(ap.hauteurCanopee)}"></label>
            <label class="sam-field">Largeur de la haie (m)<input name="apLarg" inputmode="decimal" value="${n(ap.largeur)}"></label>
            <label class="sam-field">Orientation des rangs<select name="apAngle" class="sam-input">${opt(90, ap.angleRang, 'Nord-sud')}${opt(45, ap.angleRang, 'Nord-est / sud-ouest')}${opt(0, ap.angleRang, 'Est-ouest')}</select></label>
            <label class="sam-field">ML (tableau 9.3)<input name="apMl" inputmode="decimal" value="${n(ap.ml)}"></label>
            <label class="sam-field">Fr (régulation stomatique)<input name="apFr" inputmode="decimal" value="${n(ap.fr)}"></label>
            <label class="sam-field">Kcb du couvert de l’inter-rang<input name="apCouvert" inputmode="decimal" value="${n(ap.kcbCouvert)}" placeholder="vide = sol nu"></label>
          </div>
          <p class="pil-note">fc = fraction du sol ombragée à midi (ou largeur de haie / inter-rang). Le Kcb du couvert (Éq. 9.10) est à estimer : environ 0,3 à 0,8 selon la densité et l’entretien de l’enherbement.</p>
        </details>
      </fieldset>

      <fieldset class="pil-card"><legend>Stades ${annuel ? 'de la culture' : `(année de référence ${anneeDe(cfg.stades.debut)}, reportés sur les autres années)`}</legend>
        <div class="pil-fields">
          ${champsStades.map((k, i) => `<label class="sam-field">${esc(libStades[i])}<input type="date" name="st_${k}" value="${esc(cfg.stades[k])}" required></label>`).join('')}
        </div>
        ${annuel && cult.gdd?.length && cult.temp ? `<div class="pil-gdd">
          <label class="sam-field">Durées en degrés-jours (${src(cult.gdd[0].src)})<select name="gddType" class="sam-input">${gddOptions}</select></label>
          <button type="button" class="sam-button" data-action="gdd">Calculer les stades depuis le semis</button>
          <span class="pil-muted">Tbase ${f1(cult.temp.tbase)} °C, Tsup ${f1(cult.temp.tupper)} °C ${src(cult.temp.src)}. Températures réelles puis celles de l’année précédente au-delà de J+7.</span>
        </div>` : ''}
        <p class="pil-note">Dates proposées à titre indicatif : FAO-56 (2025) recommande d’observer les stades sur la parcelle.</p>
        <div class="pil-fields">
          <label class="sam-field">Début du bilan<input type="date" name="debutBilan" value="${esc(annuel ? (/^\d{4}-/.test(cfg.debutBilan) ? cfg.debutBilan : addDaysISO(cfg.stades.debut, -30)) : debutBilanAffiche(cfg))}"></label>
          <label class="sam-field">Réserve disponible au début (% RU)<input name="etatInitial" inputmode="decimal" value="${n((cfg.etatInitial ?? 1) * 100, 0)}"></label>
        </div>
        ${annuel ? '' : '<p class="pil-note">Pour les cultures pérennes, le bilan démarre chaque année à ce jour et ce mois (sol supposé à la capacité au champ par défaut, à ajuster après un hiver sec).</p>'}
      </fieldset>

      <fieldset class="pil-card"><legend>Sol (tableau 7.5)</legend>
        <div class="pil-fields">
          <label class="sam-field pil-large">Texture<select name="texture" class="sam-input">${SOLS.map(s => opt(s.id, cfg.sol.texture, `${s.nom} (${s.nom_en})`)).join('')}${Object.entries(SOLS_VOISINS).map(([k, v]) => opt(k, cfg.sol.texture, v.note)).join('')}</select></label>
          <label class="sam-field">θ capacité au champ (m³/m³)<input name="thetaFC" inputmode="decimal" value="${n(cfg.sol.thetaFC, 3)}"></label>
          <label class="sam-field">θ point de flétrissement (m³/m³)<input name="thetaWP" inputmode="decimal" value="${n(cfg.sol.thetaWP, 3)}"></label>
          <label class="sam-field">REW (mm)<input name="rew" inputmode="decimal" value="${n(cfg.sol.rew, 1)}"></label>
          <label class="sam-field">Couche évaporante Ze (m)<input name="ze" inputmode="decimal" value="${n(cfg.sol.ze ?? 0.1)}"></label>
          <label class="sam-field">RU mesurée (mm/cm)<input name="ruCm" inputmode="decimal" value="${finite(cfg.sol.ruParM) ? n(cfg.sol.ruParM / 100, 2) : ''}" placeholder="vide = θcc − θpf"></label>
          <label class="sam-field">Cailloux (% du volume)<input name="cailloux" inputmode="decimal" value="${n(cfg.sol.cailloux || 0, 0)}"></label>
        </div>
        <div class="pil-texture">
          <span class="pil-muted">Depuis une analyse :</span>
          <input name="argile" inputmode="decimal" placeholder="% argile" class="sam-input">
          <input name="limon" inputmode="decimal" placeholder="% limon" class="sam-input">
          <input name="sable" inputmode="decimal" placeholder="% sable" class="sam-input">
          <button type="button" class="sam-button" data-action="texture">Classer (triangle USDA)</button>
        </div>
        <p class="pil-ref" id="pil-sol-calc">RU ${f0(ru)} mm/m · TAW ≈ ${f0(taw)} mm sur ${f2(cfg.culture.zr)} m · RAW ≈ ${f0(taw * cfg.culture.p)} mm · TEW ${f1(C.tew(cfg.sol.thetaFC, cfg.sol.thetaWP, cfg.sol.ze ?? 0.1))} mm</p>
      </fieldset>

      <fieldset class="pil-card"><legend>Irrigation (tableau 7.6)</legend>
        <div class="pil-fields">
          <label class="sam-field pil-large">Système<select name="systeme" class="sam-input">${SYSTEMES.map(s => opt(s.id, sys?.id, s.nom)).join('')}</select></label>
          <label class="sam-field">Fraction humectée fw<input name="fw" inputmode="decimal" value="${n(cfg.irrigation.fw)}"></label>
          <label class="sam-field">Efficience d’application (%)<input name="efficience" inputmode="decimal" value="${n(cfg.irrigation.efficience * 100, 0)}"></label>
          <label class="sam-field">Pluviométrie (mm/h)<input name="pluvio" inputmode="decimal" value="${n(cfg.irrigation.pluvio, 3)}" placeholder="pour les durées"></label>
          <label class="sam-field">Durée maximale d’un poste (h)<input name="dureeMaxPoste" inputmode="decimal" value="${n(cfg.irrigation.dureeMaxPoste, 1)}" placeholder="facultatif"></label>
          <label class="sam-field">Dose nette maximale (mm)<input name="doseMaxNette" inputmode="decimal" value="${n(cfg.irrigation.doseMaxNette, 1)}" placeholder="facultatif"></label>
          <label class="sam-field">Volume racinaire humecté (%)<input name="fractionHumectee" inputmode="decimal" value="${n((cfg.irrigation.fractionHumectee ?? 1) * 100, 0)}"></label>
        </div>
        <p class="pil-note">fw tabulé : ${sys ? `${f2(sys.fw[0])} – ${f2(sys.fw[1])}` : '—'} ${src('7.6|236')}. Efficience proposée ${pct(sys?.efficience)} : valeur indicative, à mesurer (Manuel FAO n° 5). Volume humecté &lt; 100 % : ajustement de terrain hors FAO-56, qui réduit la RU prise en compte.</p>
        <details class="pil-sub"><summary>Calculer la pluviométrie</summary>
          <div class="pil-fields">
            <label class="sam-field">Débit d’un goutteur / diffuseur (L/h)<input name="debitLh" inputmode="decimal" value="${n(loc.debitLh, 2)}"></label>
            <label class="sam-field">Espacement sur le rang (m)<input name="espacement" inputmode="decimal" value="${n(loc.espacement, 2)}"></label>
            <label class="sam-field">Inter-rang (m)<input name="interRang" inputmode="decimal" value="${n(loc.interRang, 2)}"></label>
            <label class="sam-field">Points par emplacement<input name="parPoint" inputmode="decimal" value="${n(loc.parPoint ?? 1, 0)}"></label>
          </div>
          <div class="pil-fields">
            <label class="sam-field">ou débit du secteur (m³/h)<input name="debitM3h" inputmode="decimal" value="${n(loc.debitM3h, 2)}"></label>
            <label class="sam-field">surface du secteur (ha)<input name="surfaceSecteur" inputmode="decimal" value="${n(loc.surfaceSecteur, 3)}"></label>
          </div>
          <button type="button" class="sam-button" data-action="pluvio">Calculer</button>
        </details>
      </fieldset>

      <fieldset class="pil-card"><legend>Stratégie de conseil</legend>
        <div class="pil-fields">
          <label class="sam-field pil-large">Déclenchement<select name="strategie" class="sam-input">${Object.entries(STRATEGIES).map(([k, v]) => opt(k, cfg.strategie?.mode || 'fao', v)).join('')}</select></label>
          <label class="sam-field">Seuil personnalisé (% RU)<input name="mad" inputmode="decimal" value="${finite(cfg.strategie?.mad) ? n(cfg.strategie.mad * 100, 0) : ''}"></label>
          <label class="sam-field">Recompléter jusqu’à<select name="cible" class="sam-input">${opt(1, cfg.strategie?.cible ?? 1, '100 % de la RU')}${opt(0.9, cfg.strategie?.cible ?? 1, '90 % de la RU')}${opt(0.8, cfg.strategie?.cible ?? 1, '80 % de la RU')}</select></label>
          <label class="sam-field">Pluie prévue prise en compte<select name="pluiePrevue" class="sam-input">${opt(0, cfg.strategie?.pluiePrevue ?? 0.5, '0 % (prudent)')}${opt(0.5, cfg.strategie?.pluiePrevue ?? 0.5, '50 %')}${opt(1, cfg.strategie?.pluiePrevue ?? 0.5, '100 %')}</select></label>
          <label class="sam-field">Paillage (chap. 10)<select name="paillage" class="sam-input">${opt('aucun', cfg.paillage?.type, 'Aucun')}${opt('plastique', cfg.paillage?.type, 'Film plastique')}${opt('organique', cfg.paillage?.type, 'Organique (paille, broyat)')}</select></label>
          <label class="sam-field">Surface paillée (%)<input name="couverture" inputmode="decimal" value="${n(cfg.paillage?.couverture || 0, 0)}"></label>
        </div>
      </fieldset>
      <div class="pil-actions pil-actions-end"><button type="submit" class="sam-button sam-button-primary">Enregistrer</button></div>
    </form>`;
    lierFormulaire();
  }

  /** Lit le formulaire dans le brouillon (sans valider). */
  function lireFormulaire() {
    const f = $('#pil-form');
    if (!f) return S.brouillon;
    const d = S.brouillon;
    const cfg = d.config;
    const v = name => f.elements[name]?.value ?? '';
    const nv = (name, def = null) => { const x = num(v(name)); return finite(x) ? x : def; };
    const ck = name => !!f.elements[name]?.checked;
    d.nom = v('nom').trim();
    d.surface_ha = nv('surface_ha');
    d.lieu = v('lieu').trim();
    d.latitude = nv('latitude');
    d.longitude = nv('longitude');
    d.altitude = nv('altitude');
    d.station_id = v('station_id') || null;
    const cult = parId(d.culture_id);
    const annuel = estAnnuel(cult);
    const cu = cfg.culture;
    cu.p = nv('p', cu.p);
    cu.h = nv('h', cu.h);
    cu.zr = nv('zr', cu.zr);
    if (annuel) cu.zrMin = nv('zrMin', cu.zrMin);
    cu.kcbHorsSaison = nv('kcbHorsSaison', cu.kcbHorsSaison);
    cfg.methode = v('methode') || 'double';
    cu.kcbPerso = ck('kcbPersoActif') ? { ini: nv('kcbIni'), mi: nv('kcbMi'), fin: nv('kcbFin') } : null;
    cu.ajusterClimat = ck('ajusterClimat');
    cu.ap = {
      actif: ck('apActif'), fc: (nv('apFc', 50)) / 100, forme: v('apForme') || 'arbres', hauteurCanopee: nv('apHaut', cu.h),
      largeur: nv('apLarg', 1.5), angleRang: nv('apAngle', 90), ml: nv('apMl', 1.5), fr: nv('apFr', 1), kcbCouvert: nv('apCouvert')
    };
    for (const k of ['debut', 'finIni', 'finDev', 'finMi', 'fin']) cfg.stades[k] = v(`st_${k}`) || cfg.stades[k];
    const db = v('debutBilan');
    if (db) cfg.debutBilan = annuel ? db : db.slice(5);
    cfg.etatInitial = Math.min(1, Math.max(0, nv('etatInitial', 100) / 100));
    cfg.sol.texture = v('texture');
    cfg.sol.thetaFC = nv('thetaFC', cfg.sol.thetaFC);
    cfg.sol.thetaWP = nv('thetaWP', cfg.sol.thetaWP);
    cfg.sol.rew = nv('rew', cfg.sol.rew);
    cfg.sol.ze = nv('ze', 0.1);
    const ruCm = nv('ruCm');
    cfg.sol.ruParM = finite(ruCm) ? ruCm * 100 : null;
    cfg.sol.cailloux = Math.min(90, Math.max(0, nv('cailloux', 0)));
    const irr = cfg.irrigation;
    irr.systeme = v('systeme');
    irr.fw = nv('fw', irr.fw);
    irr.efficience = nv('efficience', irr.efficience * 100) / 100;
    irr.pluvio = nv('pluvio');
    irr.dureeMaxPoste = nv('dureeMaxPoste');
    irr.doseMaxNette = nv('doseMaxNette');
    irr.fractionHumectee = Math.min(1, Math.max(0.05, nv('fractionHumectee', 100) / 100));
    irr.localise = { debitLh: nv('debitLh'), espacement: nv('espacement'), interRang: nv('interRang'), parPoint: nv('parPoint', 1), debitM3h: nv('debitM3h'), surfaceSecteur: nv('surfaceSecteur') };
    const mad = nv('mad');
    cfg.strategie = { mode: v('strategie') || 'fao', mad: finite(mad) ? mad / 100 : null, cible: nv('cible', 1), pluiePrevue: nv('pluiePrevue', 0.5) };
    cfg.paillage = { type: v('paillage') || 'aucun', couverture: nv('couverture', 0) };
    return d;
  }

  function erreursParcelle(d) {
    const e = [];
    const cfg = d.config;
    if (!d.nom) e.push('Donnez un nom à la parcelle.');
    if (!finite(d.latitude) || Math.abs(d.latitude) > 90 || !finite(d.longitude) || Math.abs(d.longitude) > 180) e.push('Latitude ou longitude invalide.');
    try { C.stadesDepuisDates(cfg.stades); } catch (error) { e.push(error.message); }
    if (!(cfg.sol.thetaFC > cfg.sol.thetaWP && cfg.sol.thetaWP >= 0 && cfg.sol.thetaFC < 0.7)) e.push('Sol : θ capacité au champ doit dépasser θ point de flétrissement.');
    if (!(cfg.culture.p > 0.05 && cfg.culture.p < 0.95)) e.push('La fraction p doit être comprise entre 0,05 et 0,95.');
    if (!(cfg.culture.zr > 0.05 && cfg.culture.zr <= 5)) e.push('Profondeur racinaire invalide.');
    if (!(cfg.irrigation.fw > 0 && cfg.irrigation.fw <= 1)) e.push('fw doit être compris entre 0 et 1.');
    if (!(cfg.irrigation.efficience >= 0.3 && cfg.irrigation.efficience <= 1)) e.push('L’efficience doit être comprise entre 30 et 100 %.');
    if (cfg.culture.kcbPerso && ['ini', 'mi', 'fin'].some(k => !(cfg.culture.kcbPerso[k] >= 0 && cfg.culture.kcbPerso[k] <= 2))) e.push('Kcb personnalisés invalides.');
    if (cfg.strategie.mode === 'perso' && !(cfg.strategie.mad > 0.02 && cfg.strategie.mad < 0.95)) e.push('Seuil personnalisé : entre 2 et 95 % de la RU.');
    if (cfg.culture.ap?.actif && !(cfg.culture.ap.fc > 0 && cfg.culture.ap.fc <= 1)) e.push('A&P : couverture fc entre 1 et 100 %.');
    return e;
  }

  function lierFormulaire() {
    const f = $('#pil-form');
    const rafraichir = () => { lireFormulaire(); renderParcelle(); };
    f.elements.famille.addEventListener('change', () => {
      lireFormulaire();
      const cult = CULTURES.find(c => c.famille === f.elements.famille.value);
      changerCulture(cult);
    });
    f.elements.culture_id.addEventListener('change', () => { lireFormulaire(); changerCulture(parId(f.elements.culture_id.value)); });
    f.elements.classe_id.addEventListener('change', () => {
      lireFormulaire();
      const d = S.brouillon;
      const cult = parId(d.culture_id);
      const cl = classeDe(cult, f.elements.classe_id.value);
      d.classe_id = cl.id;
      const cu = defautsCulture(cult, cl);
      Object.assign(d.config.culture, { h: cu.h, zr: estAnnuel(cult) ? cu.zr : d.config.culture.zr, kcbHorsSaison: cu.kcbHorsSaison, ap: { ...cu.ap, actif: d.config.culture.ap?.actif } });
      renderParcelle();
    });
    f.elements.texture.addEventListener('change', () => {
      lireFormulaire();
      const s = solParId(f.elements.texture.value);
      Object.assign(S.brouillon.config.sol, { thetaFC: s.thetaFC, thetaWP: s.thetaWP, rew: s.rewDefaut });
      renderParcelle();
    });
    f.elements.systeme.addEventListener('change', () => {
      lireFormulaire();
      const s = systemeParId(f.elements.systeme.value);
      Object.assign(S.brouillon.config.irrigation, { fw: s.fwDefaut, efficience: s.efficience });
      // Irrigation localisée : apports fréquents, seuil « confort » par défaut (modifiable)
      const st = S.brouillon.config.strategie;
      if (s.frequent && st.mode === 'fao') st.mode = 'confort';
      else if (!s.frequent && st.mode === 'confort') st.mode = 'fao';
      renderParcelle();
    });
    for (const name of ['thetaFC', 'thetaWP', 'zr', 'p', 'ruCm', 'cailloux', 'fractionHumectee', 'ze']) {
      f.elements[name]?.addEventListener('change', rafraichir);
    }
    // Recherche de commune
    const lieu = f.elements.lieu;
    const res = $('#pil-lieu-res');
    let t = null;
    lieu.addEventListener('input', () => {
      clearTimeout(t);
      const q = lieu.value.trim();
      if (q.length < 2) { res.innerHTML = ''; return; }
      t = setTimeout(async () => {
        try {
          const list = await searchPlaces(q);
          res.innerHTML = list.map((pl, i) => `<button type="button" data-i="${i}">${esc(pl.name)} <small>${esc([pl.postcode, pl.admin2].filter(Boolean).join(' · '))}</small></button>`).join('');
          res.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
            const pl = list[Number(b.dataset.i)];
            lireFormulaire();
            Object.assign(S.brouillon, { lieu: pl.name, latitude: pl.latitude, longitude: pl.longitude, altitude: pl.elevation });
            renderParcelle();
          }));
        } catch { res.innerHTML = '<span class="pil-muted">Recherche indisponible.</span>'; }
      }, 300);
    });
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const d = lireFormulaire();
      const msg = $('#pil-form-msg');
      const errs = erreursParcelle(d);
      if (errs.length) { msg.innerHTML = errs.map(esc).join('<br>'); msg.classList.add('is-error'); msg.scrollIntoView({ block: 'center' }); return; }
      try {
        const row = await store.enregistrerParcelle({
          ...(d.id ? { id: d.id } : {}), nom: d.nom, lieu: d.lieu || null, latitude: d.latitude, longitude: d.longitude, altitude: d.altitude,
          surface_ha: d.surface_ha, station_id: d.station_id, culture_id: d.culture_id, classe_id: d.classe_id, config: d.config,
          ...(d.origine_bilan_id ? { origine_bilan_id: d.origine_bilan_id } : {})
        });
        S.brouillon = null;
        ctx.ui.toast('Parcelle enregistrée');
        S.id = row.id;
        S.onglet = 'conseil';
        storage.set('pilotage.onglet', S.onglet);
        await chargerParcelles();
        await ouvrir(row.id);
      } catch (error) {
        msg.textContent = error.message || 'Enregistrement impossible.';
        msg.classList.add('is-error');
      }
    });
  }

  function changerCulture(cult) {
    const d = S.brouillon;
    const cl = cult.classes[Math.min(2, cult.classes.length - 1)] || cult.classes[0];
    const ancienAnnuel = estAnnuel(parId(d.culture_id));
    d.culture_id = cult.id;
    d.classe_id = cl.id;
    const cfgNeuf = configDefaut(cult, cl, anneeDe(today));
    d.config.culture = cfgNeuf.culture;
    d.config.methode = 'double';
    if (ancienAnnuel !== estAnnuel(cult) || !d.id) {
      d.config.stades = cfgNeuf.stades;
      d.config.debutBilan = cfgNeuf.debutBilan;
    } else if (!estAnnuel(cult)) {
      d.config.stades = cfgNeuf.stades;
    }
    renderParcelle();
  }

  async function stadesDegresJours() {
    const d = lireFormulaire();
    const f = $('#pil-form');
    const msg = $('#pil-form-msg');
    const cult = parId(d.culture_id);
    const g = cult.gdd[Number(f.elements.gddType.value) || 0];
    const semis = d.config.stades.debut;
    if (!finite(d.latitude) || !finite(d.longitude)) { msg.textContent = 'Renseignez d’abord la position de la parcelle.'; return; }
    msg.classList.remove('is-error');
    msg.textContent = 'Calcul des degrés-jours…';
    try {
      const place = { latitude: d.latitude, longitude: d.longitude, altitude: d.altitude };
      const finReel = addDaysISO(today, 7);
      const serie = [];
      if (semis <= finReel) {
        const fin = addDaysISO(semis, 300) < finReel ? addDaysISO(semis, 300) : finReel;
        const m = await chargerMeteo(place, semis, fin, { aujourdhui: today, cache: storage });
        serie.push(...m.jours);
      }
      const dernier = serie.length ? serie[serie.length - 1].date : addDaysISO(semis, -1);
      const finVoulue = addDaysISO(semis, 300);
      if (dernier < finVoulue) {
        // Au-delà des données disponibles : températures de l'année précédente, mêmes jours.
        const debutN1 = addDaysISO(dernier, 1 - 365);
        let finN1 = addDaysISO(finVoulue, -365);
        if (finN1 > addDaysISO(today, -8)) finN1 = addDaysISO(today, -8);
        if (debutN1 <= finN1) {
          const m = await chargerMeteo(place, debutN1, finN1, { aujourdhui: today, cache: storage });
          serie.push(...m.jours.map(j => ({ ...j, date: addDaysISO(j.date, 365) })).filter(j => j.date > dernier));
        }
      }
      const r = C.stadesDepuisDegresJours(semis, g, serie, cult.temp.tbase, cult.temp.tupper);
      if (!r.fin) { msg.textContent = `Données insuffisantes : ${f0(r.cumul)} °C·j cumulés sur ${f0(g.total)}.`; return; }
      Object.assign(d.config.stades, { finIni: r.finIni, finDev: r.finDev, finMi: r.finMi, fin: r.fin });
      renderParcelle();
      $('#pil-form-msg').textContent = `Stades calculés (${g.type}, ${f0(g.total)} °C·j) : à vérifier sur le terrain, puis enregistrer.`;
    } catch (error) {
      msg.textContent = error.message || 'Calcul impossible.';
      msg.classList.add('is-error');
    }
  }

  // ---------------------------------------------------------------------------
  // Reprise des parcelles de l'ancien Bilan hydrique (pommier)
  // ---------------------------------------------------------------------------
  async function afficherAnciennes() {
    const zone = $('#pil-anciennes');
    if (!zone) return;
    zone.innerHTML = '<p class="pil-muted"><span class="sam-spinner"></span> Recherche…</p>';
    S.anciennes = await store.anciennesParcelles();
    const deja = new Set(S.parcelles.map(p => p.origine_bilan_id).filter(Boolean));
    zone.innerHTML = S.anciennes.length
      ? `<ul class="pil-anciennes">${S.anciennes.map(a => `<li><span><b>${esc(a.name)}</b> <small>${esc(a.location_name || '')}</small></span>
          ${deja.has(a.id) ? '<span class="pil-muted">déjà reprise</span>' : `<button type="button" class="sam-button" data-action="reprendre" data-id="${esc(a.id)}">Reprendre</button>`}</li>`).join('')}</ul>`
      : '<p class="pil-muted">Aucune parcelle dans le Bilan hydrique pour ce compte.</p>';
  }

  async function reprendre(id) {
    const a = S.anciennes?.find(x => x.id === id);
    if (!a) return;
    const cult = parId('pommier');
    const cl = cult.classes[2] || cult.classes[0];
    const cfg = configDefaut(cult, cl, anneeDe(today));
    const texture = finite(a.clay) && finite(a.silt) && finite(a.sand) ? C.classeTextureUSDA(a.clay, a.silt, a.sand) : 'loam';
    const sol = solParId(texture) || solParId('loam');
    cfg.sol = { texture, thetaFC: sol.thetaFC, thetaWP: sol.thetaWP, rew: sol.rewDefaut, ze: 0.1, cailloux: 0, ruParM: finite(Number(a.rum_mm_cm)) ? Number(a.rum_mm_cm) * 100 : null };
    if (finite(Number(a.root_depth_cm))) cfg.culture.zr = Number(a.root_depth_cm) / 100;
    if (finite(Number(a.p_factor))) cfg.culture.p = Number(a.p_factor);
    const sys = systemeParId(a.irrigation_system === 'sprinkler' ? 'aspersion-verger' : 'goutte-a-goutte');
    Object.assign(cfg.irrigation, { systeme: sys.id, fw: sys.fwDefaut, efficience: sys.efficience });
    cfg.debutBilan = '10-01';
    if (a.use_custom_kc && finite(Number(a.kc_mid))) {
      cfg.methode = 'simple';
      cfg.culture.kcPerso = { ini: Number(a.kc_initial), mi: Number(a.kc_peak ?? a.kc_mid), fin: Number(a.kc_end) };
    }
    try {
      const row = await store.enregistrerParcelle({
        nom: a.name, lieu: a.location_name || null, latitude: a.lat, longitude: a.lon, altitude: null,
        surface_ha: a.area_ha, station_id: null, culture_id: cult.id, classe_id: cl.id, config: cfg, origine_bilan_id: a.id
      });
      const old = await store.anciennesDonnees(a.id);
      await store.ajouterIrrigations(old.irrigations.filter(r => Number(r.amount_mm) > 0).map(r => ({
        parcelle_id: row.id, jour: r.irrigation_date, dose_brute_mm: Number(r.amount_mm), saisie: { unite: 'mm', valeur: Number(r.amount_mm) }, note: 'Reprise Bilan hydrique'
      })));
      await store.enregistrerPluies(old.pluies.map(r => ({ parcelle_id: row.id, jour: r.rain_date, pluie_mm: Number(r.amount_mm) })));
      ctx.ui.toast(`« ${a.name} » reprise : vérifiez la classe FAO et les stades`);
      S.brouillon = null;
      S.id = row.id;
      S.onglet = 'parcelle';
      await chargerParcelles();
      await ouvrir(row.id);
    } catch (error) {
      ctx.ui.toast(error.message || 'Reprise impossible');
    }
  }

  // ---------------------------------------------------------------------------
  // Onglet Référentiel FAO-56 (2025)
  // ---------------------------------------------------------------------------
  function renderReferentiel() {
    const choix = storage.get('pilotage.refCulture', 'pommier');
    const cult = parId(choix) || CULTURES[0];
    const fam = Object.entries(FAMILLES);
    panel.innerHTML = `<div class="pil-card">
      <div class="pil-card-head"><h3>Cultures — valeurs FAO-56 Rev.1 (2025)</h3>
        <select id="pil-ref-culture" class="sam-input">${fam.map(([k, v]) => `<optgroup label="${esc(v)}">${CULTURES.filter(c => c.famille === k).map(c => `<option value="${c.id}"${c.id === cult.id ? ' selected' : ''}>${esc(c.nom)}</option>`).join('')}</optgroup>`).join('')}</select>
      </div>
      <p><b>${esc(cult.nom)}</b> <i>${esc(cult.latin || '')}</i> · p ${cult.p?.p != null ? f2(cult.p.p) : esc(cult.p?.txt || '—')} ${cult.p?.src ? src(cult.p.src) : ''}${cult.p?.p_intensif ? ` (intensif ${f2(cult.p.p_intensif)})` : ''}
        ${cult.temp ? ` · Tbase ${f1(cult.temp.tbase)} °C, Tsup ${f1(cult.temp.tupper)} °C ${src(cult.temp.src)}` : ''}
        ${cult.sel ? ` · salinité : ${esc(SALINITE[cult.sel.rating] || cult.sel.rating || '')}${cult.sel.ece_t != null ? `, ECe seuil ${f1(cult.sel.ece_t)} dS/m, pente ${f1(cult.sel.b)} %/dS/m` : cult.sel.txt && cult.sel.txt !== '-' ? `, ECe seuil ${esc(cult.sel.txt)} dS/m` : ''} ${src(cult.sel.src)}` : ''}</p>
      <div class="pil-table-wrap"><table class="pil-table">
        <thead><tr><th>Classe</th><th>fc</th><th>h (m)</th><th>Zr (m)</th><th>Kcb ini</th><th>Kcb mi</th><th>Kcb fin</th><th>Kc ini</th><th>Kc mi</th><th>Kc fin</th><th>A&amp;P (mi-saison)</th></tr></thead>
        <tbody>${cult.classes.map(c => {
          const apMid = Array.isArray(c.ap) ? c.ap.find(a => /mid/i.test(a.stade)) : null;
          return `<tr><td>${esc(c.nom)}<br><small class="pil-muted">${esc(c.nom_en || '')}</small></td><td>${plage(c.fc)}</td><td>${plage(c.h, 1)}</td><td>${plage(c.zr, 1)}</td>
            <td>${f2(c.kcb.ini)}</td><td>${f2(c.kcb.mid)}</td><td>${f2(c.kcb.end)} ${src(c.kcb.src)}</td>
            <td>${c.kc ? f2(c.kc.ini) : '—'}</td><td>${c.kc ? f2(c.kc.mid) : '—'}</td><td>${c.kc ? `${f2(c.kc.end)} ${src(c.kc.src)}` : '—'}</td>
            <td>${apMid ? `fc ${plage(apMid.fc)} · h ${plage(apMid.h, 1)} · ML ${finite(apMid.ML) ? f1(apMid.ML) : '—'}${apMid.Fr ? ` · Fr ${f2(apMid.Fr)}` : ''} ${src(apMid.src)}` : '—'}</td></tr>`;
        }).join('')}</tbody></table></div>
      ${cult.gdd?.length ? `<h4>Durée des stades en degrés-jours (°C·j)</h4><div class="pil-table-wrap"><table class="pil-table"><thead><tr><th>Type</th><th>Initial</th><th>Développement</th><th>Mi-saison</th><th>Fin</th><th>Total</th></tr></thead>
        <tbody>${cult.gdd.map(g => `<tr><td>${esc(g.type)}</td><td>${f0(g.ini)}</td><td>${f0(g.dev)}</td><td>${f0(g.mid)}</td><td>${f0(g.late)}</td><td>${f0(g.total)} ${src(g.src)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${cult.note ? `<p class="pil-note">${esc(cult.note)}</p>` : ''}
    </div>
    <div class="pil-grid pil-grid-2">
      <div class="pil-card"><h3>Sols types (tableau 7.5)</h3><div class="pil-table-wrap"><table class="pil-table">
        <thead><tr><th>Texture</th><th>θcc</th><th>θpf</th><th>RU (mm/m)</th><th>REW</th><th>TEW (Ze 0,10)</th></tr></thead>
        <tbody>${SOLS.map(s => `<tr><td>${esc(s.nom)}<br><small class="pil-muted">${esc(s.nom_en)}</small></td><td>${f2(s.fc[0])} – ${f2(s.fc[1])}</td><td>${f2(s.wp[0])} – ${f2(s.wp[1])}</td><td>${f0(1000 * (s.thetaFC - s.thetaWP))}</td><td>${f0(s.rew[0])} – ${f0(s.rew[1])}</td><td>${f0(s.tew[0])} – ${f0(s.tew[1])}</td></tr>`).join('')}</tbody>
      </table></div><p class="pil-muted">${esc(SOLS[0].src)}</p></div>
      <div class="pil-card"><h3>Systèmes d’irrigation (tableau 7.6)</h3><div class="pil-table-wrap"><table class="pil-table">
        <thead><tr><th>Système</th><th>fw</th><th>Efficience indicative</th></tr></thead>
        <tbody>${SYSTEMES.map(s => `<tr><td>${esc(s.nom)}</td><td>${f2(s.fw[0])}${s.fw[1] !== s.fw[0] ? ` – ${f2(s.fw[1])}` : ''}</td><td>${pct(s.efficience)}</td></tr>`).join('')}</tbody>
      </table></div><p class="pil-muted">fw : ${esc(SYSTEMES[0].src)}. Efficience : ${esc(SYSTEMES[0].srcEfficience)}.</p></div>
    </div>
    <div class="pil-card"><h3>Paillages (tableaux 10.1 et 10.2) — réductions en %</h3><div class="pil-table-wrap"><table class="pil-table">
      <thead><tr><th>Cultures / paramètre</th><th>Paillage</th><th>Début</th><th>Mi-saison</th><th>Fin</th></tr></thead>
      <tbody>${PAILLAGE_KC.map(r => `<tr><td>${esc(r.cultures)} (Kc)</td><td>${esc(r.paillage)}</td><td>${r.debut.join(' – ')}</td><td>${r.mi.join(' – ')}</td><td>${r.fin.join(' – ')}</td></tr>`).join('')}
        ${PAILLAGE_ES.map(r => `<tr><td>${esc(r.parametre === 'Es' ? 'Évaporation du sol (Es)' : 'Kc')}</td><td>${esc(r.paillage)}</td><td>${r.debut ? r.debut.join(' – ') : '—'}</td><td>${r.mi ? r.mi.join(' – ') : '—'}</td><td>${r.fin ? r.fin.join(' – ') : '—'}</td></tr>`).join('')}</tbody>
    </table></div><p class="pil-muted">${esc(PAILLAGE_KC[0].src)} ; ${esc(PAILLAGE_ES[0].src)}</p></div>
    <div class="pil-card"><h3>Référence</h3><p>${esc(REFERENCE)}</p>
      <p class="pil-muted">Chaque coefficient affiché dans l’outil indique son tableau et sa page. Les valeurs « par défaut de terrain » (profondeur racinaire des ligneux, efficience, dates de stades, volume humecté) ne viennent pas de FAO-56 et sont signalées comme telles.</p></div>`;
    $('#pil-ref-culture').addEventListener('change', e => { storage.set('pilotage.refCulture', e.target.value); renderReferentiel(); });
  }

  // ---------------------------------------------------------------------------
  // Événements
  // ---------------------------------------------------------------------------
  ctx.scope.on(root, 'click', async e => {
    const tab = e.target.closest('[data-tab], [data-tab-go]');
    if (tab) {
      if (S.onglet === 'parcelle' && $('#pil-form')) lireFormulaire();
      S.onglet = tab.dataset.tab || tab.dataset.tabGo;
      storage.set('pilotage.onglet', S.onglet);
      render();
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    try {
      if (action === 'nouvelle') {
        S.brouillon = nouvelleParcelle();
        S.onglet = 'parcelle';
        render();
      } else if (action === 'recalculer') {
        calculer();
      } else if (action === 'csv') {
        exporterCsv();
      } else if (action === 'anciennes') {
        await afficherAnciennes();
      } else if (action === 'reprendre') {
        btn.disabled = true;
        await reprendre(btn.dataset.id);
      } else if (action === 'suppr-irr') {
        await store.supprimerIrrigations([btn.dataset.id]);
        S.irrigations = await store.irrigations(S.id);
        renderSaisies();
        calculer();
      } else if (action === 'suppr-pluie') {
        await store.supprimerPluie(btn.dataset.id);
        S.pluies = await store.pluies(S.id);
        renderSaisies();
        calculer();
      } else if (action === 'supprimer') {
        const p = courante();
        if (p && window.confirm(`Supprimer « ${p.nom} » et toutes ses irrigations ?`)) {
          await store.supprimerParcelle(p.id);
          S.brouillon = null;
          await chargerParcelles();
          S.onglet = 'conseil';
          if (S.id) await ouvrir(S.id); else render();
        }
      } else if (action === 'dupliquer') {
        const d = structuredClone(lireFormulaire());
        d.id = null;
        d.origine_bilan_id = null;
        d.nom = `${d.nom} (copie)`;
        S.brouillon = d;
        renderParcelle();
      } else if (action === 'gps') {
        const pl = await locateMe();
        lireFormulaire();
        Object.assign(S.brouillon, { latitude: pl.latitude, longitude: pl.longitude, lieu: pl.name || S.brouillon.lieu });
        renderParcelle();
      } else if (action === 'texture') {
        const f = $('#pil-form');
        const a = num(f.elements.argile.value), l = num(f.elements.limon.value), s = num(f.elements.sable.value);
        const t = finite(a) && finite(l) && finite(s) ? C.classeTextureUSDA(a, l, s) : null;
        if (!t) { $('#pil-form-msg').textContent = 'Renseignez les trois fractions (%).'; return; }
        lireFormulaire();
        const sol = solParId(t);
        Object.assign(S.brouillon.config.sol, { texture: t, thetaFC: sol.thetaFC, thetaWP: sol.thetaWP, rew: sol.rewDefaut });
        renderParcelle();
        $('#pil-form-msg').textContent = SOLS_VOISINS[t] ? SOLS_VOISINS[t].note : `Texture : ${sol.nom}.`;
      } else if (action === 'pluvio') {
        const d = lireFormulaire();
        const l = d.config.irrigation.localise;
        const v = IR.pluviometrieLocalisee({ debitLh: l.debitLh, espacement: l.espacement, interRang: l.interRang, parPoint: l.parPoint || 1 })
          ?? IR.pluviometrieAspersion({ debitM3h: l.debitM3h, surfaceHa: l.surfaceSecteur });
        if (!finite(v)) { $('#pil-form-msg').textContent = 'Renseignez débit, espacement et inter-rang (ou débit et surface du secteur).'; return; }
        d.config.irrigation.pluvio = +v.toFixed(3);
        renderParcelle();
        $('#pil-form-msg').textContent = `Pluviométrie : ${f2(v)} mm/h.`;
      } else if (action === 'gdd') {
        await stadesDegresJours();
      }
    } catch (error) {
      console.error(error);
      ctx.ui.toast(error.message || 'Action impossible');
    }
  });

  ctx.scope.on(root, 'change', e => {
    if (e.target.id === 'pil-parcelle') {
      S.brouillon = null;
      ouvrir(e.target.value);
    } else if (e.target.id === 'pil-annee') {
      S.annee = Number(e.target.value);
      S.calc = null;
      calculer();
    } else if (e.target.id === 'pil-tout') {
      S.toutVoir = e.target.checked;
      const wrap = root.querySelector('#pil-details .pil-table-wrap');
      if (wrap && S.calc) wrap.innerHTML = tableJours(S.calc.res.jours, S.toutVoir);
    }
  });

  // ---------------------------------------------------------------------------
  // Démarrage
  // ---------------------------------------------------------------------------
  panel.innerHTML = '<div class="pil-card pil-attente"><span class="sam-spinner"></span> Chargement…</div>';
  try {
    await store.init();
  } catch (error) {
    console.error(error);
    panel.innerHTML = `<div class="pil-card pil-erreur">Base de données indisponible : ${esc(error.message || error)}</div>`;
    return {};
  }
  // Liste des stations SAM : chargée en arrière-plan, le formulaire est redessiné quand elle arrive.
  ctx.stations.store.load().then(() => {
    const form = $('#pil-form');
    if (S.onglet === 'parcelle' && form && form.elements.station_id.options.length <= 1 && ctx.stations.store.list.length) {
      lireFormulaire();
      renderParcelle();
    }
  }).catch(() => null);
  await chargerParcelles();
  if (S.id) await ouvrir(S.id);
  else render();

  return {
    unmount() {
      S.token++;
      if (S.chart) { S.chart.destroy(); S.chart = null; }
    }
  };
}
