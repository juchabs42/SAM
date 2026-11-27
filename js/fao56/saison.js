// Calendrier moyen des stades par espèce — commun au Bilan irrigation et à la Programmation
// irrigation, pour que les deux outils partent des mêmes saisons et des mêmes coefficients.
// Dates indicatives (mois-jour) : début, fin du démarrage, fin de la croissance,
// fin de la pleine végétation, fin de saison.
import * as C from './coefficients.js';

export const STADES_MODELES = {
  precoce: ['03-10', '04-05', '06-01', '08-31', '10-31'],
  pepins: ['03-25', '04-20', '06-15', '09-15', '11-15'],
  tardif: ['04-01', '05-01', '06-30', '09-15', '10-31'],
  vigne: ['04-01', '05-01', '06-15', '08-31', '10-31'],
  persistant: ['03-01', '03-31', '05-31', '09-30', '11-30'],
  prairie: ['03-15', '04-15', '05-31', '09-30', '10-31']
};
export const GROUPE_STADES = {
  pecher: 'precoce', abricotier: 'precoce', prunier: 'precoce', cerisier: 'precoce', amandier: 'precoce',
  pommier: 'pepins', poirier: 'pepins',
  olivier: 'persistant', clementinier: 'persistant', citronnier: 'persistant', oranger: 'persistant', avocatier: 'persistant', neflier: 'persistant',
  'vigne-cuve': 'vigne', 'vigne-table': 'vigne'
};
/** Cultures annuelles : durées (jours) du démarrage, de la croissance, de la pleine végétation, de la fin. */
export const DUREES_ANNUELLES = [25, 35, 40, 20];

export const LIBELLES_STADES = {
  annuel: ['Semis ou plantation', 'Levée terminée', 'Végétation maximale', 'Début de la maturation', 'Récolte'],
  perenne: ['Débourrement', 'Premières feuilles étalées', 'Feuillage complet', 'Début du jaunissement', 'Chute des feuilles']
};
export const NOMS_STADE = { hors: 'Hors saison', ini: 'Démarrage', dev: 'Croissance', mi: 'Pleine végétation', fin: 'Fin de saison' };

export const estAnnuel = cult => cult?.type === 'annuel';

/** Dates des stades de l'année demandée d'après le calendrier moyen de l'espèce. */
export function stadesModele(cult, annee) {
  if (estAnnuel(cult)) return C.stadesDepuisDurees(`${annee}-04-15`, DUREES_ANNUELLES);
  const g = cult.type === 'perenne' ? 'prairie' : (GROUPE_STADES[cult.id] || 'tardif');
  const [a, b, c, d, e] = STADES_MODELES[g];
  return { debut: `${annee}-${a}`, finIni: `${annee}-${b}`, finDev: `${annee}-${c}`, finMi: `${annee}-${d}`, fin: `${annee}-${e}` };
}

/** Durées (jours) des quatre stades du calendrier moyen de l'espèce. */
export function dureesModele(cult, annee = 2026) {
  const m = stadesModele(cult, annee);
  return [
    C.ecartJours(m.debut, m.finIni),
    C.ecartJours(m.finIni, m.finDev),
    C.ecartJours(m.finDev, m.finMi),
    C.ecartJours(m.finMi, m.fin)
  ];
}
