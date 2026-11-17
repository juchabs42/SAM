// Moteur FAO-56 — paramètres météorologiques et évapotranspiration de référence (ET₀).
//
// Référence : FAO (2025). Crop evapotranspiration – Guidelines for computing crop water
// requirements. Second edition, revised 2025. FAO Irrigation and Drainage Paper No. 56 Rev.1.
// https://doi.org/10.4060/cd6621en — les numéros d'équations cités sont ceux de cette édition.
//
// Fonctions pures, sans dépendance : utilisables dans le navigateur et dans Node (tests).
// Unités : températures en °C, pressions en kPa, rayonnements en MJ m⁻² j⁻¹ (ou h⁻¹),
// vent en m s⁻¹, ET en mm j⁻¹ (ou h⁻¹).

export const LAMBDA = 2.45;                 // chaleur latente de vaporisation, MJ kg⁻¹ (§ λ, ch. 3)
export const GSC = 0.0820;                  // constante solaire, MJ m⁻² min⁻¹
export const SIGMA_JOUR = 4.903e-9;         // Stefan-Boltzmann, MJ K⁻⁴ m⁻² j⁻¹
export const SIGMA_HEURE = 4.903e-9 / 24;   // Stefan-Boltzmann, MJ K⁻⁴ m⁻² h⁻¹
export const ALBEDO_REF = 0.23;             // albédo du gazon de référence

const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const finite = v => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------------------
// Paramètres atmosphériques
// ---------------------------------------------------------------------------

/** Pression atmosphérique (kPa) selon l'altitude z (m) — Éq. 3.1. */
export function pression(z = 0) {
  return 101.3 * Math.pow((293 - 0.0065 * z) / 293, 5.26);
}

/** Constante psychrométrique γ (kPa °C⁻¹) — Éq. 3.3 (cp = 1,013·10⁻³, ε = 0,622, λ = 2,45). */
export function psychrometrique(P) {
  return 0.665e-3 * P;
}

/** Pression de vapeur saturante e°(T) (kPa) — Éq. 3.6. */
export function eSat(T) {
  return 0.6108 * Math.exp((17.27 * T) / (T + 237.3));
}

/** Pression de vapeur saturante moyenne es (kPa) à partir de Tmax et Tmin — Éq. 3.7. */
export function esMoyenne(Tmax, Tmin) {
  return (eSat(Tmax) + eSat(Tmin)) / 2;
}

/** Pente Δ de la courbe de pression de vapeur saturante (kPa °C⁻¹) — Éq. 3.8. */
export function pente(T) {
  return (4098 * eSat(T)) / Math.pow(T + 237.3, 2);
}

/** Température de rosée (°C) à partir de la pression de vapeur ea (kPa) — Éq. 3.10. */
export function tRosee(ea) {
  const l = Math.log(ea / 0.6108);
  return (237.3 * l) / (17.27 - l);
}

// ---------------------------------------------------------------------------
// Pression de vapeur réelle ea (kPa)
// ---------------------------------------------------------------------------

/** ea à partir de la température de rosée — Éq. 3.9. */
export const eaRosee = Tdew => eSat(Tdew);

/** ea à partir d'un psychromètre (bulbes sec et humide) — Éq. 3.11 et 3.12. */
export function eaPsychrometre(Tsec, Thumide, P, apsy = 0.000662) {
  return eSat(Thumide) - apsy * P * (Tsec - Thumide);
}

/** ea à partir de HRmax et HRmin (%) — Éq. 3.13 (méthode recommandée). */
export function eaHrMinMax(Tmax, Tmin, HRmax, HRmin) {
  return (eSat(Tmin) * HRmax / 100 + eSat(Tmax) * HRmin / 100) / 2;
}

/** ea à partir de HRmax seule (si HRmin douteuse) — Éq. 3.14. */
export function eaHrMax(Tmin, HRmax) {
  return eSat(Tmin) * HRmax / 100;
}

/** ea à partir de HRmoy, Tmax et Tmin — Éq. 3.16 (moins précise). */
export function eaHrMoy(Tmax, Tmin, HRmoy) {
  return (HRmoy / 100) * esMoyenne(Tmax, Tmin);
}

