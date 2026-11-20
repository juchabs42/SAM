// SAM Bilan irrigation — bilan hydrique multi-cultures (méthode FAO-56, édition 2025).
//
// Calcule chaque jour l'eau disponible dans le sol et estime les apports d'irrigation des
// 7 prochains jours. Les résultats sont des estimations de calcul : l'outil ne formule aucune
// recommandation, la décision d'irriguer revient à l'exploitant.

import { storage, escapeHtml, todayISO, addDaysISO, formatNumber } from '../core/util.js';
import { enableChartZoom } from '../core/charts.js';
import { searchPlaces, locateMe } from '../core/places.js';
import { CULTURES, FAMILLES, parId } from '../fao56/data/cultures-2025.js';
import { SOLS, SOLS_VOISINS, solParId, SYSTEMES, systemeParId, DEFAUTS_TERRAIN } from '../fao56/data/references.js';
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
const pad2 = n => String(n).padStart(2, '0');

/** Valeur représentative d'une plage {min,max} / {max, op:'<'} / {min, op:'>'}. */
function milieu(r) {
  if (r == null) return null;
  if (typeof r === 'number') return r;
  if (finite(r.min) && finite(r.max)) return (r.min + r.max) / 2;
  if (finite(r.max)) return r.op === '<' ? 0.85 * r.max : r.max;
  if (finite(r.min)) return r.op === '>' ? 1.1 * r.min : r.min;
  return null;
}
/** Plage en clair : « 3 à 4 », « moins de 0,5 », « plus de 2 ». */
function plage(r, d = 1, facteur = 1) {
  if (r == null) return '—';
  const fmt = v => formatNumber(v * facteur, d);
  if (typeof r === 'number') return fmt(r);
  if (finite(r.min) && finite(r.max)) return r.min === r.max ? fmt(r.min) : `${fmt(r.min)} à ${fmt(r.max)}`;
  if (finite(r.max)) return `moins de ${fmt(r.max)}`;
  if (finite(r.min)) return `plus de ${fmt(r.min)}`;
  return '—';
}
const niveauStress = ks => (!finite(ks) || ks >= 0.999 ? 'Aucun' : ks >= 0.75 ? 'Léger' : ks >= 0.4 ? 'Modéré' : 'Fort');

/**
 * Coefficient du jour en clair : part transpiration + part évaporation du sol (méthode
 * détaillée), avec la cause de l'évaporation (dernière pluie ou irrigation).
 */
function decomposerCoef(j, jours, methode) {
  if (!j || !finite(j.kc)) return '';
  const conso = `Soit ${f1(j.etcAct)} mm consommés pour une ET₀ de ${f1(j.et0)} mm.`;
  const stress = finite(j.ks) && j.ks < 0.999;
  if (methode === 'simple' || !finite(j.ke)) {
    const base = j.kcTable ?? j.kc;
    return `Coefficient cultural (${(NOMS_STADE[j.stade] || '').toLowerCase()}), évaporation du sol comprise${stress ? ` : ${f2(base)}, réduit par le manque d’eau` : ''}. ${conso}`;
  }
  const i = jours.indexOf(j);
  let cause = '';
  for (let k = i; k >= 0 && k > i - 40; k--) {
    const x = jours[k];
    const quand = x.date === j.date ? 'du jour' : `du ${jourMois(x.date)}`;
    if (x.planifiee) { cause = `l’apport calculé ${quand}`; break; }
    if (x.irrigationNette > 0) { cause = `l’irrigation ${quand}`; break; }
    if (x.pluie >= 3) { cause = `la pluie ${quand}`; break; }
  }
  const evap = j.ke < 0.02
    ? 'évaporation du sol (surface sèche)'
    : `évaporation du sol ${j.kr >= 0.99 ? 'encore humide' : 'qui sèche'}${cause ? ` après ${cause}` : ''}`;
  const precisions = [j.stade === 'hors' ? 'hors saison' : '', stress ? `${f2(j.kcb)} réduit par le manque d’eau` : ''].filter(Boolean);
  const transp = `${f2(stress ? j.ks * j.kcb : j.kcb)} transpiration${precisions.length ? ` (${precisions.join(', ')})` : ''}`;
  const plafond = finite(j.kcMax) && j.kc >= j.kcMax - 0.005 && j.ke >= 0.05 ? ' C’est le maximum possible : culture et sol mouillé ne consomment pas davantage.' : '';
  return `${transp} + ${f2(j.ke)} ${evap} = ${f2(j.kc)}.${plafond} ${conso}`;
}

// ---------------------------------------------------------------------------
// Valeurs par défaut (indicatives, à ajuster)
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
  annuel: ['Semis ou plantation', 'Levée terminée', 'Végétation maximale', 'Début de la maturation', 'Récolte'],
  perenne: ['Débourrement', 'Premières feuilles étalées', 'Feuillage complet', 'Début du jaunissement', 'Chute des feuilles']
};
const NOMS_STADE = { hors: 'Hors saison', ini: 'Démarrage', dev: 'Croissance', mi: 'Pleine végétation', fin: 'Fin de saison' };
const SEUILS = {
  fao: 'Standard : quand la RFU est consommée',
  confort: 'Confort : à la moitié de la RFU',
  perso: 'Personnalisé (% de la RU consommée)'
};

const estAnnuel = cult => cult?.type === 'annuel';
const classeDe = (cult, id) => cult?.classes.find(c => c.id === id) || cult?.classes[0] || null;
const anneeDe = iso => Number(String(iso).slice(0, 4));
const ruSol = s => (finite(s?.thetaFC) && finite(s?.thetaWP) ? 1000 * (s.thetaFC - s.thetaWP) : null);
const nomSol = id => solParId(id) ? (SOLS_VOISINS[id]?.nom || solParId(id).nom) : '';

function stadesModele(cult, annee) {
  if (estAnnuel(cult)) return C.stadesDepuisDurees(`${annee}-04-15`, DUREES_ANNUELLES);
  const g = cult.type === 'perenne' ? 'prairie' : (GROUPE_STADES[cult.id] || 'tardif');
  const [a, b, c, d, e] = STADES_MODELES[g];
  return { debut: `${annee}-${a}`, finIni: `${annee}-${b}`, finDev: `${annee}-${c}`, finMi: `${annee}-${d}`, fin: `${annee}-${e}` };
}

/** Réglages par défaut d'une parcelle pour une espèce et une conduite. */
function configDefaut(cult, cl, annee) {
  const annuel = estAnnuel(cult);
  const sys = systemeParId(annuel ? 'aspersion' : 'goutte-a-goutte');
  const sol = solParId('loam');
  const stades = stadesModele(cult, annee);
  return {
    version: 1,
    reference: 'FAO-56 (2025)',
    methode: 'double',
    culture: defautsCulture(cult, cl),
    stades,
    sol: { texture: sol.id, thetaFC: sol.thetaFC, thetaWP: sol.thetaWP, rew: sol.rewDefaut, ze: 0.1, cailloux: 0, ruParM: null },
    irrigation: { systeme: sys.id, fw: sys.fwDefaut, efficience: sys.efficience, pluvio: null, localise: null, dureeMaxPoste: null, doseMaxNette: null, fractionHumectee: sys.humecteDefaut ?? 1 },
    strategie: { mode: sys.frequent ? 'confort' : 'fao', mad: null, cible: 1, ajusterP: true },
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
      // 'ombre' : ombre mesurée vers midi (utilisée telle quelle) ;
      // 'feuillage' : feuillage vu du dessus, ombre de midi déduite de la forme (Encadré 9.2).
      mesure: 'ombre',
      fc: +(milieu(apMid?.fc) ?? milieu(cl?.fc) ?? 0.5).toFixed(2),
      forme: annuel ? 'rangs' : (/trellis|hedge|palissé|haie|palissage/i.test(`${cl?.nom_en} ${cl?.nom}`) ? 'rangs' : 'arbres'),
      hauteurCanopee: +(h * 0.7).toFixed(2),
      largeur: 1.5,
      angleRang: 90,
      ml: apMid?.ML ?? 1.5,
      fr: apMid?.Fr ?? 1,
      kcbCouvert: null,
      releve: { largeur: null, diametre: null, espacement: null, interRang: null }
    }
  };
}

/** Décale les dates de stades (année de référence) sur l'année demandée (cultures pérennes). */
function stadesPourAnnee(stades, annee, annuel) {
  if (annuel) return stades;
  const ref = anneeDe(stades.debut);
  const decale = iso => {
    const y = anneeDe(iso) + (annee - ref);
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
  // Début après le débourrement (ex. 1er octobre) : le calcul part de l'automne précédent.
  const debut = `${md > cfg.stades.debut.slice(5) ? annee - 1 : annee}-${md}`;
  const courante = annee === anneeDe(today);
  return { debut, fin: courante ? addDaysISO(today, 7) : `${annee}-12-31`, enCours: courante };
}

/**
 * Apport utile maximal d'une irrigation : valeur saisie, sinon, en irrigation localisée,
 * capacité du poste (pluviométrie × durée maximale, 12 h par défaut × efficience), pour
 * obtenir des apports fréquents plutôt qu'un seul apport massif.
 */
function doseMax(irr, sys) {
  if (finite(irr.doseMaxNette) && irr.doseMaxNette > 0) return irr.doseMaxNette;
  if (sys?.frequent && finite(irr.pluvio) && irr.pluvio > 0) return irr.pluvio * (irr.dureeMaxPoste || 12) * (irr.efficience || 0.9);
  return null;
}

/** Paramètres du moteur pour une parcelle, une saison et la série météo chargée. */
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
  // Seuil standard : RFU ajustée chaque jour à la chaleur, sauf si l'utilisateur la veut fixe.
  const ajusterP = strat.mode === 'fao' || !strat.mode ? strat.ajusterP !== false : true;
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
      ajusterP,
      mad,
      cible: clampCible(strat.cible),
      // Pluie prévue comptée telle qu'annoncée ; l'onglet Bilan signale les pluies lointaines (incertaines).
      pluiePrevue: 1,
      doseMaxNette: doseMax(irr, sys)
    }
  };
}

const clampCible = v => (finite(v) ? Math.min(1, Math.max(0.5, v)) : 1);

function calculAP(cult, cu, stades, climat, latitude) {
  const a = cu.ap;
  const milieuMi = C.ajouterJours(stades.finDev, Math.round(C.ecartJours(stades.finDev, stades.finMi) / 2));
  const J = jourAnnee(milieuMi);
  // Ombre mesurée vers midi : c'est déjà la couverture effective. Réglages enregistrés avant
  // l'ajout du choix (pas de clé « mesure ») : feuillage vu du dessus, comme à l'origine.
  const fcEff = a.mesure === 'ombre'
    ? Math.min(1, Math.max(0, a.fc))
    : a.forme === 'rangs'
      ? C.fcEffRangs(a.fc, { hauteurCanopee: a.hauteurCanopee, largeur: a.largeur, angleRangDeg: a.angleRang, latitude, J })
      : C.fcEffArbres(a.fc, latitude, J);
  const kd = C.kdDensite({ fcEff, ml: a.ml ?? 1.5, h: cu.h });
  const kh = !estAnnuel(cult) || cu.h > 1.5 ? 0.1 : 0.2;
  const kcbFull = C.kcbPlein({ fr: a.fr ?? 1, h: cu.h, u2: climat.mi.u2, hrMin: climat.mi.hrmin, kh });
  const kcb = C.kcbAP({ kd, kcbFull, kcbCouvert: finite(a.kcbCouvert) ? a.kcbCouvert : null });
  return { fcEff, kd, kcbFull, kcb, kh, J, date: milieuMi };
}

/** Complète des réglages enregistrés avec les clés ajoutées depuis (compatibilité). */
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

/**
 * Dates de saison à vérifier : culture annuelle terminée depuis longtemps, ou dates d'une
 * culture pérenne très éloignées des dates proposées par défaut pour l'espèce.
 */
function alertesSaison(p, cult, today) {
  const st = p.config.stades;
  if (estAnnuel(cult)) {
    return st.fin < addDaysISO(today, -30)
      ? [`La culture saisie s’est terminée le ${dateFr(st.fin)} : le bilan affiche cette saison passée. Pour une nouvelle culture, mettez à jour les dates de la saison.`]
      : [];
  }
  const ref = stadesModele(cult, anneeDe(st.debut));
  const ecart = (a, b) => Math.abs(C.ecartJours(a, b));
  if (ecart(st.debut, ref.debut) <= 45 && ecart(st.fin, ref.fin) <= 45) return [];
  const lib = LIBELLES_STADES.perenne;
  return [`Dates de saison à vérifier : ${lib[0].toLowerCase()} le ${jourMois(st.debut)} et ${lib[4].toLowerCase()} le ${jourMois(st.fin)}, alors que les dates proposées par défaut pour cette espèce sont le ${jourMois(ref.debut)} et le ${jourMois(ref.fin)}. Si elles correspondent bien à vos observations, ignorez ce message.`];
}

/** Réserve utile de la parcelle (mm), réduite au volume humecté, et RFU. */
function calculRU(cfg) {
  const ruM = (finite(cfg.sol.ruParM) ? cfg.sol.ruParM : ruSol(cfg.sol)) * (1 - (cfg.sol.cailloux || 0) / 100);
  const fHum = cfg.irrigation.fractionHumectee ?? 1;
  const ruZone = ruM * cfg.culture.zr * fHum;
  return { ruM, ruZone, rfu: ruZone * cfg.culture.p, fHum };
}

function texteRU(cfg) {
  const { ruM, ruZone, rfu, fHum } = calculRU(cfg);
  const zr = cfg.culture.zr;
  return fHum < 1
    ? `Réserve utile : ${f1(ruM / 100)} mm/cm, soit ${f0(ruM * zr)} mm sur ${f2(zr)} m d’enracinement, dont ${f0(ruZone)} mm comptés dans le volume de sol humecté par l’irrigation (${pct(fHum)}) · RFU ≈ ${f0(rfu)} mm`
    : `Réserve utile : ${f1(ruM / 100)} mm/cm, soit ${f0(ruZone)} mm sur ${f2(zr)} m d’enracinement · RFU ≈ ${f0(rfu)} mm`;
}

