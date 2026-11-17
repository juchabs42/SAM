// Moteur FAO-56 — bilan hydrique journalier de la couche évaporante et de la zone racinaire,
// avec planification des irrigations sur la période de prévision (J à J+7).
//
// Référence : FAO-56 Rev.1 (2025), chapitres 6, 7 et 8. Convention de l'exemple 8.3 :
// pluies et irrigations ont lieu en début de journée.

import * as C from './coefficients.js';

const finite = v => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const moyenne = arr => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);

/** Valeurs par défaut des options de simulation. */
export const OPTIONS_DEFAUT = {
  methode: 'double',        // 'double' (Kcb + Ke, chap. 7) ou 'simple' (Kc, chap. 6)
  peau: true,               // couche de surface « skin » (Éq. 7.11 à 7.14) ; false = procédure 1998
  ajusterP: true,           // p ajusté à l'ETc du jour (Éq. 8.5)
  ajusterClimat: true,      // ajustement de Kcb mid / end au climat (Éq. 7.2)
  pluiePrevue: 0.5,         // part de la pluie prévue retenue pour la planification
  planifier: true,          // propose des irrigations sur la période de prévision
  mad: null,                // seuil de déclenchement (fraction de TAW) ; null = p du jour (RAW)
  cible: 1,                 // fraction du déficit à recompléter (1 = retour à la capacité au champ)
  doseMaxNette: null,       // dose nette maximale par irrigation (mm), capacité du réseau
  intervalleMin: 1,         // jours minimum entre deux irrigations planifiées
  planifierHorsSaison: false, // pas de conseil d'irrigation hors de la période de culture
  seuilPluieSignificative: 3 // mm : au-delà, fw = 1 (tableau 7.6)
};

/**
 * Moyennes de u2 et HRmin par stade, sur les jours disponibles (passé et prévision) ;
 * repli sur la moyenne de toute la série, puis sur le climat standard FAO (2 m/s, 45 %).
 */
export function climatParStade(meteo, stades) {
  const acc = { ini: [], dev: [], mi: [], fin: [], tout: [] };
  for (const j of meteo) {
    if (!finite(j.u2) || !finite(j.hrmin)) continue;
    const { stade } = C.stadeDuJour(j.date, stades);
    acc.tout.push(j);
    if (acc[stade]) acc[stade].push(j);
  }
  const res = {};
  const global = acc.tout.length
    ? { u2: moyenne(acc.tout.map(j => j.u2)), hrmin: moyenne(acc.tout.map(j => j.hrmin)), n: acc.tout.length, source: 'série' }
    : { u2: 2, hrmin: 45, n: 0, source: 'climat standard FAO' };
  for (const s of ['ini', 'dev', 'mi', 'fin']) {
    res[s] = acc[s].length >= 5
      ? { u2: moyenne(acc[s].map(j => j.u2)), hrmin: moyenne(acc[s].map(j => j.hrmin)), n: acc[s].length, source: 'stade' }
      : global;
  }
  res.hors = global;
  res.global = global;
  return res;
}

/**
 * Valeurs de Kcb (ou Kc) aux trois points de la courbe, ajustées au climat (Éq. 7.2 / 6.16 / 6.19).
 * v = { ini, mi, fin } tabulés ; h = hauteur de la culture (m).
 */
export function pointsCourbe(v, climat, h, ajuster = true) {
  if (!ajuster) return { ini: v.ini, mi: v.mi, fin: v.fin };
  return {
    ini: v.ini,
    mi: C.ajusterMi(v.mi, climat.mi.u2, climat.mi.hrmin, h),
    fin: C.ajusterFin(v.fin, climat.fin.u2, climat.fin.hrmin, h)
  };
}