/**
 * ea estimée à partir de Tmin quand l'humidité manque — Éq. 2.6 et 2.7 :
 * Tdew = Tmin − aT, aT selon l'aridité (indice UNEP) : 0 °C en climat humide et
 * subhumide humide, 0–1 °C subhumide sec, 1–2 °C semi-aride, 2–3 °C aride, 4–6 °C hyper-aride.
 */
export function eaDepuisTmin(Tmin, aT = 0) {
  return eSat(Tmin - aT);
}

/** Valeur de aT (°C) par défaut selon la classe de climat (milieu des fourchettes, Éq. 2.6). */
export const AT_PAR_CLIMAT = {
  humide: 0,          // AI ≥ 0,65
  'subhumide-sec': 0.5, // 0,50 ≤ AI < 0,65
  'semi-aride': 1.5,  // 0,20 ≤ AI < 0,50
  aride: 2.5,         // 0,05 ≤ AI < 0,20
  'hyper-aride': 5    // AI < 0,05
};

// ---------------------------------------------------------------------------
// Rayonnement
// ---------------------------------------------------------------------------

/** Numéro du jour dans l'année (1–366) pour une date ISO AAAA-MM-JJ. */
export function jourAnnee(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 86400000);
}

/** Distance relative inverse Terre-Soleil dr — Éq. 3.20. */
export const dr = J => 1 + 0.033 * Math.cos((2 * Math.PI * J) / 365);

/** Déclinaison solaire δ (rad) — Éq. 3.21. */
export const declinaison = J => 0.409 * Math.sin((2 * Math.PI * J) / 365 - 1.39);

/** Angle horaire du coucher du soleil ωs (rad) — Éq. 3.22 (bornée pour les hautes latitudes). */
export function angleCoucher(phi, delta) {
  return Math.acos(clamp(-Math.tan(phi) * Math.tan(delta), -1, 1));
}

/** Rayonnement extraterrestre journalier Ra (MJ m⁻² j⁻¹) — Éq. 3.18 ; latitude en degrés. */
export function raJour(latitude, J) {
  const phi = latitude * DEG;
  const delta = declinaison(J);
  const ws = angleCoucher(phi, delta);
  return ((24 * 60) / Math.PI) * GSC * dr(J) *
    (ws * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.sin(ws));
}

/** Durée du jour N (h) — Éq. 3.31. */
export function dureeJour(latitude, J) {
  return (24 / Math.PI) * angleCoucher(latitude * DEG, declinaison(J));
}

/** Correction saisonnière du temps solaire Sc (h) — Éq. 3.29 et 3.30. */
export function correctionSaisonniere(J) {
  const b = (2 * Math.PI * (J - 81)) / 364;
  return 0.1645 * Math.sin(2 * b) - 0.1255 * Math.cos(b) - 0.025 * Math.sin(b);
}

/**
 * Angle horaire solaire au milieu de la période ω (rad) — Éq. 3.28.
 * t : heure légale au milieu de la période (h) ; Lz, Lm : longitudes (degrés OUEST de Greenwich)
 * du centre du fuseau horaire et du site.
 */
export function angleHoraire(t, Lz, Lm, J) {
  return (Math.PI / 12) * ((t + 0.06667 * (Lz - Lm) + correctionSaisonniere(J)) - 12);
}

/** Rayonnement extraterrestre horaire Ra (MJ m⁻² h⁻¹) — Éq. 3.25 à 3.27 ; t1 = durée (h). */
export function raHeure(latitude, J, t, Lz, Lm, t1 = 1) {
  const phi = latitude * DEG;
  const delta = declinaison(J);
  const ws = angleCoucher(phi, delta);
  const w = angleHoraire(t, Lz, Lm, J);
  let w1 = w - (Math.PI * t1) / 24;
  let w2 = w + (Math.PI * t1) / 24;
  // Soleil sous l'horizon : bornes ramenées à ±ωs
  w1 = clamp(w1, -ws, ws);
  w2 = clamp(w2, -ws, ws);
  if (w1 >= w2) return 0;
  const ra = ((12 * 60) / Math.PI) * GSC * dr(J) *
    ((w2 - w1) * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * (Math.sin(w2) - Math.sin(w1)));
  return Math.max(0, ra);
}