/** Seuils d'irrigation en mm pour la parcelle (le mode choisi en gras). */
function texteSeuils(cfg, annuel) {
  const { ruZone, rfu, fHum } = calculRU(cfg);
  const st = cfg.strategie || {};
  const mode = st.mode || 'fao';
  // Seuil personnalisé pas encore réglé : valeur de départ du curseur (la RFU)
  const mad = finite(st.mad) ? st.mad : cfg.culture.p;
  const parts = [
    ['fao', `Standard : environ ${f0(rfu)} mm${st.ajusterP === false ? '' : ' (moins par forte chaleur, plus par temps frais)'}`],
    ['confort', `Confort : environ ${f0(rfu / 2)} mm`],
    ['perso', `Personnalisé : environ ${f0(ruZone * mad)} mm (${f0(mad * 100)} % de la RU)`]
  ];
  return `Pour cette parcelle (réserve ${fHum < 1 ? 'comptée dans le volume humecté' : 'utile'} ≈ ${f0(ruZone)} mm${annuel ? ' en pleine végétation' : ''}), un apport est calculé quand la culture a consommé : ${parts.map(([k, t]) => (k === mode ? `<b>${esc(t)}</b>` : esc(t))).join(' · ')}.`;
}

/** Description en clair d'une conduite : couverture du sol, hauteur, enracinement, coefficients. */
function decrireConduite(cult, cl) {
  const parts = [];
  if (cl.fc) parts.push(`sol ombragé par la végétation : ${plage(cl.fc, 0, 100)} %`);
  if (cl.h) parts.push(`hauteur : ${plage(cl.h)} m`);
  if (cl.zr) parts.push(`enracinement : ${plage(cl.zr)} m`);
  const k = cl.kc || { ini: cl.kcb.ini + 0.05, mid: cl.kcb.mid + 0.05, end: cl.kcb.end + 0.05 };
  parts.push(`coefficient cultural (Kc) : ${f2(k.ini)} au démarrage, ${f2(k.mid)} en pleine végétation, ${f2(k.end)} en fin de saison`);
  const txt = parts.join(' · ');
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

/** Date réelle ? (refuse le 31/02, le 32/13…) */
function dateValide(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return y > 1900 && y < 2200 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad2(m)}-${pad2(d)}` : null;
}

/** Date d'une cellule Excel (numéro de série, date ou texte jj/mm/aaaa) → AAAA-MM-JJ. */
function dateExcel(value) {
  if (typeof value === 'number' && window.XLSX?.SSF?.parse_date_code) {
    const d = window.XLSX.SSF.parse_date_code(value);
    return d ? dateValide(d.y, d.m, d.d) : null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // Midi pour ne pas changer de jour à cause des décalages horaires
    const t = new Date(value.getTime() + 12 * 3600e3);
    return dateValide(t.getFullYear(), t.getMonth() + 1, t.getDate());
  }
  const t = String(value ?? '').trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return dateValide(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) return dateValide(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  return null;
}

// ---------------------------------------------------------------------------
// Montage
// ---------------------------------------------------------------------------
export async function mount(root, ctx) {
  ctx.filters({ location: false, period: false });
  const today = todayISO();
  const store = creerStockage(ctx.supabase || null, storage);
  const S = {
    parcelles: [], id: storage.get('pilotage.courante', null), onglet: storage.get('pilotage.onglet', 'bilan'),
    annee: anneeDe(today), calc: null, irrigations: [], pluies: [], charge: false, erreur: null, token: 0,
    chart: null, toutVoir: false, brouillon: null, importLignes: null
  };
  if (!['bilan', 'saisies', 'parcelle', 'aide'].includes(S.onglet)) S.onglet = 'bilan';

  root.innerHTML = `<div class="pil">
    <div class="pil-bar">
      <label class="pil-parcelle"><span>Parcelle</span><select id="pil-parcelle" class="sam-input"></select></label>
      <button type="button" class="sam-button" data-action="nouvelle">＋ Nouvelle parcelle</button>
    </div>
    <div id="pil-mode" class="pil-alerte hidden"></div>
    <nav class="pil-tabs" role="tablist">
      <button type="button" role="tab" data-tab="bilan">Bilan</button>
      <button type="button" role="tab" data-tab="saisies">Irrigations et pluies</button>
      <button type="button" role="tab" data-tab="parcelle">Parcelle</button>
      <button type="button" role="tab" data-tab="aide">Aide</button>
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
    S.importLignes = null;
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
    if (S.onglet === 'bilan') renderBilan();
    try {
      const per = periodeBilan(p, S.annee, today);
      if (per.debut > per.fin) throw new Error('La période de calcul est vide : vérifiez la date de début du calcul et les dates de la saison.');
      const place = { latitude: p.latitude, longitude: p.longitude, altitude: p.altitude };
      const met = await chargerMeteo(place, per.debut, per.fin, { client: ctx.supabase, stationId: p.station_id, aujourdhui: today, cache: storage });
      if (token !== S.token) return;
      if (!met.jours.length) throw new Error('Aucune donnée météo pour cette période.');
      const corrections = new Map(S.pluies.map(r => [r.jour, Number(r.pluie_mm)]));
      const meteo = met.jours.map(j => (corrections.has(j.date) ? { ...j, pluieModele: j.pluie, pluie: corrections.get(j.date), origine: `${j.origine} + pluie mesurée` } : j));
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
        if (S.onglet === 'bilan') renderBilan();
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
      ? '<strong>Mode local.</strong> Les tables de la base ne sont pas encore installées (script <code>supabase/pilotage.sql</code>). Les parcelles saisies ici restent sur cet appareil.'
      : '';
    if (S.chart) { S.chart.destroy(); S.chart = null; }
    if (!courante() && S.onglet !== 'aide' && S.onglet !== 'parcelle') return renderVide();
    switch (S.onglet) {
      case 'saisies': return renderSaisies();
      case 'parcelle': return renderParcelle();
      case 'aide': return renderAide();
      default: return renderBilan();
    }
  }

  function renderVide() {
    panel.innerHTML = `<div class="pil-card pil-vide">
      <h2>Bilan irrigation</h2>
      <p>Créez une parcelle : espèce et conduite, sol, système d’irrigation et dates clés de la saison. L’outil calcule chaque jour l’eau disponible dans le sol et estime les apports d’irrigation des 7 prochains jours, en mm, en m³/ha et en durée de poste.</p>
      <div class="pil-actions">
        <button type="button" class="sam-button sam-button-primary" data-action="nouvelle">＋ Créer une parcelle</button>
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------------------
  // Onglet Bilan
  // ---------------------------------------------------------------------------
  function renderBilan() {
    if (S.onglet !== 'bilan') return;
    if (S.chart) { S.chart.destroy(); S.chart = null; }
    const p = courante();
    if (!p) return renderVide();
    const cult = parId(p.culture_id);
    const annees = estAnnuel(cult) ? [anneeDe(p.config.stades.debut)] : [0, 1, 2, 3].map(k => anneeDe(today) - k);
    const entete = `<div class="pil-head">
      <div><h2>${esc(p.nom)}</h2><p class="pil-muted">${esc(cult?.nom ?? '')} · ${esc(classeDe(cult, p.classe_id)?.nom ?? '')}${p.lieu ? ` · ${esc(p.lieu)}` : ''}</p></div>
      <label class="pil-inline">Saison <select id="pil-annee" class="sam-input"${annees.length < 2 ? ' disabled' : ''}>${annees.map(a => `<option value="${a}"${a === S.annee ? ' selected' : ''}>${a}</option>`).join('')}</select></label>
    </div>`;
    if (S.charge && !S.calc) {
      panel.innerHTML = `${entete}<div class="pil-card pil-attente"><span class="sam-spinner"></span> Calcul en cours (météo, évapotranspiration, réserve du sol)…</div>`;
      return;
    }
    if (S.erreur) {
      panel.innerHTML = `${entete}<div class="pil-card pil-erreur"><p><strong>Le bilan n’a pas pu être calculé.</strong> ${esc(S.erreur)}</p>
        <button type="button" class="sam-button" data-action="recalculer">Réessayer</button></div>`;
      return;
    }
    if (!S.calc) { panel.innerHTML = entete; return; }
    const { res, syn, per, param, met } = S.calc;
    const alertes = alertesSaison(p, cult, today);
    const blocAlertes = alertes.length
      ? `<div class="pil-alerte pil-alerte-saison">${alertes.map(a => `<p>${esc(a)}</p>`).join('')}<button type="button" class="sam-button" data-tab-go="parcelle">Modifier les dates</button></div>`
      : '';
    const double = res.parametres.options.methode !== 'simple';
    panel.innerHTML = `${entete}
      ${blocAlertes}
      ${per.enCours ? renderSituation(p, syn, res) : renderSaison(res)}
      <div class="pil-card">
        <div class="pil-card-head"><h3>Eau disponible dans le sol</h3><span class="pil-muted">${dateFr(per.debut)} → ${dateFr(per.fin)}${per.enCours ? ' · pointillés : prévision' : ''}</span></div>
        <div class="pil-chart"><canvas id="pil-canvas" aria-label="Eau disponible dans le sol"></canvas></div>
        <p class="pil-note">La courbe rouge montre l’eau que les racines peuvent encore prélever. Sous la ligne orange (seuil d’irrigation), la culture puise dans la réserve la plus difficile à extraire et commence à manquer d’eau. À zéro, la réserve utile est vide.</p>
      </div>
      <details class="pil-card" id="pil-details">
        <summary>Détail jour par jour</summary>
        <div class="pil-actions pil-actions-tight">
          <label class="pil-check"><input type="checkbox" id="pil-tout"${S.toutVoir ? ' checked' : ''}> Toute la période</label>
          <button type="button" class="sam-button" data-action="csv">Exporter (CSV)</button>
        </div>
        <div class="pil-table-wrap">${tableJours(res.jours, S.toutVoir)}</div>
        <p class="pil-note">Valeurs en mm. ET₀ : évapotranspiration de référence. Kc : coefficient du jour (consommation de la culture ÷ ET₀). ${double
          ? 'Transpiration : eau prélevée par les racines et rejetée par les feuilles. Évaporation du sol : eau perdue par la surface du sol mouillée, forte juste après une pluie ou une irrigation. ETc : consommation totale, transpiration + évaporation du sol.'
          : 'ETc : consommation d’eau de la culture, évaporation du sol comprise (méthode simplifiée).'} Eau disponible : ce qui reste dans la réserve utile (RU). Seuil : eau disponible au seuil d’irrigation.</p>
      </details>
      ${renderCalcul(p, param, met, res)}`;
    dessiner(res.jours, per.enCours ? today : null);
  }

  function renderSituation(p, syn, res) {
    const cfg = p.config;
    const irr = cfg.irrigation;
    const pluvio = irr.pluvio;
    const sys = systemeParId(irr.systeme);
    const ru = syn.taw;
    const dispo = finite(ru) ? ru - syn.drDebut : null;
    const marge = finite(syn.seuil) && finite(syn.drDebut) ? syn.seuil - syn.drDebut : null;
    const atteint = finite(marge) && marge <= 0;
    const avecPluvio = finite(pluvio) && pluvio > 0;
    const ligneApport = (net, brut) => {
      const d = IR.decouperPostes(brut, pluvio, irr.dureeMaxPoste);
      const duree = avecPluvio
        ? (d.postes > 1 ? ` · ${d.postes} postes de ${IR.formatDuree(d.dureeParPoste)}` : ` · ${IR.formatDuree(d.dureeTotale)} de poste`)
        : '';
      const vol = p.surface_ha ? ` · ${f0(IR.mmVersM3ha(brut) * p.surface_ha)} m³ pour ${f2(p.surface_ha)} ha` : '';
      return `<b>${f1(brut)} mm</b> (${f0(IR.mmVersM3ha(brut))} m³/ha)${duree}${vol}<br>
        <span class="pil-muted">dont ${f1(net)} mm utiles aux racines (efficience du réseau ${pct(irr.efficience)})${avecPluvio ? '' : ' · renseignez la pluviométrie du réseau pour obtenir la durée de poste'}</span>`;
    };
    let principal;
    if (syn.horsSaison && !syn.planifiees.length) {
      const st = S.calc.param.stades;
      const avant = today < st.debut;
      const annuel = estAnnuel(S.calc.param.cult);
      const lib = annuel ? LIBELLES_STADES.annuel : LIBELLES_STADES.perenne;
      principal = `<p class="pil-titre is-ok">Hors saison d’irrigation</p>
        <p class="pil-dose">${avant
          ? `La saison saisie commence le ${esc(dateLongue(st.debut))} (${esc(lib[0].toLowerCase())}).`
          : `La saison saisie s’est terminée le ${esc(dateLongue(st.fin))} (${esc(lib[4].toLowerCase())}).`} Aucun apport n’est calculé ; le bilan continue de suivre la recharge du sol par les pluies.</p>
        <p class="pil-muted">${avant ? '' : 'Hors saison, la culture transpire peu, mais après une pluie le sol mouillé évapore : le coefficient du jour peut alors monter jusqu’à 1,2 environ. '}${avant
          ? 'Si la culture a déjà démarré, corrigez la date de début de saison dans l’onglet Parcelle.'
          : 'Si la culture est encore en végétation, corrigez la date de fin de saison dans l’onglet Parcelle.'}</p>`;
    } else if (syn.planifiees.length || atteint) {
      const first = syn.planifiees[0];
      const titre = atteint ? 'Seuil d’irrigation atteint' : `Seuil d’irrigation atteint ${dateLongue(first.date)} (prévision)`;
      const saisieJour = S.irrigations.filter(r => r.jour === today).reduce((a, r) => a + Number(r.dose_brute_mm || 0), 0);
      const quand = !first ? '' : first.date === today ? 'Apport calculé pour aujourd’hui' : `Prochain apport calculé (${dateCourte(first.date)})`;
      principal = `<p class="pil-titre is-seuil">${esc(titre)}</p>
        ${saisieJour > 0 ? `<p class="pil-dose">Irrigation saisie aujourd’hui : ${f1(saisieJour)} mm.</p>` : ''}
        ${first ? `<p class="pil-dose">${esc(quand)} : ${ligneApport(first.net, first.brut)}</p>` : ''}`;
    } else {
      const fin = res.jours.find(j => j.date === syn.horizon);
      principal = `<p class="pil-titre is-ok">Seuil d’irrigation non atteint${syn.horizon ? ` d’ici ${esc(dateLongue(syn.horizon))}` : ''}</p>
        <p class="pil-dose">${fin ? `Il resterait ${f0(fin.taw - fin.dr)} mm d’eau disponible en fin de période.` : ''}</p>`;
    }
    // Apports identiques sur des jours consécutifs : une seule ligne « chaque jour du … au … »
    const groupes = [];
    for (const x of syn.planifiees) {
      const g = groupes[groupes.length - 1];
      if (g && Math.abs(g.brut - x.brut) < 0.05 && ecartJours(g.fin, x.date) === 1) { g.fin = x.date; g.n++; }
      else groupes.push({ debut: x.date, fin: x.date, brut: x.brut, n: 1 });
    }
    const liste = syn.planifiees.length > 1
      ? `<p class="pil-sous-titre">Apports calculés sur la période :</p><ul class="pil-plan">${groupes.map(g => `<li><span>${g.n > 1 ? `Chaque jour du ${esc(dateCourte(g.debut))} au ${esc(dateCourte(g.fin))}` : esc(dateCourte(g.debut))}</span><span>${f1(g.brut)} mm · ${f0(IR.mmVersM3ha(g.brut))} m³/ha${avecPluvio ? ` · ${IR.formatDuree(g.brut / pluvio)}` : ''}</span></li>`).join('')}</ul>`
      : '';
    const total = syn.besoinBrut;
    const quotidien = sys?.frequent && total > 0
      ? `<p class="pil-muted">Réparti sur les 8 jours : ${f1(total / 8)} mm par jour${avecPluvio ? `, soit ${IR.formatDuree(total / 8 / pluvio)} de poste par jour` : ''}.</p>`
      : '';
    const pluieTxt = syn.pluiePrevue > 0.2 ? `Pluie prévue : ${f1(syn.pluiePrevue)} mm.` : 'Pas de pluie notable prévue.';
    // Pluies annoncées au-delà de J+2 : prévision incertaine, signalée (elles sont comptées telles qu'annoncées)
    const limite = addDaysISO(today, 2);
    const lointaines = res.jours.filter(j => j.date > limite && (!syn.horizon || j.date <= syn.horizon) && j.pluie >= 0.5);
    const totalLoin = lointaines.reduce((s, j) => s + j.pluie, 0);
    const avertPluie = totalLoin >= 2
      ? `<p class="pil-pluie-loin"><b>Pluie annoncée à plus de 2 jours : ${f1(totalLoin)} mm</b> (${lointaines.map(j => `${esc(dateCourte(j.date))} : ${f1(j.pluie)} mm`).join(' ; ')}). À cette échéance, les prévisions de pluie sont peu fiables : la pluie peut tomber un autre jour, être plus faible ou ne pas tomber. Elle est comptée dans le calcul telle qu’annoncée ; chaque jour, le bilan est refait avec la pluie réellement tombée.</p>`
      : '';
    const ks = syn.ksAvant;
    const stress = niveauStress(ks);
    const jourJ = res.jours.find(j => j.date === syn.date);
    const coefTxt = decomposerCoef(jourJ, res.jours, res.parametres.options.methode);
    return `<div class="pil-grid">
      <div class="pil-card pil-situation">
        <p class="pil-kicker">Situation au ${esc(dateLongue(today))}</p>
        ${principal}
        ${liste}
        <p>Sur 8 jours (aujourd’hui à J+7) : <b>${f1(total)} mm</b> d’apports calculés (${f0(IR.mmVersM3ha(total))} m³/ha), pour une consommation de la culture de ${f1(syn.etcPrevue)} mm. ${esc(pluieTxt)}</p>
        ${avertPluie}
        ${quotidien}
        <p class="pil-avert">Estimation calculée à partir de la météo et des réglages de la parcelle, à confronter à l’observation de la culture et aux mesures de terrain (sondes, tensiomètres). La décision d’irriguer revient à l’exploitant.</p>
        <div class="pil-actions pil-actions-tight"><button type="button" class="sam-button" data-tab-go="saisies">Saisir une irrigation</button></div>
      </div>
      <div class="pil-kpis">
        <div class="pil-kpi"><span>Eau disponible dans le sol</span><b>${f0(dispo)} mm</b><small>${pct(syn.fractionRU)} de la réserve utile (RU : ${f0(ru)} mm)</small></div>
        <div class="pil-kpi ${atteint ? 'is-alerte' : ''}"><span>Marge avant le seuil d’irrigation</span><b>${atteint ? 'Seuil atteint' : `${f0(marge)} mm`}</b><small>le seuil est atteint quand il ne reste que ${f0(ru - syn.seuil)} mm</small></div>
        <div class="pil-kpi ${stress !== 'Aucun' ? 'is-alerte' : ''}"><span>Stress hydrique</span><b>${stress}</b><small>${stress !== 'Aucun' ? `transpiration réduite de ${f0((1 - ks) * 100)} % · ` : ''}${syn.joursStress7 ? `${syn.joursStress7} j de stress sur les 7 derniers` : 'aucun stress sur les 7 derniers jours'}</small></div>
        <div class="pil-kpi"><span>Consommation de la culture (7 derniers jours)</span><b>${f1(syn.etcPasse7)} mm</b><small>pluie ${f1(syn.pluiePasse7)} mm · irrigation ${f1(syn.irrigationPasse7)} mm</small></div>
        ${jourJ ? `<div class="pil-kpi pil-kpi-large"><span>Coefficient du jour (Kc)</span><b>${f2(jourJ.kc)}</b><small>${esc(coefTxt)}</small></div>` : ''}
      </div>
    </div>`;
  }

  function renderSaison(res) {
    const j = res.jours.filter(x => x.stade !== 'hors');
    const s = (arr, k) => arr.reduce((a, x) => a + (x[k] || 0), 0);
    const all = res.jours;
    return `<div class="pil-card"><h3>Bilan de la saison ${S.annee}</h3>
      <div class="pil-kpis pil-kpis-row">
        <div class="pil-kpi"><span>ET₀ (évapotranspiration de référence)</span><b>${f0(s(all, 'et0'))} mm</b><small>sur la période</small></div>
        <div class="pil-kpi"><span>Consommation de la culture</span><b>${f0(s(j, 'etcAct'))} mm</b><small>${f0(s(j, 'etcPot'))} mm sans manque d’eau</small></div>
        <div class="pil-kpi"><span>Pluie</span><b>${f0(s(all, 'pluie'))} mm</b><small>dont ${f0(s(all, 'dp'))} mm partis en profondeur</small></div>
        <div class="pil-kpi"><span>Irrigation saisie</span><b>${f0(s(all, 'irrigationBrute'))} mm</b><small>${f0(IR.mmVersM3ha(s(all, 'irrigationBrute')))} m³/ha · ${all.filter(x => x.stress && x.stade !== 'hors').length} j de stress</small></div>
      </div></div>`;
  }

  function renderCalcul(p, param, met, res) {
    const cfg = p.config;
    const comp = met.jours.filter(j => finite(j.et0OM) && finite(j.et0));
    const ecart = comp.length ? comp.reduce((s, j) => s + (j.et0 - j.et0OM), 0) / comp.length : null;
    const estim = met.jours.some(j => (j.estimations || []).length);
    const k = res.parametres.kcb;
    const st = param.stades;
    const annuel = estAnnuel(param.cult);
    const lib = annuel ? LIBELLES_STADES.annuel : LIBELLES_STADES.perenne;
    const sys = systemeParId(cfg.irrigation.systeme);
    const zr = cfg.culture.zr;
    const ruM = res.parametres.ruParM * (1 - (cfg.sol.cailloux || 0) / 100);
    const stationNom = p.station_id ? (ctx.stations.store.list.find(s => s.id === p.station_id)?.nom || p.station_id) : null;
    const apTxt = param.ap
      ? `<li>Coefficient de pleine végétation calculé d’après la couverture mesurée (${cfg.culture.ap.mesure === 'ombre'
        ? `${pct(cfg.culture.ap.fc)} du sol ombragé vers midi`
        : `${pct(cfg.culture.ap.fc)} du sol couvert par le feuillage, soit ${pct(param.ap.fcEff)} ombragé vers midi`}) : <b>${f2(param.ap.kcb)}</b>.</li>`
      : '';
    const opts = res.parametres.options;
    const seuilTxt = opts.mad !== null && opts.mad !== undefined
      ? (cfg.strategie?.mode === 'confort' ? 'confort (moitié de la RFU)' : `personnalisé (${pct(opts.mad)} de la RU consommée)`)
      : `standard (RFU${opts.ajusterP ? ' ajustée chaque jour à la chaleur' : ' fixe'})`;
    return `<details class="pil-card pil-hyp"><summary>Comment est fait le calcul</summary>
      <ul>
        <li><b>Météo</b> : ET₀ calculée chaque jour (formule de Penman-Monteith) à partir des données horaires d’Open-Meteo : réanalyse jusqu’à 8 jours avant aujourd’hui, prévisions ensuite. ${met.sources.station ? (met.sources.stationPluie ? `Températures, humidité et pluie mesurées par la station SAM ${esc(stationNom)} sur ${met.sources.station} jours.` : `Températures et humidité mesurées par la station SAM ${esc(stationNom)} sur ${met.sources.station} jours ; pluie d’Open-Meteo (pluviomètre de la station non affiché).`) : 'Aucune station SAM associée à la parcelle.'}${finite(ecart) ? ` Écart moyen avec l’ET₀ publiée par Open-Meteo : ${f2(ecart)} mm/j.` : ''}${estim ? ' Certaines données manquantes ont été estimées.' : ''}</li>
        <li><b>Culture</b> : coefficient de transpiration ${f2(k.ini)} au démarrage, ${f2(k.mi)} en pleine végétation, ${f2(k.fin)} en fin de saison${cfg.culture.kcbPerso ? ' (valeurs personnalisées)' : ''}${res.parametres.options.ajusterClimat ? ', ajusté au vent et à l’humidité du site' : ''}. ${cfg.methode === 'simple' ? 'Méthode simplifiée : un coefficient cultural unique.' : 'L’évaporation du sol est calculée à part, selon l’humidité de la surface.'}</li>
        ${apTxt}
        <li><b>Saison ${S.annee}</b> : ${lib.map((l, i) => `${esc(l.toLowerCase())} le ${dateFr([st.debut, st.finIni, st.finDev, st.finMi, st.fin][i])}`).join(' ; ')}.</li>
        <li><b>Sol</b> : ${esc(nomSol(cfg.sol.texture).toLowerCase())}, réserve utile ${f1(ruM / 100)} mm/cm, soit ${f0(ruM * zr)} mm sur ${f2(zr)} m d’enracinement${(cfg.irrigation.fractionHumectee ?? 1) < 1 ? `, dont ${pct(cfg.irrigation.fractionHumectee)} prise en compte (volume de sol humecté)` : ''}. RFU : ${pct(cfg.culture.p)} de la RU${opts.ajusterP ? ', ajustée chaque jour selon la chaleur' : ', fixe'}.</li>
        <li><b>Irrigation</b> : ${esc((sys?.nom ?? '').toLowerCase())}, ${pct(cfg.irrigation.fw)} du sol mouillé en surface, efficience du réseau ${pct(cfg.irrigation.efficience)}.</li>
        <li><b>Calcul des apports</b> : seuil ${esc(seuilTxt)}, remplissage visé ${pct(opts.cible)}${finite(opts.doseMaxNette) ? `, apport utile limité à ${f1(opts.doseMaxNette)} mm par jour` : ''}.</li>
        <li><b>Hypothèses</b> : ${finite(cfg.etatInitial) && cfg.etatInitial < 1 ? `réserve remplie à ${pct(cfg.etatInitial)}` : 'réserve pleine'} au début du calcul (${dateFr(S.calc.per.debut)}) ; sol humide en profondeur quand les racines progressent ; pluie prévue comptée telle qu’annoncée (incertaine au-delà de 2 à 3 jours) ; ni ruissellement ni remontée d’eau de la nappe.</li>
        <li><b>Méthode</b> : FAO-56 (FAO, édition 2025), méthode de référence internationale pour les besoins en eau des cultures.</li>
      </ul>
    </details>`;
  }

  function tableJours(jours, tout) {
    const debut = tout ? 0 : Math.max(0, jours.findIndex(j => j.date >= addDaysISO(today, -21)));
    const lignes = jours.slice(debut).reverse();
    const origines = new Map((S.calc?.meteo || []).map(m => [m.date, m.origine]));
    // Méthode détaillée : la consommation est séparée en transpiration et évaporation du sol
    const double = jours.some(j => finite(j.ke));
    return `<table class="pil-table">
      <thead><tr><th>Date</th><th>Stade</th><th>ET₀</th><th>Kc</th>${double ? '<th>Transpiration</th><th>Évaporation du sol</th>' : ''}<th>ETc</th><th>Pluie</th><th>Irrigation</th><th>Eau disponible</th><th>Seuil</th><th>Stress</th><th>Météo</th></tr></thead>
      <tbody>${lignes.map(j => `<tr class="${j.prevision ? 'is-prev' : ''}${j.stress ? ' is-stress' : ''}">
        <td>${esc(dateCourte(j.date))}</td><td>${NOMS_STADE[j.stade] || ''}</td><td>${f1(j.et0)}</td>
        <td${double && finite(j.kcb) ? ` title="${esc(`${f2(j.ks < 0.999 ? j.ks * j.kcb : j.kcb)} transpiration + ${f2(j.ke)} évaporation du sol`)}"` : ''}>${f2(j.kc)}</td>
        ${double ? `<td>${f1(j.transpiration)}</td><td>${f1(j.evaporation)}</td>` : ''}
        <td>${f1(j.etcAct)}</td>
        <td>${j.pluie ? f1(j.pluie) : ''}</td>
        <td>${j.irrigationBrute ? `${f1(j.irrigationBrute)}${j.planifiee ? ' <em>calcul</em>' : ''}` : ''}</td>
        <td>${f0(j.taw - j.dr)} / ${f0(j.taw)}</td><td>${f0(j.taw - j.seuil)}</td><td class="pil-stress">${j.stress ? niveauStress(j.ks).toLowerCase() : ''}</td>
        <td class="pil-muted">${esc(origines.get(j.date) ?? '')}</td></tr>`).join('')}</tbody></table>`;
  }

  function exporterCsv() {
    if (!S.calc) return;
    const { res, meteo, p } = S.calc;
    const m = new Map(meteo.map(x => [x.date, x]));
    const cols = [
      ['date', j => j.date], ['prevision', j => (j.prevision ? 1 : 0)], ['stade', j => NOMS_STADE[j.stade]],
      ['t_max', j => m.get(j.date)?.tmax], ['t_min', j => m.get(j.date)?.tmin], ['hr_min', j => m.get(j.date)?.hrmin], ['vent_2m', j => m.get(j.date)?.u2], ['rayonnement_MJ', j => m.get(j.date)?.rs],
      ['et0', j => j.et0], ['et0_open_meteo', j => m.get(j.date)?.et0OM], ['source_meteo', j => m.get(j.date)?.origine],
      ['pluie', j => j.pluie], ['irrigation_apportee', j => j.irrigationBrute], ['irrigation_utile', j => j.irrigationNette], ['apport_calcule', j => (j.planifiee ? 1 : 0)],
      ['coef_transpiration', j => j.kcb], ['kc_maximal', j => j.kcMax], ['couverture_sol', j => j.fc], ['sol_evaporant', j => j.few], ['reduction_evaporation', j => j.kr], ['coef_evaporation_sol', j => j.ke], ['coef_stress_1_sans_stress', j => j.ks], ['kc_reel', j => j.kc],
      ['hauteur', j => j.h], ['enracinement', j => j.zr], ['RU', j => j.taw], ['part_RFU', j => j.p], ['RFU', j => j.raw], ['seuil', j => j.seuil],
      ['deficit_surface', j => j.de], ['eau_consommee_RU', j => j.dr], ['eau_disponible', j => j.taw - j.dr], ['percolation', j => j.dp], ['ETc_sans_stress', j => j.etcPot], ['ETc_reelle', j => j.etcAct], ['transpiration', j => j.transpiration], ['evaporation', j => j.evaporation]
    ];
    const cell = v => (v === null || v === undefined ? '' : typeof v === 'number' ? String(+v.toFixed(4)).replace('.', ',') : `"${String(v).replace(/"/g, '""')}"`);
    const csv = [cols.map(c => c[0]).join(';'), ...res.jours.map(j => cols.map(c => cell(c[1](j))).join(';'))].join('\n');
    const blob = new Blob([`﻿# Bilan irrigation SAM — ${p.nom} — saison ${S.annee}\n${csv}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bilan_irrigation_${p.nom.replace(/[^\w-]+/g, '_')}_${S.annee}.csv`;
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
    const calcul = jours.map(j => (j.planifiee ? +j.planifiee.brut.toFixed(1) : null));
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
          { type: 'line', label: 'Eau disponible dans le sol', data: reserve, borderColor: '#c5011a', backgroundColor: 'rgba(197,1,26,.08)', fill: 'origin', borderWidth: 2.2, pointRadius: 0, tension: 0.15, yAxisID: 'y', order: 1,
            segment: { borderDash: c => (prev(c.p1DataIndex) ? [6, 4] : undefined) } },
          { type: 'line', label: 'Réserve utile (sol plein)', data: jours.map(j => +j.taw.toFixed(1)), borderColor: '#6b717b', borderWidth: 1.4, pointRadius: 0, yAxisID: 'y', order: 2 },
          { type: 'line', label: 'Seuil d’irrigation', data: jours.map(j => +(j.taw - j.seuil).toFixed(1)), borderColor: '#e08a00', borderDash: [5, 4], borderWidth: 1.6, pointRadius: 0, yAxisID: 'y', order: 3 },
          { type: 'bar', label: 'Pluie', data: pluie, backgroundColor: 'rgba(43,121,194,.65)', yAxisID: 'y2', order: 5, barPercentage: 1, categoryPercentage: 0.9 },
          { type: 'bar', label: 'Irrigation saisie', data: irrig, backgroundColor: 'rgba(46,125,50,.8)', yAxisID: 'y2', order: 4, barPercentage: 1, categoryPercentage: 0.9 },
          { type: 'bar', label: 'Apport calculé', data: calcul, backgroundColor: 'rgba(87,165,61,.35)', borderColor: '#2e7d32', borderWidth: 1, yAxisID: 'y2', order: 4, barPercentage: 1, categoryPercentage: 0.9 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 14, font: { size: 12 } } },
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
    const irr = p.config.irrigation;
    const pluvio = irr.pluvio;
    const avecPluvio = finite(pluvio) && pluvio > 0;
    const liste = [...S.irrigations].sort((a, b) => b.jour.localeCompare(a.jour));
    const pl = [...S.pluies].sort((a, b) => b.jour.localeCompare(a.jour));
    const total = liste.reduce((s, r) => s + Number(r.dose_brute_mm || 0), 0);
    const unites = `<option value="mm">mm</option><option value="m3ha">m³/ha</option>
      <option value="heures"${avecPluvio ? '' : ' disabled'}>heures de poste${avecPluvio ? ` (${f2(pluvio)} mm/h)` : ' (pluviométrie à renseigner)'}</option>`;
    panel.innerHTML = `<div class="pil-grid pil-grid-2">
      <form class="pil-card" id="pil-form-irr" autocomplete="off">
        <h3>Ajouter une irrigation</h3>
        <div class="pil-fields">
          <label class="sam-field">Date<input type="date" name="jour" value="${today}" max="${addDaysISO(today, 7)}" required></label>
          <label class="sam-field">Quantité apportée<input name="valeur" inputmode="decimal" placeholder="ex. 12" required></label>
          <label class="sam-field">Unité<select name="unite" class="sam-input">${unites}</select></label>
        </div>
        <details class="pil-sub"><summary>Même apport sur plusieurs jours (goutte-à-goutte, micro-aspersion)</summary>
          <div class="pil-fields">
            <label class="sam-field">Jusqu’au<input type="date" name="jusqu" max="${addDaysISO(today, 7)}"></label>
            <label class="sam-field">Tous les (jours)<input name="pas" inputmode="numeric" value="1"></label>
          </div>
        </details>
        <label class="sam-field">Note<input name="note" maxlength="200" placeholder="facultatif"></label>
        <p class="pil-aide" id="pil-irr-apercu">Indiquez l’eau apportée par le réseau. La part utile aux racines est calculée avec l’efficience du réseau (${pct(irr.efficience)}).</p>
        <div class="pil-actions"><button type="submit" class="sam-button sam-button-primary">Enregistrer</button></div>
        <p class="sam-form-message" id="pil-irr-msg"></p>
      </form>
      <div class="pil-card" id="pil-import">
        <h3>Importer un fichier Excel</h3>
        <p class="pil-aide">Fichier .xlsx ou .xls avec deux colonnes : <b>Date</b> et <b>Apport</b>. Une ligne par irrigation, les dates peuvent couvrir toute l’année.</p>
        <div class="pil-fields">
          <label class="sam-field pil-large">Fichier Excel<input type="file" id="pil-import-fichier" accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"></label>
          <label class="sam-field">Unité de la colonne Apport<select id="pil-import-unite" class="sam-input">${unites}</select></label>
        </div>
        <div id="pil-import-apercu"></div>
        <p class="sam-form-message" id="pil-import-msg"></p>
      </div>
    </div>
    <div class="pil-grid pil-grid-2">
      <div class="pil-card">
        <div class="pil-card-head"><h3>Irrigations enregistrées <span class="pil-muted">(${liste.length}${liste.length ? ` · ${f0(total)} mm` : ''})</span></h3>
          ${liste.length ? '<button type="button" class="sam-button pil-danger" data-action="suppr-toutes-irr">Tout supprimer</button>' : ''}</div>
        ${liste.length ? `<div class="pil-table-wrap pil-liste"><table class="pil-table"><thead><tr><th>Date</th><th>Apport (mm)</th><th>m³/ha</th><th>Saisie</th><th></th></tr></thead><tbody>
          ${liste.map(r => `<tr><td>${esc(dateCourte(r.jour))}</td><td>${f1(Number(r.dose_brute_mm))}</td><td>${f0(IR.mmVersM3ha(Number(r.dose_brute_mm)))}</td>
            <td class="pil-muted">${esc(r.saisie ? `${f2(r.saisie.valeur)} ${r.saisie.unite === 'm3ha' ? 'm³/ha' : r.saisie.unite === 'heures' ? 'h' : 'mm'}` : '')}${r.note ? ` · ${esc(r.note)}` : ''}</td>
            <td><button type="button" class="pil-suppr" data-action="suppr-irr" data-id="${esc(r.id)}" aria-label="Supprimer">✕</button></td></tr>`).join('')}
        </tbody></table></div>` : '<p class="pil-muted">Aucune irrigation enregistrée.</p>'}
      </div>
      <div>
        <form class="pil-card" id="pil-form-pluie" autocomplete="off">
          <h3>Pluie mesurée sur la parcelle</h3>
          <p class="pil-aide">Relevé de votre pluviomètre : il remplace la pluie de la météo (Open-Meteo ou station) pour ce jour.</p>
          <div class="pil-fields">
            <label class="sam-field">Date<input type="date" name="jour" value="${addDaysISO(today, -1)}" max="${today}" required></label>
            <label class="sam-field">Pluie (mm)<input name="mm" inputmode="decimal" required></label>
          </div>
          <div class="pil-actions"><button type="submit" class="sam-button">Enregistrer</button></div>
          <p class="sam-form-message" id="pil-pluie-msg"></p>
        </form>
        <div class="pil-card"><h3>Pluies mesurées <span class="pil-muted">(${pl.length})</span></h3>
          ${pl.length ? `<table class="pil-table"><thead><tr><th>Date</th><th>Pluie (mm)</th><th></th></tr></thead><tbody>
            ${pl.map(r => `<tr><td>${esc(dateCourte(r.jour))}</td><td>${f1(Number(r.pluie_mm))}</td><td><button type="button" class="pil-suppr" data-action="suppr-pluie" data-id="${esc(r.id)}" aria-label="Supprimer">✕</button></td></tr>`).join('')}
          </tbody></table>` : '<p class="pil-muted">Aucun relevé.</p>'}
        </div>
      </div>
    </div>`;
    const formIrr = $('#pil-form-irr');
    const aideDefaut = $('#pil-irr-apercu').textContent;
    formIrr.addEventListener('input', () => {
      const brut = IR.brutDepuisSaisie({ unite: formIrr.unite.value, valeur: num(formIrr.valeur.value), pluvioMmH: pluvio });
      $('#pil-irr-apercu').textContent = finite(brut)
        ? `Soit ${f1(brut)} mm (${f0(IR.mmVersM3ha(brut))} m³/ha), dont ${f1(IR.netDepuisBrut(brut, irr.efficience))} mm utiles aux racines${avecPluvio ? ` · ${IR.formatDuree(brut / pluvio)} de poste` : ''}.`
        : aideDefaut;
    });
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
    $('#pil-import-fichier').addEventListener('change', lireImport);
    $('#pil-import-unite').addEventListener('change', () => { if ($('#pil-import-fichier').files?.length) lireImport(); });
  }

  /** Lecture du fichier Excel d'irrigations (colonnes Date et Apport) et aperçu avant import. */
  async function lireImport() {
    const p = courante();
    const input = $('#pil-import-fichier');
    const msg = $('#pil-import-msg');
    const zone = $('#pil-import-apercu');
    S.importLignes = null;
    zone.innerHTML = '';
    msg.textContent = '';
    msg.classList.remove('is-error');
    const file = input.files?.[0];
    if (!file) return;
    try { await ctx.vendor.xlsx(); } catch { /* message ci-dessous */ }
    if (!window.XLSX) { msg.textContent = 'Le module Excel n’a pas pu être chargé.'; msg.classList.add('is-error'); return; }
    try {
      // Sans cellDates : les dates arrivent en numéro de série, converties sans décalage horaire
      const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = window.XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
      if (!raw.length) throw new Error('Le fichier ne contient aucune ligne.');
      const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const entetes = Object.keys(raw[0]);
      const cleDate = entetes.find(h => ['date', 'dateirrigation', 'jour'].includes(norm(h)));
      const cleApport = entetes.find(h => ['apport', 'apportmm', 'irrigation', 'irrigationmm', 'quantite', 'quantitemm', 'mm', 'dose', 'dosemm', 'apportm3ha', 'm3ha', 'volume', 'volumem3ha', 'duree', 'dureeh', 'heures'].includes(norm(h)));
      if (!cleDate || !cleApport) throw new Error('Le fichier doit contenir une colonne « Date » et une colonne « Apport ».');
      // Unité devinée d'après l'en-tête de colonne, sinon celle choisie dans la liste
      const nh = norm(cleApport);
      const sel = $('#pil-import-unite');
      if (/m3/.test(nh) || nh === 'volume') sel.value = 'm3ha';
      else if (/duree|heure/.test(nh) && !sel.querySelector('option[value="heures"]').disabled) sel.value = 'heures';
      const unite = sel.value;
      const pluvio = p.config.irrigation.pluvio;
      const valides = [];
      const erreurs = [];
      raw.forEach((row, i) => {
        const jour = dateExcel(row[cleDate]);
        const valeur = num(row[cleApport]);
        if (row[cleDate] === null && row[cleApport] === null) return;
        if (!jour) { erreurs.push(`ligne ${i + 2} : date illisible`); return; }
        const brut = IR.brutDepuisSaisie({ unite, valeur, pluvioMmH: pluvio });
        if (!finite(brut) || brut < 0 || brut > 500) { erreurs.push(`ligne ${i + 2} : apport invalide`); return; }
        if (brut === 0) return;
        valides.push({ parcelle_id: p.id, jour, dose_brute_mm: +brut.toFixed(2), saisie: { unite, valeur, pluvio: unite === 'heures' ? pluvio : null }, note: 'Import Excel' });
      });
      if (!valides.length) throw new Error(erreurs[0] ? `Aucune irrigation valide (${erreurs[0]}).` : 'Aucune irrigation valide à importer.');
      const existants = new Set(S.irrigations.map(r => `${r.jour}|${(+Number(r.dose_brute_mm).toFixed(1))}`));
      const nouveaux = valides.filter(r => !existants.has(`${r.jour}|${+r.dose_brute_mm.toFixed(1)}`));
      const doublons = valides.length - nouveaux.length;
      S.importLignes = nouveaux;
      const dates = valides.map(r => r.jour).sort();
      const total = nouveaux.reduce((s, r) => s + r.dose_brute_mm, 0);
      zone.innerHTML = `<div class="pil-import-apercu">
        <p><b>${valides.length} irrigation${valides.length > 1 ? 's' : ''} lue${valides.length > 1 ? 's' : ''}</b> du ${dateFr(dates[0])} au ${dateFr(dates[dates.length - 1])}${nouveaux.length ? ` · ${nouveaux.length} à importer, total ${f1(total)} mm (${f0(IR.mmVersM3ha(total))} m³/ha)` : ''}.</p>
        ${doublons ? `<p class="pil-muted">${doublons} déjà enregistrée${doublons > 1 ? 's' : ''} (même date, même apport) : ignorée${doublons > 1 ? 's' : ''}.</p>` : ''}
        ${erreurs.length ? `<p class="pil-muted">${erreurs.length} ligne${erreurs.length > 1 ? 's' : ''} ignorée${erreurs.length > 1 ? 's' : ''} : ${esc(erreurs.slice(0, 3).join(' ; '))}${erreurs.length > 3 ? '…' : ''}.</p>` : ''}
        ${nouveaux.length ? '<div class="pil-actions pil-actions-tight"><button type="button" class="sam-button sam-button-primary" data-action="importer">Importer ces irrigations</button><button type="button" class="sam-button" data-action="annuler-import">Annuler</button></div>' : ''}
      </div>`;
    } catch (error) {
      msg.textContent = error.message || 'Lecture du fichier impossible.';
      msg.classList.add('is-error');
    }
  }

  async function importer() {
    const p = courante();
    if (!p || !S.importLignes?.length) return;
    const n = S.importLignes.length;
    await store.ajouterIrrigations(S.importLignes);
    S.importLignes = null;
    S.irrigations = await store.irrigations(p.id);
    ctx.ui.toast(`${n} irrigation${n > 1 ? 's' : ''} importée${n > 1 ? 's' : ''}`);
    renderSaisies();
    calculer();
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
    // Sections repliables ouvertes : elles le restent quand le formulaire est redessiné
    const ouverts = new Set([...panel.querySelectorAll('#pil-form details[data-cle][open]')].map(x => x.dataset.cle));
    const ouvert = cle => (ouverts.has(cle) ? ' open' : '');
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
    const ap = cfg.culture.ap || {};
    // Réglages antérieurs au choix de la mesure, déjà activés : feuillage vu du dessus (calcul d'origine)
    const apMesure = ap.mesure || (ap.actif ? 'feuillage' : 'ombre');
    const apRangs = ap.forme === 'rangs';
    const rel = ap.releve || {};
    const strat = cfg.strategie || {};
    const mode = strat.mode || 'fao';
    const paille = cfg.paillage?.type && cfg.paillage.type !== 'aucun';
    const opt = (v, cur, label, extra = '') => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}${extra}>${esc(label)}</option>`;
    const n = (v, dgt = 2) => (finite(v) ? String(+v.toFixed(dgt)).replace('.', ',') : '');
    const cache = visible => (visible ? '' : ' hidden');
    /** Pourcentage : réglette et case de saisie liées (la case porte le nom lu par le formulaire). */
    const curseur = (name, label, val, { min = 0, max = 100, step = 1, aide = '', id = '', classe = '' } = {}) => {
      const v = finite(val) ? val : null;
      return `<label class="sam-field pil-curseur${classe}"${id ? ` id="${id}"` : ''}>${esc(label)}
        <span class="pil-curseur-ligne">
          <input type="range" min="${min}" max="${max}" step="${step}" value="${v ?? min}" data-cible="${name}" aria-label="${esc(label)}">
          <span class="pil-curseur-nb"><input name="${name}" inputmode="decimal" value="${v === null ? '' : n(v, 1)}" aria-label="${esc(label)} (valeur)"><span>%</span></span>
        </span>${aide ? `<small class="pil-aide">${aide}</small>` : ''}</label>`;
    };
    const especes = Object.entries(FAMILLES).map(([k, v]) => {
      const liste = CULTURES.filter(c => c.famille === k);
      return liste.length ? `<optgroup label="${esc(v)}">${liste.map(c => opt(c.id, cult.id, c.nom)).join('')}</optgroup>` : '';
    }).join('');
    const aideConduite = annuel
      ? 'La conduite précise le type de production (par exemple tomate d’industrie ou de marché). Elle fixe les coefficients de besoin en eau de la culture.'
      : `La conduite décrit l’âge et la forme de la plantation, le nombre ${cult.famille === 'vigne' ? 'de pieds' : cult.id === 'kiwi' || cult.id === 'myrtillier' || cult.id === 'ronce' || cult.id === 'houblon' ? 'de plants' : 'd’arbres'} par hectare et le développement de la végétation (couverture : part du sol ombragée par le feuillage). Elle fixe les coefficients de besoin en eau.`;
    const gddOptions = (cult.gdd || []).map((g, i) => opt(i, 0, `${g.type} — ${f0(g.total)} degrés-jours`)).join('');
    const plageSys = (r, unite = ' %') => (r[0] === r[1] ? `${f0(r[0] * 100)}${unite}` : `${f0(r[0] * 100)} à ${f0(r[1] * 100)}${unite}`);

    // Couverture mesurée : aide et champs de relevé selon la mesure et la forme
    const aideMesure = apMesure === 'ombre'
      ? (apRangs
        ? 'Par temps ensoleillé, en pleine végétation, vers 13 h 30 – 14 h en été (heure légale, soleil au plus haut) : mesurez la largeur de la bande d’ombre au sol, perpendiculairement au rang, à plusieurs endroits. Part ombragée = largeur de l’ombre ÷ inter-rang.'
        : 'Par temps ensoleillé, en pleine végétation, vers 13 h 30 – 14 h en été (heure légale, soleil au plus haut) : mesurez le diamètre moyen de l’ombre d’un arbre. Part ombragée = surface de l’ombre ÷ surface occupée par un arbre (distance sur le rang × inter-rang).')
      : (apRangs
        ? 'Mesurez la largeur moyenne du feuillage et l’inter-rang (part couverte = largeur ÷ inter-rang), ainsi que la hauteur du feuillage. L’outil en déduit l’ombre de midi selon l’orientation des rangs et la hauteur du soleil.'
        : 'Mesurez le diamètre moyen de la couronne vue du dessus, la distance entre arbres sur le rang et l’inter-rang. L’outil en déduit l’ombre de midi selon la hauteur du soleil.');
    const interDefaut = finite(rel.interRang) ? rel.interRang : loc.interRang;
    const champsReleve = apRangs
      ? `${apMesure === 'ombre'
          ? `<label class="sam-field">Largeur de l’ombre (m)<input name="apRelLarg" inputmode="decimal" value="${n(rel.largeur)}"></label>`
          : `<label class="sam-field">Largeur du feuillage (m)<input name="apLarg" inputmode="decimal" value="${n(ap.largeur)}"></label>`}
        <label class="sam-field">Inter-rang (m)<input name="apRelInter" inputmode="decimal" value="${n(interDefaut)}"></label>`
      : `<label class="sam-field">Diamètre ${apMesure === 'ombre' ? 'de l’ombre d’un arbre' : 'de la couronne'} (m)<input name="apRelDiam" inputmode="decimal" value="${n(rel.diametre)}"></label>
        <label class="sam-field">Distance entre arbres sur le rang (m)<input name="apRelEsp" inputmode="decimal" value="${n(rel.espacement)}"></label>
        <label class="sam-field">Inter-rang (m)<input name="apRelInter" inputmode="decimal" value="${n(interDefaut)}"></label>`;

    const aideMethode = 'Détaillée : sépare chaque jour la transpiration de la culture et l’évaporation du sol, forte juste après une pluie ou une irrigation puis de plus en plus faible. Simplifiée : un coefficient moyen par stade, évaporation du sol comprise. L’écart est plus marqué en goutte-à-goutte (sol peu mouillé : la méthode simplifiée compte trop d’évaporation), en jeune plantation et après des pluies.';
    const aideHumecte = `En goutte-à-goutte, seul un « bulbe » de sol autour des goutteurs est mouillé et les racines actives s’y concentrent : la réserve à prendre en compte est celle de ce volume. Une valeur plus faible donne des apports plus petits et plus fréquents. 100 % : tout le sol compte (aspersion).${sys ? ` Valeur courante pour ce système : ${plageSys(sys.humecte)} (à vérifier par un profil de sol ou des sondes).` : ''}`;
    const aideFw = `Part de la surface du sol mouillée à chaque irrigation. Elle sert seulement au calcul de l’évaporation du sol, pas à la réserve.${sys ? ` Valeur courante pour ce système : ${plageSys(sys.fw)}.` : ''}`;

    panel.innerHTML = `<form id="pil-form" class="pil-form" autocomplete="off" novalidate>
      <div class="pil-card pil-form-head">
        <h2>${d.id ? `Réglages — ${esc(d.nom)}` : 'Nouvelle parcelle'}</h2>
        <div class="pil-actions">
          ${d.id ? '<button type="button" class="sam-button" data-action="dupliquer">Dupliquer</button><button type="button" class="sam-button pil-danger" data-action="supprimer">Supprimer</button>' : ''}
          <button type="submit" class="sam-button sam-button-primary">Enregistrer</button>
        </div>
        <p class="sam-form-message" id="pil-form-msg"></p>
      </div>

      <fieldset class="pil-card"><legend>Parcelle</legend>
        <div class="pil-fields">
          <label class="sam-field">Nom de la parcelle<input name="nom" value="${esc(d.nom)}" required maxlength="80" placeholder="ex. Gala — bloc 3"></label>
          <label class="sam-field">Surface (ha)<input name="surface_ha" inputmode="decimal" value="${n(d.surface_ha, 3)}" placeholder="facultatif"><small class="pil-aide">Pour obtenir les volumes en m³.</small></label>
          <label class="sam-field pil-lieu">Commune<input name="lieu" value="${esc(d.lieu || '')}" placeholder="Rechercher une commune…"><div class="pil-lieu-res" id="pil-lieu-res"></div></label>
          <label class="sam-field">Latitude (°)<input name="latitude" inputmode="decimal" value="${n(d.latitude, 4)}" required></label>
          <label class="sam-field">Longitude (°)<input name="longitude" inputmode="decimal" value="${n(d.longitude, 4)}" required></label>
          <label class="sam-field">Altitude (m)<input name="altitude" inputmode="decimal" value="${n(d.altitude, 0)}" placeholder="automatique"></label>
          <label class="sam-field pil-large">Station météo SAM (facultatif)<select name="station_id" class="sam-input">${opt('', d.station_id || '', 'Aucune : météo Open-Meteo seule')}${stations.map(s => opt(s.id, d.station_id || '', `${s.nom}${s.commune ? ` (${s.commune})` : ''}`)).join('')}</select><small class="pil-aide">Les températures, l’humidité et la pluie mesurées par la station remplacent celles d’Open-Meteo.</small></label>
        </div>
        <div class="pil-actions pil-actions-tight"><button type="button" class="sam-button" data-action="gps">Utiliser ma position</button></div>
      </fieldset>

      <fieldset class="pil-card"><legend>Culture</legend>
        <div class="pil-fields">
          <label class="sam-field">Espèce<select name="culture_id" class="sam-input">${especes}</select></label>
          <label class="sam-field pil-pleine">Conduite<select name="classe_id" class="sam-input">${cult.classes.map(c => opt(c.id, cl.id, c.nom)).join('')}</select></label>
        </div>
        <p class="pil-aide">${esc(aideConduite)}</p>
        <p class="pil-ref">${esc(decrireConduite(cult, cl))}</p>
        <div class="pil-fields">
          <label class="sam-field">Profondeur d’enracinement (m)<input name="zr" inputmode="decimal" value="${n(cfg.culture.zr)}"><small class="pil-aide">${annuel ? 'Profondeur atteinte en pleine végétation.' : 'Non fournie par la méthode pour les arbres et la vigne : 0,8 m par défaut, à ajuster (fosse, sondes).'}</small></label>
          <label class="sam-field">Hauteur de la culture (m)<input name="h" inputmode="decimal" value="${n(cfg.culture.h)}"></label>
        </div>
        <details class="pil-sub" data-cle="culture"${ouvert('culture')}><summary>Réglages avancés de la culture</summary>
          <div class="pil-fields">
            ${curseur('p', 'RFU (% de la RU)', cfg.culture.p * 100, { min: 10, max: 90, aide: `Part de la réserve utile que la culture prélève sans difficulté.${finite(cult.p?.p) ? ` Valeur de référence : ${f0(cult.p.p * 100)} %.` : ''}` })}
            ${annuel ? `<label class="sam-field">Enracinement au semis (m)<input name="zrMin" inputmode="decimal" value="${n(cfg.culture.zrMin)}"></label>` : ''}
            <label class="sam-field">Coefficient hors saison<input name="kcbHorsSaison" inputmode="decimal" value="${n(cfg.culture.kcbHorsSaison)}"><small class="pil-aide">${annuel ? 'Avant le semis et après la récolte (sol nu : 0,15).' : 'Avant le débourrement et après la chute des feuilles (sol nu ou enherbé).'}</small></label>
            <label class="sam-field pil-large">Méthode de calcul<select name="methode" class="sam-input">${opt('double', cfg.methode, 'Détaillée : transpiration et évaporation du sol séparées')}${cl.kc ? opt('simple', cfg.methode, 'Simplifiée : coefficient cultural unique (Kc)') : ''}</select><small class="pil-aide">${esc(aideMethode)}</small></label>
          </div>
          ${!finite(cult.p?.p) && cult.p?.txt ? '<p class="pil-note">Pas de valeur de référence de RFU pour cette culture : saisissez-en une adaptée.</p>' : ''}
          <label class="pil-check"><input type="checkbox" name="ajusterClimat"${cfg.culture.ajusterClimat !== false ? ' checked' : ''}> Ajuster les coefficients au vent et à l’humidité du site</label>
          <div class="pil-sub2">
            <label class="pil-check"><input type="checkbox" name="kcbPersoActif" data-bascule="pil-bloc-kcb"${cfg.culture.kcbPerso ? ' checked' : ''}> Coefficients de transpiration personnalisés (calage local)</label>
            <div id="pil-bloc-kcb" class="pil-bascule${cache(!!cfg.culture.kcbPerso)}">
              <p class="pil-aide">Pour remplacer les coefficients de la conduite par des valeurs établies sur vos parcelles (essais, mesures).</p>
              <div class="pil-fields">
                <label class="sam-field">Au démarrage<input name="kcbIni" inputmode="decimal" value="${n(cfg.culture.kcbPerso?.ini ?? cl.kcb.ini)}"></label>
                <label class="sam-field">En pleine végétation<input name="kcbMi" inputmode="decimal" value="${n(cfg.culture.kcbPerso?.mi ?? cl.kcb.mid)}"></label>
                <label class="sam-field">En fin de saison<input name="kcbFin" inputmode="decimal" value="${n(cfg.culture.kcbPerso?.fin ?? cl.kcb.end)}"></label>
              </div>
            </div>
          </div>
          <div class="pil-sub2">
            <label class="pil-check"><input type="checkbox" name="apActif" data-bascule="pil-bloc-ap"${ap.actif ? ' checked' : ''}> Calculer le coefficient de pleine végétation d’après la couverture mesurée</label>
            <div id="pil-bloc-ap" class="pil-bascule${cache(!!ap.actif)}">
              <p class="pil-aide">Pour une plantation plus ou moins développée que la conduite choisie : le coefficient de pleine végétation est calculé d’après la part du sol couverte par le feuillage, sa densité et sa hauteur.</p>
              <div class="pil-fields">
                <label class="sam-field pil-large">Mesure disponible<select name="apMesure" class="sam-input">${opt('ombre', apMesure, 'Ombre au sol vers midi (le plus simple)')}${opt('feuillage', apMesure, 'Dimensions du feuillage, vu du dessus')}</select></label>
                <label class="sam-field pil-large">Forme<select name="apForme" class="sam-input">${opt('arbres', ap.forme, 'Arbres isolés')}${opt('rangs', ap.forme, 'Rangs (haie fruitière, vigne palissée)')}</select></label>
              </div>
              <div class="pil-mesure">
                <p class="pil-aide">${esc(aideMesure)}</p>
                <div class="pil-fields">${champsReleve}</div>
                <p class="pil-aide" id="pil-ap-resultat" aria-live="polite"></p>
              </div>
              <div class="pil-fields">
                ${curseur('apFc', apMesure === 'ombre' ? 'Sol ombragé vers midi (%)' : 'Sol couvert par le feuillage, vu du dessus (%)', (ap.fc ?? 0.5) * 100, { min: 1, max: 100, aide: 'Calculé à partir des mesures ci-dessus, ou à saisir directement.' })}
                ${apMesure === 'feuillage' && apRangs ? `
                  <label class="sam-field">Hauteur du feuillage (m)<input name="apHaut" inputmode="decimal" value="${n(ap.hauteurCanopee)}"><small class="pil-aide">Partie garnie de feuilles, sans le tronc.</small></label>
                  <label class="sam-field">Orientation des rangs<select name="apAngle" class="sam-input">${opt(90, ap.angleRang, 'Nord-sud')}${opt(45, ap.angleRang, 'Nord-est / sud-ouest')}${opt(0, ap.angleRang, 'Est-ouest')}</select></label>` : ''}
                <label class="sam-field">Densité du feuillage (ML)<input name="apMl" inputmode="decimal" value="${n(ap.ml)}"><small class="pil-aide">Pour une même ombre, un feuillage épais transpire plus qu’un feuillage aéré : de 1 (feuillage aéré) à 2 (feuillage épais). Valeur proposée d’après les références de l’espèce : à garder sauf mesures particulières.</small></label>
                <label class="sam-field">Régulation des stomates (Fr)<input name="apFr" inputmode="decimal" value="${n(ap.fr)}"><small class="pil-aide">1 : la culture transpire librement. Plus faible pour les espèces qui limitent leur transpiration par temps sec (olivier, agrumes).</small></label>
                <label class="sam-field">Coefficient de l’enherbement<input name="apCouvert" inputmode="decimal" value="${n(ap.kcbCouvert)}" placeholder="vide : sol nu"><small class="pil-aide">Inter-rang enherbé : environ 0,3 à 0,8 selon la densité et l’entretien.</small></label>
              </div>
            </div>
          </div>
        </details>
      </fieldset>

      <fieldset class="pil-card"><legend>Dates clés de la saison</legend>
        ${annuel ? '' : `<p class="pil-aide">Dates de l’année ${anneeDe(cfg.stades.debut)}, reprises chaque année.</p>`}
        <div class="pil-fields">
          ${champsStades.map((k, i) => `<label class="sam-field">${esc(libStades[i])}<input type="date" name="st_${k}" value="${esc(cfg.stades[k])}" required></label>`).join('')}
        </div>
        ${annuel && cult.gdd?.length && cult.temp ? `<div class="pil-gdd">
          <label class="sam-field">Type de culture<select name="gddType" class="sam-input">${gddOptions}</select></label>
          <button type="button" class="sam-button" data-action="gdd">Calculer les dates avec les températures</button>
          <small class="pil-aide">À partir de la date de semis, avec les degrés-jours (chaleur cumulée au-dessus de ${f0(cult.temp.tbase)} °C) : températures réelles, puis celles de l’année précédente au-delà de 7 jours.</small>
        </div>` : ''}
        <p class="pil-note">Dates proposées à titre indicatif : ajustez-les à vos observations sur la parcelle. Hors de ces dates, aucun apport n’est calculé.</p>
        <div class="pil-fields">
          <label class="sam-field">Début du calcul<input type="date" name="debutBilan" value="${esc(annuel ? (/^\d{4}-/.test(cfg.debutBilan) ? cfg.debutBilan : addDaysISO(cfg.stades.debut, -30)) : debutBilanAffiche(cfg))}"></label>
          ${curseur('etatInitial', 'Réserve au début du calcul (% de la RU)', (cfg.etatInitial ?? 1) * 100, { min: 0, max: 100, step: 5, aide: '100 % : sol plein, par exemple après les pluies d’hiver.' })}
        </div>
      </fieldset>

      <fieldset class="pil-card"><legend>Sol</legend>
        <div class="pil-fields">
          <label class="sam-field pil-large">Type de sol<select name="texture" class="sam-input">${SOLS.map(s => opt(s.id, cfg.sol.texture, `${s.nom} — RU ≈ ${f1((1000 * (s.thetaFC - s.thetaWP)) / 100)} mm/cm`)).join('')}${Object.entries(SOLS_VOISINS).map(([k, v]) => opt(k, cfg.sol.texture, `${v.nom} — RU ≈ ${f1(ruSol(solParId(k)) / 100)} mm/cm`)).join('')}</select></label>
          <label class="sam-field">RU mesurée (mm/cm)<input name="ruCm" inputmode="decimal" value="${finite(cfg.sol.ruParM) ? n(cfg.sol.ruParM / 100, 2) : ''}" placeholder="selon le type de sol"><small class="pil-aide">Si elle est connue (analyse, carte des sols).</small></label>
          ${curseur('cailloux', 'Cailloux (% du volume)', cfg.sol.cailloux || 0, { min: 0, max: 90, step: 5 })}
        </div>
        <div class="pil-texture">
          <span class="pil-aide">Type de sol d’après une analyse :</span>
          <input name="argile" inputmode="decimal" placeholder="% argile" class="sam-input">
          <input name="limon" inputmode="decimal" placeholder="% limon" class="sam-input">
          <input name="sable" inputmode="decimal" placeholder="% sable" class="sam-input">
          <button type="button" class="sam-button" data-action="texture">Déterminer</button>
        </div>
        <p class="pil-ref" id="pil-ru-txt">${texteRU(cfg)}</p>
        <details class="pil-sub" data-cle="sol"${ouvert('sol')}><summary>Réglages avancés du sol</summary>
          <div class="pil-fields">
            <label class="sam-field">Humidité à la capacité au champ (m³/m³)<input name="thetaFC" inputmode="decimal" value="${n(cfg.sol.thetaFC, 3)}"><small class="pil-aide">Proposée selon le type de sol.</small></label>
            <label class="sam-field">Humidité au point de flétrissement (m³/m³)<input name="thetaWP" inputmode="decimal" value="${n(cfg.sol.thetaWP, 3)}"><small class="pil-aide">Proposée selon le type de sol.</small></label>
            <label class="sam-field">Eau facilement évaporable en surface (mm)<input name="rew" inputmode="decimal" value="${n(cfg.sol.rew, 1)}"><small class="pil-aide">Eau que la surface perd à pleine vitesse après une pluie ou une irrigation, avant de sécher et de freiner l’évaporation : environ 2 à 7 mm en sol sableux, 8 à 12 mm en sol argileux. Proposée selon le type de sol : à laisser par défaut.</small></label>
            <label class="sam-field">Épaisseur de sol qui sèche en surface (m)<input name="ze" inputmode="decimal" value="${n(cfg.sol.ze ?? 0.1)}"><small class="pil-aide">Couche que l’évaporation peut dessécher (0,10 à 0,15 m) ; plus bas, seules les racines prélèvent l’eau. Elle fixe l’eau totale que le sol peut perdre par évaporation. À laisser à 0,10 m sauf sol très argileux (0,15 m).</small></label>
          </div>
          <p class="pil-aide">Ces deux derniers réglages servent seulement au calcul de l’évaporation du sol (méthode détaillée).</p>
        </details>
      </fieldset>

      <fieldset class="pil-card"><legend>Irrigation</legend>
        <div class="pil-fields">
          <label class="sam-field pil-large">Système d’irrigation<select name="systeme" class="sam-input">${SYSTEMES.map(s => opt(s.id, sys?.id, s.nom)).join('')}</select></label>
          ${curseur('efficience', 'Efficience du réseau (%)', cfg.irrigation.efficience * 100, { min: 30, max: 100, aide: 'Part de l’eau apportée réellement utile aux racines. Valeur proposée à vérifier.' })}
          <label class="sam-field">Pluviométrie (mm/h)<input name="pluvio" inputmode="decimal" value="${n(cfg.irrigation.pluvio, 3)}" placeholder="pour les durées"><small class="pil-aide">Pour convertir les apports en durée de poste.</small></label>
          <label class="sam-field">Durée maximale d’un poste (h)<input name="dureeMaxPoste" inputmode="decimal" value="${n(cfg.irrigation.dureeMaxPoste, 1)}" placeholder="facultatif"><small class="pil-aide">Un apport plus long est découpé en plusieurs postes. En goutte-à-goutte et micro-aspersion, elle limite aussi l’apport calculé par jour (12 h si vide), avec la pluviométrie.</small></label>
        </div>
        <details class="pil-sub" data-cle="pluvio"${ouvert('pluvio')}><summary>Calculer la pluviométrie</summary>
          <div class="pil-fields">
            <label class="sam-field">Débit d’un goutteur ou diffuseur (L/h)<input name="debitLh" inputmode="decimal" value="${n(loc.debitLh, 2)}"></label>
            <label class="sam-field">Écartement sur le rang (m)<input name="espacement" inputmode="decimal" value="${n(loc.espacement, 2)}"></label>
            <label class="sam-field">Inter-rang (m)<input name="interRang" inputmode="decimal" value="${n(loc.interRang, 2)}"></label>
            <label class="sam-field">Goutteurs par emplacement<input name="parPoint" inputmode="decimal" value="${n(loc.parPoint ?? 1, 0)}"></label>
          </div>
          <div class="pil-fields">
            <label class="sam-field">ou débit du secteur (m³/h)<input name="debitM3h" inputmode="decimal" value="${n(loc.debitM3h, 2)}"></label>
            <label class="sam-field">surface du secteur (ha)<input name="surfaceSecteur" inputmode="decimal" value="${n(loc.surfaceSecteur, 3)}"></label>
          </div>
          <button type="button" class="sam-button" data-action="pluvio">Calculer</button>
        </details>
        <details class="pil-sub" data-cle="irrigation"${ouvert('irrigation')}><summary>Réglages avancés de l’irrigation</summary>
          <div class="pil-fields">
            ${curseur('fractionHumectee', 'Volume de sol humecté (%)', (cfg.irrigation.fractionHumectee ?? 1) * 100, { min: 10, max: 100, step: 5, aide: esc(aideHumecte) })}
            ${curseur('fw', 'Sol mouillé en surface par l’irrigation (%)', cfg.irrigation.fw * 100, { min: 5, max: 100, aide: esc(aideFw) })}
            <label class="sam-field">Apport utile maximal par jour (mm)<input name="doseMaxNette" inputmode="decimal" value="${n(cfg.irrigation.doseMaxNette, 1)}" placeholder="facultatif"><small class="pil-aide">Capacité réelle de l’installation : débit de la pompe, tour d’eau, nombre de secteurs. L’apport calculé ne la dépasse pas ; le complément est calculé les jours suivants. Vide, en goutte-à-goutte : pluviométrie × durée maximale d’un poste × efficience.</small></label>
          </div>
        </details>
      </fieldset>

      <fieldset class="pil-card"><legend>Calcul des apports</legend>
        <div class="pil-fields">
          <label class="sam-field pil-large">Seuil d’irrigation<select name="strategie" class="sam-input">${Object.entries(SEUILS).map(([k, v]) => opt(k, mode, v)).join('')}</select></label>
          ${curseur('mad', 'Seuil personnalisé (% de la RU consommée)', finite(strat.mad) ? strat.mad * 100 : cfg.culture.p * 100, { min: 5, max: 90, id: 'pil-bloc-mad', classe: cache(mode === 'perso'), aide: 'Exemple : 40 % = un apport est calculé quand la culture a consommé 40 % de la réserve utile.' })}
          ${curseur('cible', 'Remplissage visé (%)', clampCible(strat.cible) * 100, { min: 50, max: 100, step: 5, aide: 'Niveau jusqu’auquel l’apport remplit la réserve. 100 % : réserve pleine. En dessous, de la place reste libre pour la pluie (moins de pertes en profondeur).' })}
          <label class="sam-field">Paillage<select name="paillage" class="sam-input">${opt('aucun', cfg.paillage?.type, 'Aucun')}${opt('plastique', cfg.paillage?.type, 'Film plastique')}${opt('organique', cfg.paillage?.type, 'Paillage organique (paille, broyat)')}</select></label>
          ${curseur('couverture', 'Part du sol paillée (%)', cfg.paillage?.couverture || 0, { min: 0, max: 100, step: 5, id: 'pil-bloc-paillage', classe: cache(paille) })}
        </div>
        <div id="pil-bloc-ajusterp" class="${cache(mode === 'fao').trim()}">
          <label class="pil-check"><input type="checkbox" name="ajusterP"${strat.ajusterP !== false ? ' checked' : ''}> Adapter le seuil standard à la chaleur du jour</label>
          <p class="pil-aide">Coché : la RFU, donc le seuil, diminue un peu par forte chaleur et augmente par temps frais. Décoché : le seuil reste fixe toute la saison.</p>
        </div>
        <p class="pil-ref pil-ref-texte" id="pil-seuils-mm">${texteSeuils(cfg, annuel)}</p>
        <p class="pil-aide"><b>Standard</b> : un apport est calculé quand la RFU est consommée, juste avant que la culture ne commence à manquer d’eau ; apports plus gros et plus espacés. <b>Confort</b> : à la moitié de la RFU ; apports plus petits et plus fréquents, adapté au goutte-à-goutte. <b>Personnalisé</b> : vous fixez la part de la réserve utile consommée, pour une stratégie qui vous est propre (restriction volontaire, calage sur des tensiomètres…).</p>
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
    // Champ absent du formulaire (masqué selon la mesure choisie) : valeur précédente conservée
    const garde = (name, avant) => (f.elements[name] ? nv(name) : (avant ?? null));
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
    cu.p = nv('p', cu.p * 100) / 100;
    cu.h = nv('h', cu.h);
    cu.zr = nv('zr', cu.zr);
    if (annuel) cu.zrMin = nv('zrMin', cu.zrMin);
    cu.kcbHorsSaison = nv('kcbHorsSaison', cu.kcbHorsSaison);
    cfg.methode = v('methode') || 'double';
    cu.kcbPerso = ck('kcbPersoActif') ? { ini: nv('kcbIni'), mi: nv('kcbMi'), fin: nv('kcbFin') } : null;
    cu.ajusterClimat = ck('ajusterClimat');
    const apAvant = cu.ap || {};
    const relAvant = apAvant.releve || {};
    cu.ap = {
      actif: ck('apActif'),
      mesure: v('apMesure') || apAvant.mesure || 'ombre',
      fc: nv('apFc', (apAvant.fc ?? 0.5) * 100) / 100,
      forme: v('apForme') || apAvant.forme || 'arbres',
      hauteurCanopee: f.elements.apHaut ? nv('apHaut', apAvant.hauteurCanopee ?? cu.h) : (apAvant.hauteurCanopee ?? cu.h),
      largeur: f.elements.apLarg ? nv('apLarg', apAvant.largeur ?? 1.5) : (apAvant.largeur ?? 1.5),
      angleRang: f.elements.apAngle ? nv('apAngle', 90) : (apAvant.angleRang ?? 90),
      ml: nv('apMl', apAvant.ml ?? 1.5),
      fr: nv('apFr', apAvant.fr ?? 1),
      kcbCouvert: nv('apCouvert'),
      releve: {
        largeur: garde('apRelLarg', relAvant.largeur),
        diametre: garde('apRelDiam', relAvant.diametre),
        espacement: garde('apRelEsp', relAvant.espacement),
        interRang: garde('apRelInter', relAvant.interRang)
      }
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
    irr.fw = nv('fw', irr.fw * 100) / 100;
    irr.efficience = nv('efficience', irr.efficience * 100) / 100;
    irr.pluvio = nv('pluvio');
    irr.dureeMaxPoste = nv('dureeMaxPoste');
    irr.doseMaxNette = nv('doseMaxNette');
    irr.fractionHumectee = Math.min(1, Math.max(0.05, nv('fractionHumectee', 100) / 100));
    irr.localise = { debitLh: nv('debitLh'), espacement: nv('espacement'), interRang: nv('interRang'), parPoint: nv('parPoint', 1), debitM3h: nv('debitM3h'), surfaceSecteur: nv('surfaceSecteur') };
    const mad = nv('mad');
    cfg.strategie = {
      mode: v('strategie') || 'fao',
      mad: finite(mad) ? mad / 100 : null,
      cible: clampCible(nv('cible', 100) / 100),
      ajusterP: f.elements.ajusterP ? ck('ajusterP') : cfg.strategie?.ajusterP !== false
    };
    cfg.paillage = { type: v('paillage') || 'aucun', couverture: Math.min(100, Math.max(0, nv('couverture', 0))) };
    return d;
  }

  function erreursParcelle(d) {
    const e = [];
    const cfg = d.config;
    if (!d.nom) e.push('Donnez un nom à la parcelle.');
    if (!finite(d.latitude) || Math.abs(d.latitude) > 90 || !finite(d.longitude) || Math.abs(d.longitude) > 180) e.push('Position de la parcelle invalide : choisissez une commune ou saisissez latitude et longitude.');
    try { C.stadesDepuisDates(cfg.stades); } catch { e.push('Dates de la saison : elles doivent se suivre dans l’ordre.'); }
    if (!(cfg.sol.thetaFC > cfg.sol.thetaWP && cfg.sol.thetaWP >= 0 && cfg.sol.thetaFC < 0.7)) e.push('Sol : l’humidité à la capacité au champ doit dépasser celle du point de flétrissement.');
    if (!(cfg.culture.p > 0.05 && cfg.culture.p < 0.95)) e.push('La RFU doit être comprise entre 5 et 95 % de la RU.');
    if (!(cfg.culture.zr > 0.05 && cfg.culture.zr <= 5)) e.push('Profondeur d’enracinement invalide.');
    if (!(cfg.irrigation.fw > 0 && cfg.irrigation.fw <= 1)) e.push('Sol mouillé en surface par l’irrigation : entre 1 et 100 %.');
    if (!(cfg.irrigation.efficience >= 0.3 && cfg.irrigation.efficience <= 1)) e.push('L’efficience du réseau doit être comprise entre 30 et 100 %.');
    if (cfg.culture.kcbPerso && ['ini', 'mi', 'fin'].some(k => !(cfg.culture.kcbPerso[k] >= 0 && cfg.culture.kcbPerso[k] <= 2))) e.push('Coefficients personnalisés invalides (entre 0 et 2).');
    if (cfg.strategie.mode === 'perso' && !(cfg.strategie.mad > 0.02 && cfg.strategie.mad < 0.95)) e.push('Seuil personnalisé : entre 2 et 95 % de la RU.');
    if (cfg.culture.ap?.actif && !(cfg.culture.ap.fc > 0 && cfg.culture.ap.fc <= 1)) e.push('Couverture mesurée : entre 1 et 100 % du sol.');
    return e;
  }

  /** Part du sol couverte (ou ombragée) d'après les relevés du formulaire, ou null. */
  function couvertureReleve(f) {
    const val = name => num(f.elements[name]?.value);
    const ir = val('apRelInter');
    if (f.elements.apForme.value === 'rangs') {
      const l = val(f.elements.apMesure.value === 'ombre' ? 'apRelLarg' : 'apLarg');
      return l > 0 && ir > 0 ? Math.min(1, l / ir) : null;
    }
    const dm = val('apRelDiam');
    const e = val('apRelEsp');
    return dm > 0 && e > 0 && ir > 0 ? Math.min(1, (Math.PI * dm * dm) / 4 / (e * ir)) : null;
  }

  function lierFormulaire() {
    const f = $('#pil-form');
    const rafraichir = () => { lireFormulaire(); renderParcelle(); };
    f.elements.culture_id.addEventListener('change', () => { lireFormulaire(); changerCulture(parId(f.elements.culture_id.value)); });
    f.elements.classe_id.addEventListener('change', () => {
      lireFormulaire();
      const d = S.brouillon;
      const cult = parId(d.culture_id);
      const cl = classeDe(cult, f.elements.classe_id.value);
      d.classe_id = cl.id;
      const cu = defautsCulture(cult, cl);
      const apAvant = d.config.culture.ap || {};
      Object.assign(d.config.culture, {
        h: cu.h, zr: estAnnuel(cult) ? cu.zr : d.config.culture.zr, kcbHorsSaison: cu.kcbHorsSaison,
        ap: { ...cu.ap, actif: apAvant.actif, mesure: apAvant.mesure || cu.ap.mesure, releve: apAvant.releve || cu.ap.releve }
      });
      renderParcelle();
    });
    f.elements.texture.addEventListener('change', () => {
      lireFormulaire();
      const s = solParId(f.elements.texture.value);
      Object.assign(S.brouillon.config.sol, { thetaFC: s.thetaFC, thetaWP: s.thetaWP, rew: s.rewDefaut, ruParM: null });
      renderParcelle();
    });
    f.elements.systeme.addEventListener('change', () => {
      lireFormulaire();
      const s = systemeParId(f.elements.systeme.value);
      // Valeurs proposées pour le système : sol mouillé, efficience, volume de sol humecté
      Object.assign(S.brouillon.config.irrigation, { fw: s.fwDefaut, efficience: s.efficience, fractionHumectee: s.humecteDefaut ?? 1 });
      // Irrigation localisée : seuil « confort » par défaut (apports fréquents), modifiable
      const st = S.brouillon.config.strategie;
      if (s.frequent && st.mode === 'fao') st.mode = 'confort';
      else if (!s.frequent && st.mode === 'confort') st.mode = 'fao';
      renderParcelle();
    });

    // Curseurs : la réglette et la case de saisie restent synchronisées
    f.querySelectorAll('input[type="range"][data-cible]').forEach(r => {
      const t = f.elements[r.dataset.cible];
      if (!t) return;
      r.addEventListener('input', () => {
        t.value = String(r.value).replace('.', ',');
        t.dispatchEvent(new Event('input', { bubbles: true }));
      });
      t.addEventListener('input', () => { const x = num(t.value); if (finite(x)) r.value = String(x); });
    });

    // Cases à cocher qui affichent les champs correspondants
    f.querySelectorAll('input[type="checkbox"][data-bascule]').forEach(c => c.addEventListener('change', () => {
      $(`#${c.dataset.bascule}`)?.classList.toggle('hidden', !c.checked);
    }));

    // Réserve utile et seuils en mm, recalculés pendant la saisie
    const majCalculs = () => {
      const d = lireFormulaire();
      $('#pil-ru-txt').innerHTML = texteRU(d.config);
      $('#pil-seuils-mm').innerHTML = texteSeuils(d.config, estAnnuel(parId(d.culture_id)));
    };
    for (const name of ['thetaFC', 'thetaWP', 'zr', 'p', 'ruCm', 'cailloux', 'fractionHumectee', 'mad']) {
      f.elements[name]?.addEventListener('input', majCalculs);
    }
    f.elements.ajusterP?.addEventListener('change', majCalculs);
    f.elements.strategie.addEventListener('change', () => {
      const m = f.elements.strategie.value;
      $('#pil-bloc-mad').classList.toggle('hidden', m !== 'perso');
      $('#pil-bloc-ajusterp').classList.toggle('hidden', m !== 'fao');
      majCalculs();
    });
    f.elements.paillage.addEventListener('change', () => {
      $('#pil-bloc-paillage').classList.toggle('hidden', f.elements.paillage.value === 'aucun');
    });

    // Couverture mesurée : champs selon la mesure et la forme ; pourcentage calculé à la saisie
    f.elements.apMesure?.addEventListener('change', rafraichir);
    f.elements.apForme?.addEventListener('change', rafraichir);
    const majCouverture = () => {
      const fc = couvertureReleve(f);
      const out = $('#pil-ap-resultat');
      if (!finite(fc)) { out.textContent = ''; return; }
      const val = Math.max(1, Math.round(fc * 100));
      f.elements.apFc.value = String(val);
      f.elements.apFc.dispatchEvent(new Event('input', { bubbles: true }));
      out.textContent = `Soit ${val} % du sol ${f.elements.apMesure.value === 'ombre' ? 'ombragé vers midi' : 'couvert par le feuillage'}.`;
    };
    for (const name of ['apRelLarg', 'apLarg', 'apRelDiam', 'apRelEsp', 'apRelInter']) {
      f.elements[name]?.addEventListener('input', majCouverture);
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
          surface_ha: d.surface_ha, station_id: d.station_id, culture_id: d.culture_id, classe_id: d.classe_id, config: d.config
        });
        S.brouillon = null;
        ctx.ui.toast('Parcelle enregistrée');
        S.id = row.id;
        S.onglet = 'bilan';
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
      if (!r.fin) { msg.textContent = `Données insuffisantes : ${f0(r.cumul)} degrés-jours cumulés sur ${f0(g.total)}.`; return; }
      Object.assign(d.config.stades, { finIni: r.finIni, finDev: r.finDev, finMi: r.finMi, fin: r.fin });
      renderParcelle();
      $('#pil-form-msg').textContent = `Dates calculées (${g.type}, ${f0(g.total)} degrés-jours) : à vérifier sur le terrain, puis enregistrer.`;
    } catch (error) {
      msg.textContent = error.message || 'Calcul impossible.';
      msg.classList.add('is-error');
    }
  }

  // ---------------------------------------------------------------------------
  // Onglet Aide
  // ---------------------------------------------------------------------------
  function renderAide() {
    const choix = storage.get('pilotage.refCulture', 'pommier');
    const cult = parId(choix) || CULTURES[0];
    const especes = Object.entries(FAMILLES).map(([k, v]) => {
      const liste = CULTURES.filter(c => c.famille === k);
      return liste.length ? `<optgroup label="${esc(v)}">${liste.map(c => `<option value="${c.id}"${c.id === cult.id ? ' selected' : ''}>${esc(c.nom)}</option>`).join('')}</optgroup>` : '';
    }).join('');
    const lexique = [
      ['ET₀ (évapotranspiration de référence)', 'Eau évaporée en un jour par un gazon bien alimenté en eau. Elle traduit la demande du climat : chaleur, soleil, vent, air sec.'],
      ['ETc (consommation de la culture)', 'Eau consommée par la culture : ET₀ × coefficient cultural, réduite en cas de manque d’eau.'],
      ['Kc (coefficient cultural)', 'Rapport entre la consommation de la culture et l’ET₀. Il évolue au cours de la saison avec le développement du feuillage. Dans la méthode détaillée, c’est la somme d’un coefficient de transpiration et d’un coefficient d’évaporation du sol.'],
      ['Transpiration', 'Eau prélevée par les racines et rejetée par les feuilles.'],
      ['Évaporation du sol', 'Eau perdue directement par la surface du sol mouillée : forte juste après une pluie ou une irrigation, puis de plus en plus faible à mesure que la surface sèche.'],
      ['RU (réserve utile)', 'Eau que le sol retient sur la profondeur des racines et que la culture peut prélever, de la capacité au champ jusqu’au point de flétrissement.'],
      ['RFU (réserve facilement utilisable)', 'Partie de la RU que la culture prélève sans difficulté. Au-delà, elle ferme ses stomates et transpire moins.'],
      ['Seuil d’irrigation', 'Quantité d’eau consommée dans la RU à partir de laquelle l’outil calcule un apport : la RFU (standard), la moitié de la RFU (confort) ou une part de la RU que vous choisissez (personnalisé). Le seuil standard varie un peu au fil de la saison avec la chaleur (voir les questions fréquentes).'],
      ['Volume de sol humecté', 'En irrigation localisée, part du volume de sol réellement mouillé par l’irrigation (le « bulbe » sous les goutteurs). La réserve prise en compte est réduite d’autant.'],
      ['Remplissage visé', 'Niveau jusqu’auquel un apport calculé remplit la réserve : 100 % pour la remplir complètement, moins pour laisser de la place à la pluie.'],
      ['Stress hydrique', 'Manque d’eau qui réduit la transpiration de la culture. L’outil indique de combien elle est réduite.'],
      ['Apport calculé', 'Quantité d’eau qui, selon le calcul, ramènerait la réserve au remplissage visé (eau sortie du réseau). La part utile aux racines dépend de l’efficience.'],
      ['Efficience du réseau', 'Part de l’eau apportée qui reste utile aux racines (pertes par ruissellement, percolation, défaut d’uniformité).'],
      ['Pluviométrie', 'Lame d’eau apportée en une heure par le réseau (mm/h). Elle convertit les apports en durée de poste.'],
      ['Conduite', 'Âge, forme et densité de plantation, développement du feuillage. Elle fixe les coefficients de la culture.'],
      ['Degrés-jours', 'Chaleur cumulée au-dessus d’une température de base. Ils servent à estimer les dates des stades des cultures annuelles.'],
      ['Prévision', 'De aujourd’hui à J+7, le calcul utilise les prévisions météo. La pluie prévue est comptée telle qu’annoncée ; au-delà de 2 à 3 jours, elle est incertaine et l’onglet Bilan le signale.']
    ];
    const faq = [
      ['Pourquoi le coefficient du jour (Kc) monte-t-il parfois jusqu’à 1,2 ?',
        'Dans la méthode détaillée, le coefficient du jour additionne la transpiration de la culture et l’évaporation du sol. Juste après une pluie ou une irrigation, la surface du sol mouillée évapore beaucoup : le coefficient atteint alors son maximum, environ 1,2 selon le vent et l’humidité de l’air. C’est fréquent hors saison : un verger sans feuilles a un coefficient de transpiration faible (0,3 à 0,4), mais après une pluie l’évaporation du sol ajoute jusqu’à 0,8 environ. L’ET₀ étant alors très faible (souvent moins de 1 mm par jour), cela ne représente qu’environ 1 mm d’eau par jour. Le détail est affiché dans l’onglet Bilan : coefficient du jour, et colonnes transpiration et évaporation du sol du détail jour par jour.'],
      ['Pourquoi le seuil d’irrigation change-t-il au cours de la saison ?',
        'Le seuil standard correspond à la RFU, la part de la réserve que la culture prélève sans difficulté. Cette part dépend de la demande du climat : par forte chaleur, la culture a plus de mal à extraire l’eau du sol et commence à en manquer plus tôt. L’outil ajuste donc chaque jour la RFU selon la consommation de la veille : elle diminue quand la consommation dépasse 5 mm par jour et augmente quand elle est plus faible (par exemple, une RFU de référence de 50 % descend à 42 % pour une consommation de 7 mm par jour). Pour les cultures annuelles, la réserve utile grandit aussi avec l’enracinement. Pour garder un seuil fixe : décochez « Adapter le seuil standard à la chaleur du jour », ou choisissez le seuil confort ou personnalisé (onglet Parcelle, rubrique Calcul des apports).'],
      ['Méthode détaillée ou simplifiée : quelle différence ?',
        'La méthode simplifiée applique un coefficient moyen par stade, qui comprend une évaporation du sol moyenne. La méthode détaillée calcule chaque jour la transpiration de la culture et l’évaporation du sol, selon l’humidité de la surface. Sur une saison, l’écart est le plus souvent modéré. Il est plus marqué en goutte-à-goutte, où le sol est peu mouillé (la méthode simplifiée compte alors trop d’évaporation), en jeune plantation, où une grande partie du sol est nue, et dans les jours qui suivent une pluie. La méthode détaillée suit mieux la réalité au jour le jour.'],
      ['Comment choisir le seuil d’irrigation et le remplissage visé ?',
        'Standard : un apport est calculé quand la RFU est consommée, juste avant que la culture ne commence à manquer d’eau ; les apports sont plus gros et plus espacés. Confort : à la moitié de la RFU ; apports plus petits et plus fréquents, adapté au goutte-à-goutte. Personnalisé : vous fixez la part de la réserve utile consommée (par exemple pour une restriction volontaire ou un calage sur des tensiomètres). Les valeurs en mm pour votre parcelle sont affichées sous le choix du seuil. Le remplissage visé fixe jusqu’où l’apport remplit la réserve : en dessous de 100 %, de la place reste libre pour la pluie.'],
      ['Comment mesurer le sol ombragé ?',
        'Par temps ensoleillé, en pleine végétation, vers 13 h 30 – 14 h en été (heure légale, quand le soleil est au plus haut). En rangs (haie fruitière, vigne palissée) : mesurez la largeur de la bande d’ombre au sol, perpendiculairement au rang, à plusieurs endroits, et divisez-la par l’inter-rang (1,8 m d’ombre pour 4 m d’inter-rang : 45 %). En arbres isolés : mesurez le diamètre moyen de l’ombre d’un arbre ; la part ombragée est la surface de l’ombre divisée par la surface occupée par un arbre (distance sur le rang × inter-rang). L’onglet Parcelle fait ce calcul. Si vous ne pouvez pas mesurer l’ombre, choisissez « Dimensions du feuillage » : l’outil déduit l’ombre de midi de la largeur et de la hauteur du feuillage et de l’orientation des rangs.'],
      ['Volume de sol humecté et sol mouillé en surface : quelle différence ?',
        'Le volume de sol humecté est la part du sol, en profondeur, réellement mouillée par l’irrigation (le « bulbe » sous les goutteurs, où se concentrent les racines actives). Il réduit la réserve prise en compte : avec 40 % de volume humecté, une réserve utile de 100 mm compte pour 40 mm, d’où des apports plus petits et plus fréquents. Valeurs courantes : 30 à 50 % en goutte-à-goutte, 50 à 80 % en micro-aspersion, 100 % en aspersion. Le sol mouillé en surface sert seulement au calcul de l’évaporation du sol.'],
      ['À quoi servent la durée maximale d’un poste et l’apport utile maximal par jour ?',
        'La durée maximale d’un poste découpe un apport trop long en plusieurs postes (par exemple 2 postes de 10 h). L’apport utile maximal par jour représente la capacité de l’installation (débit de la pompe, tour d’eau, nombre de secteurs) : l’apport calculé ne la dépasse pas, et le complément est calculé les jours suivants. En goutte-à-goutte et micro-aspersion, si ce champ est vide, l’outil prend pluviométrie × durée maximale d’un poste (12 h si elle est vide) × efficience.'],
      ['La pluie prévue est-elle fiable ?',
        'Les prévisions de pluie sont assez fiables à 1 ou 2 jours, beaucoup moins au-delà : la pluie peut tomber un autre jour, être plus faible ou ne pas tomber du tout. L’outil compte la pluie telle qu’annoncée et signale dans l’onglet Bilan les pluies prévues à plus de 2 jours. Chaque jour, le calcul est refait avec la pluie réellement tombée (station SAM ou Open-Meteo). Vous pouvez aussi saisir le relevé de votre pluviomètre dans l’onglet Irrigations et pluies.'],
      ['Que faire si les dates de saison ne correspondent pas à ma parcelle ?',
        'Les dates proposées sont indicatives. Corrigez-les dans l’onglet Parcelle, rubrique Dates clés de la saison, d’après vos observations (débourrement, chute des feuilles, semis, récolte). Pour les arbres et la vigne, elles sont reprises chaque année. Hors de ces dates, aucun apport n’est calculé et le bilan suit la recharge du sol par les pluies. L’onglet Bilan signale les dates très éloignées de celles proposées pour l’espèce.'],
      ['Faut-il modifier l’eau facilement évaporable et l’épaisseur de sol qui sèche ?',
        'En général, non. Ces deux valeurs servent seulement au calcul de l’évaporation du sol et sont proposées selon le type de sol : eau facilement évaporable d’environ 2 à 7 mm en sol sableux et 8 à 12 mm en sol argileux, épaisseur de 0,10 à 0,15 m. Elles sont rarement mesurées.']
    ];
    panel.innerHTML = `<div class="pil-card"><h3>Lire le bilan</h3>
      <p>Chaque jour, l’outil compte l’eau qui entre dans le sol (pluie, irrigation) et celle qui en sort (consommation de la culture, évaporation, drainage). Il en déduit l’eau encore disponible pour les racines. Quand cette réserve descend jusqu’au seuil d’irrigation, il calcule l’apport qui la remplirait de nouveau.</p>
      <p>Les résultats sont des estimations : à confronter à l’observation de la culture et aux mesures de terrain (sondes, tensiomètres). La décision d’irriguer revient à l’exploitant.</p></div>
    <div class="pil-card pil-faq"><h3>Questions fréquentes</h3>${faq.map(([q, r]) => `<details><summary>${esc(q)}</summary><p>${esc(r)}</p></details>`).join('')}</div>
    <div class="pil-card"><h3>Lexique</h3><dl class="pil-lexique">${lexique.map(([t, d]) => `<dt>${esc(t)}</dt><dd>${esc(d)}</dd>`).join('')}</dl></div>
    <div class="pil-card">
      <div class="pil-card-head"><h3>Espèces et conduites</h3><select id="pil-aide-espece" class="sam-input">${especes}</select></div>
      <p><b>${esc(cult.nom)}</b> ${cult.latin ? `<i>${esc(cult.latin)}</i>` : ''}${finite(cult.p?.p) ? ` · RFU : ${f0(cult.p.p * 100)} % de la RU` : ''}${cult.temp ? ` · croissance au-dessus de ${f0(cult.temp.tbase)} °C` : ''}</p>
      <div class="pil-table-wrap"><table class="pil-table">
        <thead><tr><th>Conduite</th><th>Sol ombragé</th><th>Hauteur (m)</th>${estAnnuel(cult) ? '<th>Enracinement (m)</th>' : ''}<th>Kc démarrage</th><th>Kc pleine végétation</th><th>Kc fin de saison</th></tr></thead>
        <tbody>${cult.classes.map(c => {
          const k = c.kc || { ini: c.kcb.ini + 0.05, mid: c.kcb.mid + 0.05, end: c.kcb.end + 0.05 };
          return `<tr><td>${esc(c.nom)}</td><td>${c.fc ? `${plage(c.fc, 0, 100)} %` : '—'}</td><td>${plage(c.h)}</td>${estAnnuel(cult) ? `<td>${plage(c.zr)}</td>` : ''}<td>${f2(k.ini)}</td><td>${f2(k.mid)}</td><td>${f2(k.end)}</td></tr>`;
        }).join('')}</tbody></table></div>
      ${cult.gdd?.length ? `<p class="pil-muted">Durée de la saison en degrés-jours : ${cult.gdd.map(g => `${esc(g.type)} ${f0(g.total)}`).join(' ; ')}.</p>` : ''}
    </div>
    <div class="pil-grid pil-grid-2">
      <div class="pil-card"><h3>Types de sol</h3><div class="pil-table-wrap"><table class="pil-table">
        <thead><tr><th>Type de sol</th><th>RU (mm/cm)</th><th>RU (mm/m)</th></tr></thead>
        <tbody>${SOLS.map(s => `<tr><td>${esc(s.nom)}</td><td>${f1((1000 * (s.thetaFC - s.thetaWP)) / 100)}</td><td>${f0(1000 * (s.thetaFC - s.thetaWP))}</td></tr>`).join('')}</tbody>
      </table></div><p class="pil-muted">Valeurs moyennes ; une RU mesurée sur la parcelle est toujours préférable.</p></div>
      <div class="pil-card"><h3>Systèmes d’irrigation</h3><div class="pil-table-wrap"><table class="pil-table">
        <thead><tr><th>Système</th><th>Sol mouillé en surface</th><th>Volume de sol humecté</th><th>Efficience indicative</th></tr></thead>
        <tbody>${SYSTEMES.map(s => `<tr><td>${esc(s.nom)}</td><td>${f0(s.fw[0] * 100)}${s.fw[1] !== s.fw[0] ? ` à ${f0(s.fw[1] * 100)}` : ''} %</td><td>${f0(s.humecte[0] * 100)}${s.humecte[1] !== s.humecte[0] ? ` à ${f0(s.humecte[1] * 100)}` : ''} %</td><td>${pct(s.efficience)}</td></tr>`).join('')}</tbody>
      </table></div><p class="pil-muted">L’efficience réelle dépend de l’état du réseau, le volume humecté du sol et de l’écartement des goutteurs : valeurs à vérifier.</p></div>
    </div>
    <div class="pil-card"><h3>Méthode</h3>
      <p>Les calculs suivent la méthode FAO-56 de l’Organisation des Nations unies pour l’alimentation et l’agriculture (édition 2025), référence internationale pour les besoins en eau des cultures. La profondeur d’enracinement des arbres et de la vigne, l’efficience du réseau, les dates de saison proposées et le volume de sol humecté ne viennent pas de cette méthode : ce sont des valeurs par défaut à ajuster.</p></div>`;
    $('#pil-aide-espece').addEventListener('change', e => { storage.set('pilotage.refCulture', e.target.value); renderAide(); });
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
      } else if (action === 'importer') {
        btn.disabled = true;
        await importer();
      } else if (action === 'annuler-import') {
        S.importLignes = null;
        renderSaisies();
      } else if (action === 'suppr-irr') {
        await store.supprimerIrrigations([btn.dataset.id]);
        S.irrigations = await store.irrigations(S.id);
        renderSaisies();
        calculer();
      } else if (action === 'suppr-toutes-irr') {
        if (window.confirm(`Supprimer les ${S.irrigations.length} irrigations enregistrées pour cette parcelle ?`)) {
          await store.supprimerIrrigations(S.irrigations.map(r => r.id));
          S.irrigations = await store.irrigations(S.id);
          renderSaisies();
          calculer();
        }
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
          S.onglet = 'bilan';
          if (S.id) await ouvrir(S.id); else render();
        }
      } else if (action === 'dupliquer') {
        const d = structuredClone(lireFormulaire());
        d.id = null;
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
        Object.assign(S.brouillon.config.sol, { texture: t, thetaFC: sol.thetaFC, thetaWP: sol.thetaWP, rew: sol.rewDefaut, ruParM: null });
        renderParcelle();
        $('#pil-form-msg').textContent = `Type de sol : ${nomSol(t)}.`;
      } else if (action === 'pluvio') {
        const d = lireFormulaire();
        const l = d.config.irrigation.localise;
        const v = IR.pluviometrieLocalisee({ debitLh: l.debitLh, espacement: l.espacement, interRang: l.interRang, parPoint: l.parPoint || 1 })
          ?? IR.pluviometrieAspersion({ debitM3h: l.debitM3h, surfaceHa: l.surfaceSecteur });
        if (!finite(v)) { $('#pil-form-msg').textContent = 'Renseignez le débit, l’écartement et l’inter-rang (ou le débit et la surface du secteur).'; return; }
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
