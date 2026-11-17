// Moteur FAO-56 — coefficients culturaux (Kc simple, Kcb + Ke, approche A&P).
//
// Référence : FAO-56 Rev.1 (2025), chapitres 6, 7, 9 et 10. Les numéros d'équations sont ceux
// de l'édition 2025. Fonctions pures, sans dépendance.

import { declinaison } from './meteo.js';

export const KC_MIN = 0.15; // Kcb minimal d'un sol nu (Éq. 7.8 et 9.9)

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const finite = v => typeof v === 'number' && Number.isFinite(v);
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Ajustement climatique (Éq. 6.16, 6.19, 7.2)
// ---------------------------------------------------------------------------

/**
 * Terme d'ajustement climatique [0,04 (u2 − 2) − 0,004 (HRmin − 45)] (h/3)^0,3.
 * Bornes d'application : 1 ≤ u2 ≤ 6 m s⁻¹, 20 ≤ HRmin ≤ 80 %, 0,1 ≤ h ≤ 10 m.
 */
export function ajustementClimat(u2, hrMin, h) {
  const u = clamp(finite(u2) ? u2 : 2, 1, 6);
  const rh = clamp(finite(hrMin) ? hrMin : 45, 20, 80);
  const hh = clamp(finite(h) ? h : 0.5, 0.1, 10);
  return (0.04 * (u - 2) - 0.004 * (rh - 45)) * Math.pow(hh / 3, 0.3);
}

/** Kcb (ou Kc) de mi-saison ajusté au climat — Éq. 7.2 (Kcb) et 6.16 (Kc). */
export function ajusterMi(k, u2, hrMin, h) {
  return k + ajustementClimat(u2, hrMin, h);
}

/** Kcb (ou Kc) de fin de saison ajusté — Éq. 7.2 / 6.19 : seulement si la valeur tabulée ≥ 0,45. */
export function ajusterFin(k, u2, hrMin, h) {
  return k >= 0.45 ? k + ajustementClimat(u2, hrMin, h) : k;
}

/** Kc max, borne supérieure après pluie ou irrigation — Éq. 7.4 (et 9.8). */
export function kcMax(u2, hrMin, h, kcb) {
  return Math.max(1.2 + ajustementClimat(u2, hrMin, h), kcb + 0.05);
}

// ---------------------------------------------------------------------------
// Évaporation du sol (Ke) — chapitre 7
// ---------------------------------------------------------------------------

/** Fraction du sol couverte par la végétation déduite de Kcb — Éq. 7.8 (bornée à 0,99). */
export function fcDepuisKcb(kcb, kcMaxV, h, kcMin = KC_MIN) {
  if (kcb <= kcMin || kcMaxV <= kcMin) return 0;
  return clamp(Math.pow((kcb - kcMin) / (kcMaxV - kcMin), 1 + 0.5 * h), 0, 0.99);
}

/**
 * Fraction de sol exposée et humectée few — Éq. 7.7. En goutte-à-goutte, la FAO conseille
 * de multiplier fw par [1 − (2/3) fc] (l'humectation se fait surtout sous la végétation).
 */
export function fewCalc(fc, fw, goutteAGoutte = false) {
  const fwEff = goutteAGoutte ? fw * (1 - (2 / 3) * fc) : fw;
  return clamp(Math.min(1 - fc, fwEff), 0.01, 1);
}

/** Eau totale évaporable TEW (mm) — Éq. 7.5 ; Ze en m (0,10 à 0,15). */
export function tew(thetaFC, thetaWP, ze = 0.1) {
  return 1000 * (thetaFC - 0.5 * thetaWP) * ze;
}

/** Coefficient de réduction de l'évaporation Kr, procédure d'origine — Éq. 7.6. */
export function krOrigine(de, tewV, rew) {
  if (de <= rew) return 1;
  return clamp((tewV - de) / (tewV - rew), 0, 1);
}

/** Fraction du pas de temps en phase 1 d'évaporation Astage1 — Éq. 7.12. */
export function aStage1(drew, rew, kcMaxV, eto) {
  if (!(kcMaxV * eto > 0)) return 0;
  return clamp((rew - drew) / (kcMaxV * eto), 0, 1);
}

/** Kr avec couche de surface (« skin layer ») — Éq. 7.11. */
export function krPeau(de, tewV, rew, a) {
  const base = clamp((tewV - de) / (tewV - rew), 0, 1);
  return base * (1 - a) + a;
}