/**
 * Simulation journalière.
 *
 * parcelle = {
 *   annuel (bool), stades {debut, finIni, finDev, finMi, fin},
 *   kcb {ini, mi, fin}, kc {ini, mi, fin} (méthode simple), kcbHorsSaison, kcHorsSaison,
 *   h (m), zr (m, maximale), zrMin (m), p (fraction tabulée),
 *   sol { thetaFC, thetaWP, rew, ze, cailloux (0–1), ruParM (mm/m, remplace θFC−θWP si fourni) },
 *   fw (fraction humectée par le système), goutte (bool), efficience (0–1),
 *   paillage { type, couverture, trous }, fractionHumectee (0–1),
 *   pluieMaxInfiltree (mm/j, ruissellement au-delà ; null = pas de ruissellement),
 *   etatInitial { dr (mm) | drFraction (de TAW), de (mm), drew (mm) }
 * }
 * meteo = [{ date, et0, pluie, u2, hrmin, prevision (bool), kcb?, fc?, h?, zr? }] (triée, journalière)
 * irrigations = [{ date, brut (mm) | net (mm) }] — doses réellement apportées ou programmées
 * aujourdhui = date ISO séparant le passé observé de la prévision.
 */
export function simuler(parcelle, meteo, irrigations = [], options = {}, aujourdhui = null) {
  const o = { ...OPTIONS_DEFAUT, ...options };
  const P = parcelle;
  const sol = P.sol;
  const ze = sol.ze ?? 0.1;
  const tewV = C.tew(sol.thetaFC, sol.thetaWP, ze);
  const rew = Math.min(sol.rew ?? 9, tewV * 0.9);
  const cailloux = clamp(sol.cailloux ?? 0, 0, 0.9);
  const fHum = clamp(P.fractionHumectee ?? 1, 0.05, 1);
  const ruParM = finite(sol.ruParM) ? sol.ruParM : 1000 * (sol.thetaFC - sol.thetaWP);
  const tawDe = zr => ruParM * zr * (1 - cailloux) * fHum;
  const efficience = clamp(P.efficience ?? 0.9, 0.3, 1);
  const fwSys = clamp(P.fw ?? 1, 0.01, 1);
  const paillage = C.effetPaillage(P.paillage?.type, P.paillage?.couverture, P.paillage?.trous);
  const climat = climatParStade(meteo, P.stades);
  const annuel = P.annuel !== false;
  const hMax = P.h ?? 0.5;
  const kcbPts = pointsCourbe(P.kcb, climat, hMax, o.ajusterClimat);
  const kcPts = P.kc ? pointsCourbe(P.kc, climat, hMax, o.ajusterClimat) : null;
  if (o.methode === 'simple' && !kcPts) throw new Error('Méthode simple : Kc non disponible pour cette culture.');

  // Index des irrigations (plusieurs apports le même jour sont cumulés)
  const irrig = new Map();
  for (const ev of irrigations) {
    if (!ev?.date) continue;
    const net = finite(ev.net) ? ev.net : finite(ev.brut) ? ev.brut * efficience : 0;
    const brut = finite(ev.brut) ? ev.brut : net / efficience;
    const cur = irrig.get(ev.date) || { net: 0, brut: 0, sources: [] };
    cur.net += net; cur.brut += brut; cur.sources.push(ev);
    irrig.set(ev.date, cur);
  }

  // État initial
  const zr0 = finite(meteo[0]?.zr) ? meteo[0].zr : C.zrDuJour(meteo[0]?.date ?? P.stades.debut, P.stades, P.zr, { annuel, zrMin: P.zrMin ?? 0.2 });
  const taw0 = tawDe(zr0);
  const ei = P.etatInitial || {};
  let dr = finite(ei.dr) ? ei.dr : finite(ei.drFraction) ? ei.drFraction * taw0 : 0;
  let de = finite(ei.de) ? ei.de : 0;
  let drew = finite(ei.drew) ? ei.drew : Math.min(de, rew);
  let fwPrec = 1;
  let zrPrec = zr0;
  let derniereIrrig = null;

  const jours = [];
  let etcPotPrec = null;
  for (const m of meteo) {
    const date = m.date;
    const prevision = aujourdhui ? date >= aujourdhui : !!m.prevision;
    const et0 = Math.max(0, m.et0 ?? 0);
    const st = C.stadeDuJour(date, P.stades);
    const clim = climat[st.stade] || climat.global;

    // 1. Coefficients de la culture (courbe en 4 segments, Éq. 6.20)
    const kcb = finite(m.kcb) ? m.kcb : C.coefDuJour(date, P.stades, kcbPts, P.kcbHorsSaison ?? C.KC_MIN);
    const kcS = kcPts ? C.coefDuJour(date, P.stades, kcPts, P.kcHorsSaison ?? kcPts.ini) : null;
    const h = finite(m.h) ? m.h : C.hauteurDuJour(date, P.stades, hMax, { annuel });
    const zr = finite(m.zr) ? m.zr : C.zrDuJour(date, P.stades, P.zr, { annuel, zrMin: P.zrMin ?? 0.2 });
    const tawV = tawDe(zr);
    // Croissance racinaire : sous-sol supposé à la capacité au champ (exemple 8.3)
    if (zr < zrPrec) dr = Math.min(dr, tawV);
    zrPrec = zr;

    // 2. Fraction p du jour (Éq. 8.5, avec l'ETc potentielle de la veille) et seuil de déclenchement
    const etcRef = etcPotPrec ?? (o.methode === 'simple' ? kcS : kcb) * et0;
    const pV = o.ajusterP ? C.pAjuste(P.p ?? 0.5, etcRef) : (P.p ?? 0.5);
    const rawV = pV * tawV;
    const seuil = (finite(o.mad) ? o.mad : pV) * tawV;

    // 3. Apports en début de journée : pluie (part retenue en prévision), ruissellement, irrigation
    const pluieBrute = Math.max(0, m.pluie ?? 0);
    const pluie = prevision ? pluieBrute * o.pluiePrevue : pluieBrute;
    const ro = finite(P.pluieMaxInfiltree) ? Math.max(0, pluie - P.pluieMaxInfiltree) : 0;
    let pNet = pluie - ro;
    if (o.methode === 'simple' && pNet < 0.2 * et0) pNet = 0; // pluies < 0,2 ETo négligées (chap. 8)
    const saisie = irrig.get(date);
    let iNet = saisie ? saisie.net : 0;
    let iBrut = saisie ? saisie.brut : 0;
    let planifiee = null;
    let drDebut = dr - pNet - iNet;

    // 4. Irrigation planifiée sur la prévision : déclenchée quand Dr atteint le seuil (exemple 8.3)
    if (o.planifier && prevision && iNet === 0 && drDebut >= seuil && drDebut > 0.5 &&
        (o.planifierHorsSaison || st.stade !== 'hors') &&
        (!derniereIrrig || C.ecartJours(derniereIrrig, date) >= o.intervalleMin)) {
      let net = drDebut * clamp(o.cible, 0.1, 1);
      if (finite(o.doseMaxNette) && o.doseMaxNette > 0) net = Math.min(net, o.doseMaxNette);
      planifiee = { net, brut: net / efficience };
      iNet = net;
      iBrut = planifiee.brut;
      drDebut -= net;
    }
    if (iNet > 0) derniereIrrig = date;

    // Percolation profonde (Éq. 8.15) : excédent au-delà de la capacité au champ
    let dp = 0;
    if (drDebut < 0) { dp = -drDebut; drDebut = 0; }
    drDebut = Math.min(drDebut, tawV);

    // fw : 1 après une pluie significative, fw du système après irrigation, sinon inchangé (tableau 7.6)
    let fw = fwPrec;
    if (pluie >= o.seuilPluieSignificative) fw = 1;
    else if (iNet > 0) fw = fwSys;
    fwPrec = fw;

    // 5. Stress hydrique (Éq. 8.6)
    const ks = C.ksCalc(drDebut, tawV, pV);
    const rec = {
      date, prevision, stade: st.stade, et0, pluie: pluieBrute, pluieRetenue: pluie, ro, pNet,
      irrigationBrute: iBrut, irrigationNette: iNet, planifiee, saisie: saisie ? saisie.sources : null,
      kcb, h, zr, taw: tawV, raw: rawV, p: pV, seuil, drDebut, dp, ks, fw, stress: ks < 0.999
    };

    if (o.methode === 'double') {
      // 6. Couche évaporante (Éq. 7.3 à 7.14), humectée en début de journée
      const apportSurface = pNet + (iNet > 0 ? iNet / fw : 0);
      const deDebut = Math.max(0, de - apportSurface);
      const drewDebut = Math.max(0, drew - apportSurface);
      const kcMaxV = C.kcMax(clim.u2, clim.hrmin, h, kcb);
      const fc = finite(m.fc) ? m.fc : C.fcDepuisKcb(kcb, kcMaxV, h);
      const few = clamp(C.fewCalc(fc, fw, !!P.goutte && fw < 1) * paillage.facteurFew, 0.01, 1);
      let kr, aS1 = 0;
      if (o.peau) {
        aS1 = C.aStage1(drewDebut, rew, kcMaxV, et0);
        kr = C.krPeau(deDebut, tewV, rew, aS1);
      } else {
        kr = C.krOrigine(deDebut, tewV, rew);
      }
      const ke = C.keCalc(kr, kcMaxV, kcb, few, ks) * paillage.facteurKe;
      const kePot = C.keCalc(kr, kcMaxV, kcb, few, 1) * paillage.facteurKe;
      const t = ks * kcb * et0;
      const e = ke * et0;
      de = clamp(deDebut + e / few, 0, tewV);
      drew = clamp(drewDebut + e / few, 0, rew);
      Object.assign(rec, {
        kcMax: kcMaxV, fc, few, kr, aStage1: aS1, ke, kc: ks * kcb + ke, de, drew,
        transpiration: t, evaporation: e, etcAct: t + e, etcPot: (kcb + kePot) * et0
      });
    } else {
      Object.assign(rec, { kcTable: kcS, kc: ks * kcS, etcAct: ks * kcS * et0, etcPot: kcS * et0 });
    }
    etcPotPrec = rec.etcPot;

    // 7. Fin de journée (Éq. 8.7)
    dr = Math.min(tawV, drDebut + rec.etcAct);
    rec.dr = dr;
    rec.reserve = tawV - dr;
    jours.push(rec);
  }

  return {
    jours,
    climat,
    parametres: { tew: tewV, rew, ruParM, cailloux, fractionHumectee: fHum, efficience, fw: fwSys, kcb: kcbPts, kc: kcPts, options: o }
  };
}

