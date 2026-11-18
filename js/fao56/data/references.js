// Tables de référence FAO-56 Rev.1 (2025) utilisées par le moteur (sols, irrigation, paillages)
// et valeurs par défaut de terrain, clairement signalées comme telles.

const S = (t, p) => `FAO-56 Rev.1 (2025), tableau ${t}, p. ${p}`;

/**
 * Tableau 7.5 — Caractéristiques hydriques types des sols (classification texturale USDA).
 * Valeurs par défaut = milieu des fourchettes ; θ en m³ m⁻³, REW et TEW (Ze = 0,10 m) en mm.
 */
export const SOLS = [
  { id: 'sand', nom: 'Sableux', nom_en: 'Sand', fc: [0.07, 0.17], wp: [0.02, 0.07], rew: [2, 7], tew: [6, 12] },
  { id: 'loamy-sand', nom: 'Sablo-limoneux', nom_en: 'Loamy sand', fc: [0.11, 0.19], wp: [0.03, 0.10], rew: [4, 8], tew: [9, 14] },
  { id: 'sandy-loam', nom: 'Limono-sableux', nom_en: 'Sandy loam', fc: [0.18, 0.28], wp: [0.06, 0.16], rew: [6, 10], tew: [15, 20] },
  { id: 'loam', nom: 'Limoneux équilibré (terre franche)', nom_en: 'Loam', fc: [0.20, 0.30], wp: [0.07, 0.17], rew: [8, 10], tew: [16, 22] },
  { id: 'silt-loam', nom: 'Limoneux fin', nom_en: 'Silt loam', fc: [0.22, 0.36], wp: [0.09, 0.21], rew: [8, 11], tew: [18, 25] },
  { id: 'silt', nom: 'Limon très fin', nom_en: 'Silt', fc: [0.28, 0.36], wp: [0.12, 0.22], rew: [8, 11], tew: [22, 26] },
  { id: 'silty-clay-loam', nom: 'Limono-argileux', nom_en: 'Silt clay loam', fc: [0.30, 0.37], wp: [0.17, 0.24], rew: [8, 11], tew: [22, 27] },
  { id: 'silty-clay', nom: 'Argilo-limoneux', nom_en: 'Silty clay', fc: [0.30, 0.42], wp: [0.17, 0.29], rew: [8, 12], tew: [22, 28] },
  { id: 'clay', nom: 'Argileux', nom_en: 'Clay', fc: [0.32, 0.40], wp: [0.20, 0.24], rew: [8, 12], tew: [22, 29] }
].map(s => ({
  ...s,
  thetaFC: +((s.fc[0] + s.fc[1]) / 2).toFixed(3),
  thetaWP: +((s.wp[0] + s.wp[1]) / 2).toFixed(3),
  rewDefaut: (s.rew[0] + s.rew[1]) / 2,
  src: S('7.5', 232)
}));

/** Classes du triangle USDA absentes des sols types : on reprend la classe voisine (signalé). */
export const SOLS_VOISINS = {
  'sandy-clay-loam': { id: 'sandy-loam', nom: 'Limono-argilo-sableux', note: 'Limono-argilo-sableux : valeurs du sol limono-sableux' },
  'clay-loam': { id: 'silty-clay-loam', nom: 'Limon argileux', note: 'Limon argileux : valeurs du sol limono-argileux' },
  'sandy-clay': { id: 'clay', nom: 'Argilo-sableux', note: 'Argilo-sableux : valeurs du sol argileux' }
};

export const solParId = id => SOLS.find(s => s.id === id) || (SOLS_VOISINS[id] ? SOLS.find(s => s.id === SOLS_VOISINS[id].id) : null);

/**
 * Systèmes d'irrigation : fraction humectée fw (tableau 7.6) et efficience d'application par
 * défaut. L'efficience (dose nette / dose apportée, Manuel FAO n° 5, annexe 4) n'est pas
 * tabulée par la FAO : les valeurs proposées sont INDICATIVES et doivent être ajustées
 * (mesure d'uniformité, état du réseau).
 */
export const SYSTEMES = [
  { id: 'goutte-a-goutte', nom: 'Goutte-à-goutte', fw: [0.3, 0.4], fwDefaut: 0.35, goutte: true, efficience: 0.9, frequent: true },
  { id: 'micro-aspersion', nom: 'Micro-aspersion (vergers)', fw: [0.5, 0.8], fwDefaut: 0.65, efficience: 0.85, frequent: true },
  { id: 'aspersion-verger', nom: 'Aspersion sous les arbres (vergers)', fw: [0.7, 1.0], fwDefaut: 0.85, efficience: 0.75 },
  { id: 'aspersion', nom: 'Aspersion (grandes cultures, maraîchage)', fw: [1, 1], fwDefaut: 1, efficience: 0.75 },
  { id: 'pivot', nom: 'Pivot / rampe', fw: [1, 1], fwDefaut: 1, efficience: 0.8 },
  { id: 'raie-etroite', nom: 'À la raie, toutes les raies (planches étroites)', fw: [0.6, 1.0], fwDefaut: 0.8, efficience: 0.6 },
  { id: 'raie-large', nom: 'À la raie, toutes les raies (planches larges)', fw: [0.4, 0.6], fwDefaut: 0.5, efficience: 0.6 },
  { id: 'raie-alternee', nom: 'À la raie, une raie sur deux', fw: [0.3, 0.5], fwDefaut: 0.4, efficience: 0.6 },
  { id: 'submersion', nom: 'Submersion / calant', fw: [1, 1], fwDefaut: 1, efficience: 0.6 }
].map(s => ({ ...s, src: S('7.6', 236), srcEfficience: 'Valeur indicative (définition : Manuel FAO n° 5, annexe 4)' }));