/** Coefficient d'évaporation du sol Ke — Éq. 7.3 (Kcb remplacé par Ks·Kcb en cas de stress). */
export function keCalc(kr, kcMaxV, kcb, few, ks = 1) {
  return Math.max(0, Math.min(kr * (kcMaxV - ks * kcb), few * kcMaxV));
}

// ---------------------------------------------------------------------------
// Zone racinaire — chapitre 8
// ---------------------------------------------------------------------------

/** Réserve utile totale TAW (mm) — Éq. 8.3 ; Zr en m. */
export const taw = (thetaFC, thetaWP, zr) => 1000 * (thetaFC - thetaWP) * zr;

/** Fraction p ajustée à l'ETc du jour — Éq. 8.5 (0,1 ≤ p ≤ 0,8). */
export function pAjuste(pTable, etc) {
  return clamp(pTable + 0.04 * (5 - etc), 0.1, 0.8);
}

/** Coefficient de stress hydrique Ks — Éq. 8.6. */
export function ksCalc(dr, tawV, p) {
  const raw = p * tawV;
  if (dr <= raw) return 1;
  if (tawV <= raw) return 0;
  return clamp((tawV - dr) / ((1 - p) * tawV), 0, 1);
}

// ---------------------------------------------------------------------------
// Courbe de Kcb / Kc et stades
// ---------------------------------------------------------------------------