/** Rayonnement solaire par la formule d'Angström Rs (MJ m⁻² j⁻¹) — Éq. 3.32. */
export function rsAngstrom(n, N, Ra, as = 0.25, bs = 0.5) {
  return (as + bs * (n / N)) * Ra;
}

/** Rayonnement par ciel clair Rso, approximation selon l'altitude — Éq. 3.34. */
export function rsoAltitude(Ra, z = 0) {
  return (0.75 + 2e-5 * z) * Ra;
}

/**
 * Rayonnement par ciel clair Rso, composantes directe et diffuse — Éq. 3.35 à 3.39 (pas journalier).
 * P en kPa, ea en kPa, latitude en degrés ; kt = coefficient de clarté (1 = air propre).
 */
export function rsoComplet(Ra, P, ea, latitude, J, kt = 1) {
  const phi = latitude * DEG;
  const sinB = Math.max(0.01, Math.sin(0.85 + 0.3 * phi * Math.sin((2 * Math.PI * J) / 365 - 1.39) - 0.42 * phi * phi));
  const W = 0.14 * ea * P + 2.1;
  const KB = 0.98 * Math.exp((-0.00146 * P) / (kt * sinB) - 0.075 * Math.pow(W / sinB, 0.4));
  const KD = KB >= 0.15 ? 0.35 - 0.36 * KB : 0.18 + 0.82 * KB;
  return (KB + KD) * Ra;
}

/** Rayonnement net de courtes longueurs d'onde Rns — Éq. 3.41. */
export const rns = (Rs, albedo = ALBEDO_REF) => (1 - albedo) * Rs;

/**
 * Rayonnement net de grandes longueurs d'onde Rnl — Éq. 3.42.
 * Rs/Rso est borné à 1,0 (consigne FAO) et, par sécurité numérique, à 0,3 au minimum
 * (borne de la norme ASCE-EWRI 2005, évite un terme de nébulosité négatif).
 */
export function rnl(Tmax, Tmin, ea, Rs, Rso, sigma = SIGMA_JOUR) {
  const tk4 = (Math.pow(Tmax + 273.15, 4) + Math.pow(Tmin + 273.15, 4)) / 2;
  const ratio = Rso > 0 ? clamp(Rs / Rso, 0.3, 1) : 0.3;
  return sigma * tk4 * (0.34 - 0.14 * Math.sqrt(Math.max(0, ea))) * (1.35 * ratio - 0.35);
}

/**
 * Rnl au pas horaire (MJ m⁻² h⁻¹) — Éq. 3.42 avec σ horaire et la température de l'heure.
 * La nuit, Rs/Rso n'existe pas : on reprend le rapport de la fin d'après-midi (≈ 2–3 h avant
 * le coucher) ou, à défaut, 0,8 en climat sec à 0,4–0,6 en climat humide (exemple 4.3).
 */
export function rnlHoraire(T, ea, rapportRsRso) {
  const ratio = clamp(rapportRsRso, 0.3, 1);
  return SIGMA_HEURE * Math.pow(T + 273.15, 4) * (0.34 - 0.14 * Math.sqrt(Math.max(0, ea))) * (1.35 * ratio - 0.35);
}

/** Flux de chaleur dans le sol mensuel — Éq. 3.46 (mois suivant connu) ou 3.47. */
export function gMois(Tprec, Tsuiv = null, Tmois = null) {
  if (finite(Tsuiv)) return 0.07 * (Tsuiv - Tprec);
  return 0.14 * (Tmois - Tprec);
}

/** Flux de chaleur dans le sol horaire — Éq. 3.48 (jour, Rn ≥ 0) et 3.49 (nuit). */
export const gHeure = Rn => (Rn >= 0 ? 0.1 * Rn : 0.5 * Rn);

/** Vent à 2 m à partir d'une mesure à z m au-dessus d'un gazon — Éq. 3.50. */
export function vent2m(uz, z = 10) {
  if (Math.abs(z - 2) < 1e-9) return uz;
  return (uz * 4.87) / Math.log(67.8 * z - 5.42);
}

