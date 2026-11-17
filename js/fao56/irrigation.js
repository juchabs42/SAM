// Conversions d'irrigation : doses nettes et brutes, volumes, pluviométrie et durées de poste.
//
// Dose nette : eau qui reste dans la zone racinaire (I des équations FAO-56).
// Dose brute : eau apportée par le réseau = dose nette / efficience d'application
// (Manuel FAO n° 5, annexe 4 : efficience = dose nette / dose apportée).

const finite = v => typeof v === 'number' && Number.isFinite(v);

/** 1 mm sur 1 ha = 10 m³. */
export const mmVersM3ha = mm => mm * 10;
export const m3haVersMm = m3 => m3 / 10;

export const brutDepuisNet = (net, efficience) => net / Math.max(0.3, efficience || 1);
export const netDepuisBrut = (brut, efficience) => brut * Math.max(0.3, efficience || 1);

/**
 * Pluviométrie horaire (mm/h) d'un goutte-à-goutte ou d'une micro-aspersion :
 * débit par point (L/h) × points par plant / (espacement sur le rang × inter-rang).
 */
export function pluviometrieLocalisee({ debitLh, espacement, interRang, parPoint = 1 }) {
  if (!(debitLh > 0 && espacement > 0 && interRang > 0)) return null;
  return (debitLh * parPoint) / (espacement * interRang);
}

/** Pluviométrie horaire (mm/h) d'une aspersion à partir du débit (m³/h) et de la surface arrosée (ha). */
export function pluviometrieAspersion({ debitM3h, surfaceHa }) {
  if (!(debitM3h > 0 && surfaceHa > 0)) return null;
  return debitM3h / (10 * surfaceHa);
}

/** Durée (h) pour apporter une dose brute (mm) avec une pluviométrie (mm/h). */
export function dureeHeures(brutMm, pluvioMmH) {
  if (!(pluvioMmH > 0) || !finite(brutMm)) return null;
  return brutMm / pluvioMmH;
}

/** Durée lisible : « 45 min », « 1 h 30 », « 12 h » (arrondi aux 5 minutes). */
export function formatDuree(heures) {
  if (!finite(heures) || heures < 0) return '—';
  let min = Math.round((heures * 60) / 5) * 5;
  if (heures > 0 && min === 0) min = 5;
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
}

/**
 * Découpe un besoin brut (mm) en postes : nombre d'apports et durée de chacun, en respectant
 * une durée maximale par poste (h). Renvoie { postes, dureeParPoste (h), doseParPoste (mm) }.
 */
export function decouperPostes(brutMm, pluvioMmH, dureeMaxPoste = null) {
  const total = dureeHeures(brutMm, pluvioMmH);
  if (!finite(total) || total <= 0) return { postes: 0, dureeParPoste: 0, doseParPoste: 0, dureeTotale: 0 };
  const n = finite(dureeMaxPoste) && dureeMaxPoste > 0 ? Math.max(1, Math.ceil(total / dureeMaxPoste - 1e-9)) : 1;
  return { postes: n, dureeParPoste: total / n, doseParPoste: brutMm / n, dureeTotale: total };
}

/**
 * Convertit une saisie d'irrigation en dose brute (mm) : en mm, en m³/ha ou en durée × pluviométrie.
 */
export function brutDepuisSaisie({ unite, valeur, pluvioMmH = null }) {
  if (!finite(valeur) || valeur < 0) return null;
  if (unite === 'mm') return valeur;
  if (unite === 'm3ha') return m3haVersMm(valeur);
  if (unite === 'heures') return finite(pluvioMmH) && pluvioMmH > 0 ? valeur * pluvioMmH : null;
  return null;
}