/** Ajoute n jours à une date ISO (AAAA-MM-JJ). */
export function ajouterJours(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Nombre de jours entre deux dates ISO (b − a). */
export function ecartJours(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/**
 * Stades à partir des dates de bornes : début (semis, débourrement…), fin du stade initial,
 * fin du développement (couverture maximale), fin de mi-saison (début sénescence), fin de saison.
 */
export function stadesDepuisDates({ debut, finIni, finDev, finMi, fin }) {
  const s = { debut, finIni, finDev, finMi, fin };
  const ordre = [debut, finIni, finDev, finMi, fin];
  for (let i = 1; i < ordre.length; i++) {
    if (!ordre[i] || !ordre[i - 1] || ordre[i] < ordre[i - 1]) {
      throw new Error('Dates de stades incohérentes : elles doivent se suivre (début ≤ fin initial ≤ fin développement ≤ fin mi-saison ≤ fin).');
    }
  }
  return s;
}

/** Stades à partir d'une date de début et des durées (jours) Lini, Ldev, Lmid, Llate. */
export function stadesDepuisDurees(debut, [lIni, lDev, lMi, lFin]) {
  const finIni = ajouterJours(debut, lIni);
  const finDev = ajouterJours(finIni, lDev);
  const finMi = ajouterJours(finDev, lMi);
  const fin = ajouterJours(finMi, lFin);
  return { debut, finIni, finDev, finMi, fin };
}

/** Stade d'une date : 'hors' | 'ini' | 'dev' | 'mi' | 'fin', avec la fraction écoulée du stade. */
export function stadeDuJour(iso, st) {
  if (iso < st.debut || iso > st.fin) return { stade: 'hors', frac: 0 };
  const seg = [
    ['ini', st.debut, st.finIni],
    ['dev', st.finIni, st.finDev],
    ['mi', st.finDev, st.finMi],
    ['fin', st.finMi, st.fin]
  ];
  for (const [nom, a, b] of seg) {
    if (iso <= b) {
      const L = ecartJours(a, b);
      return { stade: nom, frac: L > 0 ? clamp(ecartJours(a, iso) / L, 0, 1) : 1 };
    }
  }
  return { stade: 'fin', frac: 1 };
}

/**
 * Valeur du coefficient (Kcb ou Kc) pour une date — construction de la courbe en 4 segments,
 * interpolation linéaire Éq. 6.20. v = { ini, mi, fin } (déjà ajustés au climat) ;
 * horsSaison = valeur hors période de culture (sol nu, couvert hivernal…).
 */
export function coefDuJour(iso, st, v, horsSaison = KC_MIN) {
  const { stade, frac } = stadeDuJour(iso, st);
  switch (stade) {
    case 'ini': return v.ini;
    case 'dev': return v.ini + frac * (v.mi - v.ini);
    case 'mi': return v.mi;
    case 'fin': return v.mi + frac * (v.fin - v.mi);
    default: return horsSaison;
  }
}

/** Hauteur de végétation (m) : croissance linéaire pendant le développement (cultures annuelles). */
export function hauteurDuJour(iso, st, hMax, { annuel = true, hIni = 0.1 } = {}) {
  if (!annuel) return hMax;
  const { stade, frac } = stadeDuJour(iso, st);
  if (stade === 'hors') return hIni;
  if (stade === 'ini') return hIni;
  if (stade === 'dev') return hIni + frac * (hMax - hIni);
  return hMax;
}

/**
 * Profondeur racinaire (m) : pour les annuelles, croissance linéaire de Zr min au semis jusqu'à
 * Zr max à la fin du développement (chapitre 8) ; constante pour les cultures pérennes.
 */
export function zrDuJour(iso, st, zrMax, { annuel = true, zrMin = 0.2 } = {}) {
  if (!annuel) return zrMax;
  const { stade, frac } = stadeDuJour(iso, st);
  if (stade === 'hors' || stade === 'ini') {
    if (stade === 'ini') {
      const L = ecartJours(st.debut, st.finDev);
      return zrMin + (L > 0 ? clamp(ecartJours(st.debut, iso) / L, 0, 1) : 1) * (zrMax - zrMin);
    }
    return zrMin;
  }
  if (stade === 'dev') {
    const L = ecartJours(st.debut, st.finDev);
    return zrMin + (L > 0 ? clamp(ecartJours(st.debut, iso) / L, 0, 1) : 1) * (zrMax - zrMin);
  }
  return zrMax;
}

// ---------------------------------------------------------------------------
// Degrés-jours de croissance (Éq. 6.23a–c)
// ---------------------------------------------------------------------------

/** Degrés-jours d'une journée (méthode de la moyenne), plafonnés à Tupper. */
export function degresJours(tmax, tmin, tbase, tupper = Infinity) {
  const tmoy = (tmax + tmin) / 2;
  if (tmoy <= tbase) return 0;
  if (tmoy >= tupper) return tupper - tbase;
  return tmoy - tbase;
}

/**
 * Dates de fin de stades à partir des degrés-jours cumulés depuis la date de début.
 * serie : [{ date, tmax, tmin }] triée ; gdd = { ini, dev, mid, late } (°C·j par stade).
 * Renvoie les dates atteintes (null si la série est trop courte pour atteindre un seuil).
 */
export function stadesDepuisDegresJours(debut, gdd, serie, tbase, tupper) {
  const seuils = [gdd.ini, gdd.ini + gdd.dev, gdd.ini + gdd.dev + gdd.mid, gdd.ini + gdd.dev + gdd.mid + gdd.late];
  const res = [null, null, null, null];
  let cumul = 0;
  let k = 0;
  for (const j of serie) {
    if (j.date < debut || !finite(j.tmax) || !finite(j.tmin)) continue;
    cumul += degresJours(j.tmax, j.tmin, tbase, tupper);
    while (k < 4 && cumul >= seuils[k]) res[k++] = j.date;
    if (k === 4) break;
  }
  return { debut, finIni: res[0], finDev: res[1], finMi: res[2], fin: res[3], cumul };
}

// ---------------------------------------------------------------------------
// Approche A&P : Kcb à partir de la couverture du sol et de la hauteur (chapitre 9)
// ---------------------------------------------------------------------------

/** Facteur de régulation stomatique Fr — Éq. 9.12 ; rl résistance foliaire (s m⁻¹), rtyp = 100. */
export function frStomatique(delta, gamma, u2, rl, rtyp = 100) {
  return (delta + gamma * (1 + 0.34 * u2)) / (delta + gamma * (1 + 0.34 * u2 * (Math.max(rl, rtyp) / rtyp)));
}

/** Kcb à couverture complète Kcb full — Éq. 9.11 ; kh = 0,1 arbres, vigne, cultures hautes ; 0,2 cultures basses. */
export function kcbPlein({ fr = 1, h, u2, hrMin, kh = 0.1 }) {
  return fr * (Math.min(1 + kh * h, 1.2) + ajustementClimat(u2, hrMin, h));
}

/** Coefficient de densité Kd — Éq. 9.13 (fc effectif) ou 9.14 (indice foliaire). */
export function kdDensite({ fcEff = null, ml = 1.5, h = 1, lai = null }) {
  if (finite(lai) && !finite(fcEff)) return 1 - Math.exp(-0.7 * lai);
  const f = clamp(fcEff, 0, 1);
  return Math.min(1, ml * f, Math.pow(f, 1 / (1 + h)));
}

/**
 * Kcb A&P — Éq. 9.9 (sol nu ou inerte) ou 9.10 (verger avec couvert actif, Kcb cover).
 */
export function kcbAP({ kd, kcbFull, kcbCouvert = null, kcMin = KC_MIN }) {
  if (finite(kcbCouvert) && kcbCouvert > 0) {
    return kcbCouvert + kd * Math.max(kcbFull - kcbCouvert, (kcbFull - kcbCouvert) / 2);
  }
  return kcMin + kd * (kcbFull - kcMin);
}

/** Sinus de la hauteur du soleil à midi solaire (Encadré 9.2) ; latitude en degrés. */
export function sinHauteurSoleilMidi(latitude, J) {
  const phi = latitude * DEG;
  const d = declinaison(J);
  return Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d);
}

/** fc effectif d'arbres à couronne arrondie : fc / sin(η) ≤ 1 (Encadré 9.2). */
export function fcEffArbres(fc, latitude, J) {
  return clamp(fc / Math.max(0.05, sinHauteurSoleilMidi(latitude, J)), 0, 1);
}

/**
 * fc effectif de rangs (haies fruitières, vigne palissée) : fc (1 + HWR / tan η) ≤ 1, avec
 * HWR = hauteur de la végétation × cos(Γ) / largeur ; Γ = angle du rang par rapport à
 * l'axe est-ouest (0° pour des rangs est-ouest, 90° pour des rangs nord-sud) — Encadré 9.2.
 */
export function fcEffRangs(fc, { hauteurCanopee, largeur, angleRangDeg = 90, latitude, J }) {
  const sinE = clamp(sinHauteurSoleilMidi(latitude, J), 0.05, 1);
  const tanE = sinE / Math.sqrt(Math.max(1e-6, 1 - sinE * sinE));
  const hwr = (hauteurCanopee * Math.abs(Math.cos(angleRangDeg * DEG))) / Math.max(0.05, largeur);
  return clamp(fc * (1 + hwr / tanE), 0, 1);
}

// ---------------------------------------------------------------------------
// Paillages (chapitre 10)
// ---------------------------------------------------------------------------

/**
 * Effet d'un paillage sur l'évaporation du sol, en approche Kcb + Ke :
 * – plastique : fw représente la surface encore évaporante (trous de plantation, avec un
 *   facteur 2 à 4 sur leur surface physique, et sol humecté non couvert) ;
 * – organique : évaporation réduite d'environ 5 % pour chaque 10 % de surface couverte.
 * couverture = fraction du sol couverte (0–1) ; trous = fraction équivalente évaporante sous plastique.
 */
export function effetPaillage(type, couverture = 0, trous = 0.05) {
  const c = clamp(couverture || 0, 0, 1);
  if (type === 'plastique') return { facteurFew: clamp(1 - c + c * trous, 0.01, 1), facteurKe: 1 };
  if (type === 'organique') return { facteurFew: 1, facteurKe: 1 - 0.5 * c };
  return { facteurFew: 1, facteurKe: 1 };
}

// ---------------------------------------------------------------------------
// Texture du sol (triangle USDA) — utile pour reprendre les parcelles existantes (argile/limon/sable)
// ---------------------------------------------------------------------------

/** Classe de texture USDA (identifiants de references.js) à partir de % argile, limon (silt), sable. */
export function classeTextureUSDA(argile, limon, sable) {
  const tot = argile + limon + sable;
  if (!(tot > 0)) return null;
  const a = (100 * argile) / tot, l = (100 * limon) / tot, s = (100 * sable) / tot;
  if (l + 1.5 * a < 15) return 'sand';
  if (l + 2 * a < 30) return 'loamy-sand';
  if ((a >= 7 && a < 20 && s > 52) || (a < 7 && l < 50)) return 'sandy-loam';
  if (a >= 7 && a < 27 && l >= 28 && l < 50 && s <= 52) return 'loam';
  if (l >= 80 && a < 12) return 'silt';
  if (l >= 50 && a < 27) return 'silt-loam';
  if (a >= 20 && a < 35 && l < 28 && s > 45) return 'sandy-clay-loam';
  if (a >= 27 && a < 40 && s > 20 && s <= 45) return 'clay-loam';
  if (a >= 27 && a < 40 && s <= 20) return 'silty-clay-loam';
  if (a >= 35 && s > 45) return 'sandy-clay';
  if (a >= 40 && l >= 40) return 'silty-clay';
  if (a >= 40) return 'clay';
  return 'loam';
}