/**
 * Coefficient kRs de la formule de Hargreaves (°C⁻⁰·⁵) estimé par régression climatique —
 * Éq. 3.53 (générale) et 3.54a–d (selon la classe d'aridité). Moyennes de longue durée :
 * tdMoy = Tmax − Tmin (°C), u2Moy (m s⁻¹), hrMoy (%).
 */
export function kRsRegression(tdMoy, u2Moy, hrMoy, climat = null) {
  const coef = {
    null: [0.3648, -0.0099, 0.0194, -0.0017],
    aride: [0.2169, -0.0042, 0.0352, -0.0011],          // AI < 0,20 (aride et hyper-aride)
    'semi-aride': [0.3880, -0.0095, 0.0224, -0.0022],   // 0,20 ≤ AI < 0,50
    subhumide: [0.3958, -0.0105, 0.0186, -0.0021],      // 0,50 ≤ AI < 1,00
    humide: [0.5191, -0.0104, 0.0188, -0.0035]          // AI ≥ 1,00
  }[climat] || [0.3648, -0.0099, 0.0194, -0.0017];
  return coef[0] + coef[1] * tdMoy + coef[2] * u2Moy + coef[3] * hrMoy;
}

/** Rayonnement solaire estimé par l'écart de température (Hargreaves) — Éq. 3.52, borné à Rso. */
export function rsTemperature(Tmax, Tmin, Ra, kRs = 0.16, Rso = Infinity) {
  return Math.min(kRs * Math.sqrt(Math.max(0, Tmax - Tmin)) * Ra, Rso);
}

// ---------------------------------------------------------------------------
// ET₀
// ---------------------------------------------------------------------------

/**
 * ET₀ FAO Penman-Monteith au pas journalier (mm j⁻¹) — Éq. 2.4.
 * T = température moyenne journalière (moyenne de Tmax et Tmin, Éq. 3.4).
 */
export function et0Journaliere({ T, Rn, G = 0, u2, es, ea, P }) {
  const D = pente(T);
  const g = psychrometrique(P);
  const num = 0.408 * D * (Rn - G) + g * (900 / (T + 273)) * u2 * (es - ea);
  return num / (D + g * (1 + 0.34 * u2));
}

/**
 * ET₀ FAO Penman-Monteith au pas horaire (mm h⁻¹) — Éq. 2.5a (jour, Rn ≥ 0, rs = 50 s m⁻¹)
 * et 2.5b (nuit, Rn < 0, rs = 200 s m⁻¹).
 */
export function et0Horaire({ T, Rn, G, u2, es, ea, P }) {
  const D = pente(T);
  const g = psychrometrique(P);
  const cd = Rn >= 0 ? 0.24 : 0.96;
  const Gv = finite(G) ? G : gHeure(Rn);
  const num = 0.408 * D * (Rn - Gv) + g * (37 / (T + 273)) * u2 * (es - ea);
  return num / (D + g * (1 + cd * u2));
}

/** ET₀ de Hargreaves-Samani (mm j⁻¹) — Éq. 3.55 ; kRsHS = 0,17 par défaut (formulation originale). */
export function et0HargreavesSamani(Tmax, Tmin, Ra, kRsHS = 0.17) {
  const Tmoy = (Tmax + Tmin) / 2;
  return Math.max(0, 0.0135 * kRsHS * (Ra / LAMBDA) * Math.sqrt(Math.max(0, Tmax - Tmin)) * (Tmoy + 17.8));
}

/** Coefficient kRs HS par régression climatique — Éq. 3.56 et 3.57a–d. */
export function kRsHSRegression(tdMoy, u2Moy, hrMoy, climat = null) {
  const coef = {
    aride: [0.207, -0.0023, 0.0224, -0.0009],
    'semi-aride': [0.296, -0.0049, 0.0117, -0.0014],
    subhumide: [0.340, -0.0059, 0.0125, -0.0020],
    humide: [0.370, -0.0066, 0.0127, -0.0024]
  }[climat] || [0.302, -0.0049, 0.0151, -0.0017];
  return coef[0] + coef[1] * tdMoy + coef[2] * u2Moy + coef[3] * hrMoy;
}