export const systemeParId = id => SYSTEMES.find(s => s.id === id) || null;

/** fw après une pluie significative (tableau 7.6) et seuil retenu pour « significative ». */
export const FW_PLUIE = 1.0;
export const PLUIE_SIGNIFICATIVE_MM = 3;

/** Tableau 7.7 — Valeurs indicatives de fc par stade. */
export const FC_STADES = { ini: [0, 0.1], dev: [0.1, 0.8], mi: [0.8, 1.0], fin: [0.8, 0.2], src: S('7.7', 236) };

/** Tableau 7.4 — Règles pour dériver Kcb de Kc quand la publication ne donne pas Kcb. */
export const KCB_DEPUIS_KC = {
  ini: [
    'Culture annuelle, sol (presque) nu : 0,15',
    'Culture pérenne, sol (presque) nu : 0,15 – 0,20',
    'Herbacées, broussailles et arbres après gel destructeur : 0,30 – 0,40',
    'Pérenne avec couvert, irrigation peu fréquente : Kc ini − 0,1',
    'Pérenne avec couvert, irrigation fréquente (micro, goutte-à-goutte) : Kc ini − 0,2'
  ],
  mi: ['Couverture > 80 % : Kc mid − 0,05', 'Couverture < 80 % : Kc mid − 0,10', 'Ajustement climatique (Éq. 7.2)'],
  fin: ['Irrigation ou humectation peu fréquente : Kc end − 0,05', 'Fréquente : Kc end − 0,10 (ajustement Éq. 7.2 si Kcb > 0,45)'],
  src: S('7.4', 227)
};

/** Tableau 10.1 — Réductions approximatives (%) de Kc sous paillage, irrigation localisée. */
export const PAILLAGE_KC = [
  { cultures: 'Grandes cultures (maïs, sorgho, blé…)', paillage: 'films plastiques', debut: [5, 25], mi: [5, 10], fin: [5, 10] },
  { cultures: 'Coton', paillage: 'plastique et paille', debut: [15, 35], mi: [5, 10], fin: [5, 10] },
  { cultures: 'Canne à sucre', paillage: 'organique', debut: [15, 35], mi: [10, 15], fin: [10, 15] },
  { cultures: 'Légumes (tomate, concombre, oignon…)', paillage: 'plastique et paille', debut: [10, 35], mi: [5, 10], fin: [5, 10] },
  { cultures: 'Arbres fruitiers et vigne', paillage: 'plastique et organique', debut: [15, 35], mi: [10, 25], fin: [10, 25] }
].map(r => ({ ...r, src: S('10.1', 330) }));

/** Tableau 10.2 — Réductions approximatives (%) de l'évaporation du sol et de Kc. */
export const PAILLAGE_ES = [
  { parametre: 'Es', paillage: 'Paille', debut: [30, 42], mi: [26, 36], fin: [19, 36] },
  { parametre: 'Es', paillage: 'Film plastique', debut: [38, 58], mi: [31, 51], fin: [25, 34] },
  { parametre: 'Kc', paillage: 'Paille', debut: [14, 34], mi: [8, 17], fin: [8, 17] },
  { parametre: 'Kc', paillage: 'Film plastique', debut: [15, 35], mi: [9, 20], fin: [5, 19] },
  { parametre: 'Kc', paillage: 'Plastique noir', debut: [23, 43], mi: [12, 19], fin: [12, 20] },
  { parametre: 'Kc', paillage: 'Plastique transparent', debut: [15, 24], mi: [9, 22], fin: [3, 16] },
  { parametre: 'Kc', paillage: 'Plastique blanc', debut: [27, 33], mi: null, fin: [22, 25] }
].map(r => ({ ...r, src: S('10.2', 330) }));

/** Classes de climat (indice d'aridité UNEP) pour Tdew ≈ Tmin − aT (Éq. 2.6) et kRs (Éq. 3.54). */
export const CLIMATS = [
  { id: 'humide', nom: 'Humide (IA ≥ 0,65)', aT: 0, kRs: 'humide' },
  { id: 'subhumide-sec', nom: 'Subhumide sec (0,50 ≤ IA < 0,65)', aT: 0.5, kRs: 'subhumide' },
  { id: 'semi-aride', nom: 'Semi-aride (0,20 ≤ IA < 0,50)', aT: 1.5, kRs: 'semi-aride' },
  { id: 'aride', nom: 'Aride (0,05 ≤ IA < 0,20)', aT: 2.5, kRs: 'aride' }
];

/**
 * Valeurs par défaut de terrain, hors FAO-56 (affichées comme telles dans l'outil).
 */
export const DEFAUTS_TERRAIN = {
  zrLigneux: { valeur: 0.8, note: 'Profondeur racinaire des ligneux non tabulée (tableau 6.3) : 0,8 m par défaut, à ajuster (fosse, sondes).' },
  zrMinAnnuel: { valeur: 0.2, note: 'Profondeur racinaire au semis/plantation (0,15–0,20 m).' },
  fractionHumectee: { valeur: 1, note: 'Fraction du volume racinaire humecté (irrigation localisée). 1 = méthode FAO (pas de réduction).' },
  pluiePrevue: { valeur: 0.5, note: 'Part de la pluie prévue prise en compte dans le calcul des apports (prévision incertaine).' }
};