/**
 * Synthèse pour le conseil : état du jour, irrigations planifiées sur J..J+n, bilans.
 */
export function synthese(resultat, aujourdhui, horizon = 7) {
  const { jours } = resultat;
  const idx = jours.findIndex(j => j.date >= aujourdhui);
  const jour = idx >= 0 ? jours[idx] : jours[jours.length - 1];
  const fenetre = idx >= 0 ? jours.slice(idx, idx + horizon + 1) : [];
  const passe7 = jours.filter(j => j.date < aujourdhui).slice(-7);
  const planifiees = fenetre.filter(j => j.planifiee).map(j => ({ date: j.date, net: j.planifiee.net, brut: j.planifiee.brut }));
  const somme = (arr, k) => arr.reduce((s, j) => s + (j[k] || 0), 0);
  const drAvant = idx > 0 ? jours[idx - 1].dr : (jour?.drDebut ?? 0);
  // État du jour avant toute irrigation conseillée (Éq. 8.6 avec Dr de la veille)
  const ksAvant = jour ? C.ksCalc(Math.min(drAvant, jour.taw), jour.taw, jour.p) : null;
  const saisonJours = fenetre.filter(j => j.stade !== 'hors');
  return {
    date: jour?.date,
    stade: jour?.stade,
    horsSaison: !saisonJours.length,
    drDebut: drAvant,
    ksAvant,
    taw: jour?.taw,
    raw: jour?.raw,
    seuil: jour?.seuil,
    ks: jour?.ks,
    fractionRU: jour?.taw > 0 ? 1 - drAvant / jour.taw : null,
    planifiees,
    besoinNet: planifiees.reduce((s, p) => s + p.net, 0),
    besoinBrut: planifiees.reduce((s, p) => s + p.brut, 0),
    etcPrevue: somme(fenetre, 'etcAct'),
    et0Prevue: somme(fenetre, 'et0'),
    pluiePrevue: somme(fenetre, 'pluie'),
    pluieRetenue: somme(fenetre, 'pluieRetenue'),
    joursStress7: passe7.filter(j => j.stress).length,
    etcPasse7: somme(passe7, 'etcAct'),
    pluiePasse7: somme(passe7, 'pluie'),
    irrigationPasse7: somme(passe7, 'irrigationBrute'),
    horizon: fenetre.length ? fenetre[fenetre.length - 1].date : null
  };
}