/**
 * Calcul complet d'une journée, avec les procédures FAO pour données manquantes (ch. 2 et 3).
 *
 * jour : { date, tmax, tmin, [hrmax, hrmin | hrmoy | tdew | ea], [u2 | uz + zVent],
 *          [rs | insolation (h)] }
 * site : { latitude (°), altitude (m), kRs (Hargreaves, 0,16 intérieur / 0,19 littoral),
 *          aT (correction Tdew = Tmin − aT), u2Defaut (2 m s⁻¹), rsoMethode ('altitude'|'complet') }
 *
 * Renvoie l'ET₀ et toutes les grandeurs intermédiaires, avec la liste des estimations faites.
 */
export function calculerJour(jour, site = {}) {
  const estimations = [];
  const latitude = site.latitude ?? 45;
  const z = site.altitude ?? 0;
  const J = jourAnnee(jour.date);
  const P = pression(z);
  const { tmax, tmin } = jour;
  if (!finite(tmax) || !finite(tmin)) {
    return { date: jour.date, et0: null, erreur: 'Tmax et Tmin sont indispensables (données minimales FAO)' };
  }
  const T = (tmax + tmin) / 2;
  const es = esMoyenne(tmax, tmin);

  // Humidité
  let ea;
  if (finite(jour.ea)) ea = jour.ea;
  else if (finite(jour.tdew)) ea = eaRosee(jour.tdew);
  else if (finite(jour.hrmax) && finite(jour.hrmin)) ea = eaHrMinMax(tmax, tmin, jour.hrmax, jour.hrmin);
  else if (finite(jour.hrmax)) ea = eaHrMax(tmin, jour.hrmax);
  else if (finite(jour.hrmoy)) ea = eaHrMoy(tmax, tmin, jour.hrmoy);
  else {
    ea = eaDepuisTmin(tmin, site.aT ?? 0);
    estimations.push('humidité : Tdew ≈ Tmin − aT (Éq. 2.6)');
  }
  ea = Math.min(ea, es); // ea ne peut dépasser es

  // Vent
  let u2;
  if (finite(jour.u2)) u2 = jour.u2;
  else if (finite(jour.uz)) u2 = vent2m(jour.uz, jour.zVent ?? 10);
  else {
    u2 = site.u2Defaut ?? 2;
    estimations.push(`vent : ${u2} m/s par défaut (tableau 3.2)`);
  }
  // u2 ≥ 0,5 m s⁻¹ pour tenir compte de l'instabilité par vent calme (recommandation FAO)
  u2 = Math.max(0.5, u2);

  // Rayonnement
  const Ra = raJour(latitude, J);
  const N = dureeJour(latitude, J);
  const Rso = site.rsoMethode === 'complet' ? rsoComplet(Ra, P, ea, latitude, J) : rsoAltitude(Ra, z);
  let Rs;
  if (finite(jour.rs)) Rs = jour.rs;
  else if (finite(jour.insolation)) Rs = rsAngstrom(jour.insolation, N, Ra);
  else {
    Rs = rsTemperature(tmax, tmin, Ra, site.kRs ?? 0.16, Rso);
    estimations.push(`rayonnement : Hargreaves, kRs = ${site.kRs ?? 0.16} (Éq. 3.52)`);
  }
  Rs = Math.max(0, Rs);
  const Rns = rns(Rs);
  const Rnl = rnl(tmax, tmin, ea, Rs, Rso);
  const Rn = Rns - Rnl;
  const G = finite(jour.g) ? jour.g : 0; // G ≈ 0 au pas journalier (Éq. 3.45)
  const et0 = Math.max(0, et0Journaliere({ T, Rn, G, u2, es, ea, P }));
  return { date: jour.date, et0, T, es, ea, vpd: es - ea, u2, Ra, N, Rs, Rso, Rns, Rnl, Rn, G, P, J, estimations };
}

/**
 * Humidité relative minimale estimée (si non mesurée) pour les ajustements climatiques
 * des Kc — Éq. 6.17 (à partir de Tdew) ou 6.18 (à partir de Tmin).
 */
export function hrMinEstimee(Tmax, { tdew = null, tmin = null } = {}) {
  const base = finite(tdew) ? eSat(tdew) : eSat(tmin);
  return clamp((100 * base) / eSat(Tmax), 0, 100);
}
