// Tests du bilan hydrique : exemples 7.1, 7.9 et 8.3 de FAO-56 Rev.1 (2025).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../js/fao56/coefficients.js';
import { simuler, synthese } from '../../js/fao56/bilan.js';
import * as I from '../../js/fao56/irrigation.js';
import { CULTURES, parId, source } from '../../js/fao56/data/cultures-2025.js';
import { SOLS, solParId, systemeParId } from '../../js/fao56/data/references.js';

const proche = (v, attendu, tol, msg) =>
  assert.ok(Math.abs(v - attendu) <= tol, `${msg ?? ''} : obtenu ${Number(v).toFixed(3)}, attendu ${attendu} ± ${tol}`);

// Données communes aux exemples 7.9 et 8.3 (limon sableux, Ze = 0,1 m, h = 0,3 m, u2 = 1,6, HRmin = 35 %)
const ET0 = [4.5, 5.0, 3.9, 4.2, 4.8, 2.7, 5.8, 5.1, 4.7, 5.2];
const dates = ET0.map((_, i) => C.ajouterJours('2026-05-01', i));
const meteo79 = (extra = () => ({})) => ET0.map((et0, i) => ({
  date: dates[i], et0, pluie: i === 5 ? 6 : 0, u2: 1.6, hrmin: 35,
  kcb: 0.30 + (0.10 * i) / 9, h: 0.3, ...extra(i)
}));
const parcelle79 = {
  annuel: true,
  stades: { debut: '2026-04-01', finIni: '2026-04-20', finDev: '2026-06-01', finMi: '2026-07-01', fin: '2026-08-01' },
  kcb: { ini: 0.3, mi: 1.0, fin: 0.5 }, h: 0.3, zr: 1.5, zrMin: 1.5, p: 0.6, // zone racinaire profonde : pas de stress (Ks = 1) dans l'exemple 7.9
  sol: { thetaFC: 0.23, thetaWP: 0.10, rew: 8, ze: 0.1 },
  fw: 0.8, efficience: 1,
  etatInitial: { de: 18, drew: 8, dr: 0 }
};

test('Ajustements climatiques (Éq. 7.2 et 7.4) — exemples 7.1 et 7.9', () => {
  proche(C.tew(0.23, 0.10, 0.1), 18, 1e-9, 'TEW');
  proche(C.kcMax(1.6, 35, 0.3, 0.3), 1.21, 0.005, 'Kc max');
  // Exemple 7.1 : Kcb mid tabulé 1,00 → ajusté (le texte donne 1,04 pour u2 = 3, HRmin = 30, h = 2)
  proche(C.ajusterMi(1.0, 3, 30, 2), 1.04 + 0.05, 0.06, 'Kcb mid ajusté');
  assert.equal(C.ajusterFin(0.40, 4, 20, 2), 0.40, 'Kcb end < 0,45 non ajusté');
  // Bornes d'application de l'ajustement
  assert.equal(C.ajustementClimat(10, 10, 20), C.ajustementClimat(6, 20, 10));
});

test('Exemple 7.9 a — procédure d’origine : ETc totale 35,7 mm', () => {
  const r = simuler(parcelle79, meteo79(i => ({ fc: 0.08 + (0.06 * i) / 9 })),
    [{ date: dates[0], net: 40 }],
    { peau: false, planifier: false, ajusterClimat: false, ajusterP: false });
  const etc = r.jours.map(j => j.etcAct);
  const attendus = [5.5, 6.1, 4.0, 2.9, 2.5, 2.7, 4.7, 2.8, 2.2, 2.3];
  etc.forEach((v, i) => proche(v, attendus[i], 0.25, `ETc jour ${i + 1}`));
  proche(etc.reduce((s, v) => s + v, 0), 35.7, 0.5, 'ETc totale');
  proche(r.jours[0].ke, 0.91, 0.01, 'Ke jour 1');
  proche(r.jours[2].kr, 0.70, 0.03, 'Kr jour 3');
  proche(r.jours[5].few, 0.89, 0.01, 'few jour 6 (fw = 1 après pluie)');
});

test('Exemple 7.9 b — couche de surface (« skin layer ») : ETc totale 35,7 mm', () => {
  const r = simuler(parcelle79, meteo79(), [{ date: dates[0], net: 40 }],
    { peau: true, planifier: false, ajusterClimat: false, ajusterP: false });
  proche(r.jours[0].fc, 0.11, 0.01, 'fc (Éq. 7.8)');
  proche(r.jours[1].aStage1, 0.48, 0.05, 'Astage1 jour 2');
  proche(r.jours[2].ke, 0.65, 0.03, 'Ke jour 3');
  const total = r.jours.reduce((s, j) => s + j.etcAct, 0);
  proche(total, 35.7, 0.8, 'ETc totale');
});

test('Exemple 8.3 — planification : irrigation au jour 10 quand Dr atteint la RAW', () => {
  const zr = i => 0.30 + (0.05 * i) / 9;
  const p = { ...parcelle79, zr: 0.3, zrMin: 0.3, etatInitial: { de: 18, drew: 8, dr: 78 * 0.3 } };
  const met = meteo79(i => ({ zr: zr(i), fc: 0.08 + (0.06 * i) / 9 }));
  const opts = { peau: false, planifier: true, ajusterClimat: false, ajusterP: false, pluiePrevue: 1 };
  const r = simuler(p, met, [{ date: dates[0], net: 40 }], opts, dates[1]);
  const j = r.jours;
  proche(j[0].dp, 40 - 78 * 0.3, 0.2, 'percolation jour 1');
  proche(j[0].raw, 23.4, 0.05, 'RAW jour 1');
  proche(j[9].raw, 27.3, 0.05, 'RAW jour 10');
  // Le texte arrondit : Dr = 27 mm = RAW au début du jour 10
  proche(j[9].drDebut, 27, 0.5, 'Dr début jour 10');
  // Seuil très légèrement abaissé pour s'affranchir des arrondis du texte
  const r2 = simuler(p, met, [{ date: dates[0], net: 40 }], { ...opts, mad: 0.59 }, dates[1]);
  const planif = r2.jours.filter(x => x.planifiee);
  assert.equal(planif.length, 1, 'une irrigation planifiée');
  assert.equal(planif[0].date, dates[9]);
  proche(planif[0].planifiee.net, 27, 0.5, 'dose nette (retour à la capacité au champ)');
  proche(r2.jours[9].dp, 0, 1e-9, 'pas de percolation');
  proche(r2.jours[9].ke, 0.81, 0.11, 'Ke après irrigation (texte : 0,81)');
  const s = synthese(r2, dates[1], 8);
  assert.equal(s.planifiees.length, 1);
});

test('Méthode simple (Kc) et stress hydrique', () => {
  const p = { ...parcelle79, kc: { ini: 0.6, mi: 1.15, fin: 0.8 }, etatInitial: { dr: 0 } };
  const meteo = Array.from({ length: 40 }, (_, i) => ({ date: C.ajouterJours('2026-06-01', i), et0: 6, pluie: 0, u2: 2, hrmin: 45 }));
  const r = simuler(p, meteo, [], { methode: 'simple', planifier: false, ajusterP: false });
  const stress = r.jours.find(j => j.stress);
  assert.ok(stress, 'le stress apparaît sans irrigation');
  assert.ok(stress.drDebut >= stress.raw - 1e-6);
  r.jours.forEach(j => assert.ok(j.dr <= j.taw + 1e-9));
});

test('Courbe de Kcb (Éq. 6.20), stades et degrés-jours', () => {
  const st = C.stadesDepuisDurees('2026-04-01', [20, 30, 40, 30]);
  assert.deepEqual(st, { debut: '2026-04-01', finIni: '2026-04-21', finDev: '2026-05-21', finMi: '2026-06-30', fin: '2026-07-30' });
  const v = { ini: 0.15, mi: 1.1, fin: 0.3 };
  proche(C.coefDuJour('2026-04-10', st, v), 0.15, 1e-9);
  proche(C.coefDuJour('2026-05-06', st, v), 0.625, 1e-9);
  proche(C.coefDuJour('2026-06-15', st, v), 1.1, 1e-9);
  proche(C.coefDuJour('2026-07-30', st, v), 0.3, 1e-9);
  proche(C.coefDuJour('2026-09-01', st, v, 0.2), 0.2, 1e-9);
  proche(C.degresJours(30, 20, 10, 30), 15, 1e-9);
  proche(C.degresJours(40, 30, 10, 30), 20, 1e-9);
  assert.equal(C.degresJours(8, 2, 10), 0);
  const serie = Array.from({ length: 200 }, (_, i) => ({ date: C.ajouterJours('2026-04-01', i), tmax: 25, tmin: 15 }));
  const s2 = C.stadesDepuisDegresJours('2026-04-01', { ini: 100, dev: 200, mid: 300, late: 100 }, serie, 10, 30);
  assert.equal(s2.finIni, '2026-04-10');
  assert.equal(s2.fin, '2026-06-09');
});

test('Approche A&P — exemple 9.5 (olivier) et encadré 9.2', () => {
  const fr = C.frStomatique(0.189, 0.0676, 2, 420, 100);
  proche(fr, 0.67, 0.01, 'Fr');
  const sinE = C.sinHauteurSoleilMidi(30, 180);
  proche(sinE, 0.99, 0.01, 'sin η');
  const fcEff = C.fcEffArbres(0.196, 30, 180);
  proche(fcEff, 0.20, 0.01, 'fc eff');
  const kd = C.kdDensite({ fcEff, ml: 2, h: 5 });
  proche(kd, 0.40, 0.01, 'Kd');
  // Éq. 9.11 appliquée telle qu'écrite (le texte de l'exemple obtient 0,74 avec un signe inversé)
  const kf = C.kcbPlein({ fr, h: 5, u2: 2, hrMin: 25, kh: 0.1 });
  proche(kf, 0.67 * (1.2 + 0.08 * Math.pow(5 / 3, 0.3)), 0.01, 'Kcb full');
  proche(C.kcbAP({ kd, kcbFull: kf }), 0.15 + (kf - 0.15) * kd, 1e-9, 'Kcb A&P');
  // Rangs est-ouest : fc eff > fc ; rangs nord-sud : fc eff = fc
  assert.ok(C.fcEffRangs(0.3, { hauteurCanopee: 2, largeur: 2, angleRangDeg: 0, latitude: 40, J: 200 }) > 0.3);
  proche(C.fcEffRangs(0.3, { hauteurCanopee: 2, largeur: 2, angleRangDeg: 90, latitude: 40, J: 200 }), 0.3, 1e-9);
  // Exemple 9.3 : fc eff = 0,3 (1 + 1/2,8) = 0,41
  proche(C.fcEffRangs(0.3, { hauteurCanopee: 2, largeur: 2, angleRangDeg: 0, latitude: 40, J: 200 }), 0.41, 0.01, 'fc eff 9.3');
});

test('Irrigation : pluviométrie, doses, durées', () => {
  proche(I.pluviometrieLocalisee({ debitLh: 2, espacement: 0.5, interRang: 4 }), 1, 1e-9);
  proche(I.pluviometrieAspersion({ debitM3h: 40, surfaceHa: 1 }), 4, 1e-9);
  assert.equal(I.formatDuree(0.75), '45 min');
  assert.equal(I.formatDuree(1.5), '1 h 30');
  assert.equal(I.formatDuree(12), '12 h');
  assert.equal(I.formatDuree(1.08), '1 h 05');
  assert.equal(I.mmVersM3ha(2.5), 25);
  const d = I.decouperPostes(10, 1, 4);
  assert.equal(d.postes, 3);
  proche(d.dureeParPoste, 10 / 3, 1e-9);
  assert.equal(I.brutDepuisSaisie({ unite: 'm3ha', valeur: 300 }), 30);
  assert.equal(I.brutDepuisSaisie({ unite: 'heures', valeur: 3, pluvioMmH: 1.2 }), 3.5999999999999996);
});

test('Catalogue 2025 et tables de référence', () => {
  assert.equal(CULTURES.length, 76);
  for (const c of CULTURES) {
    assert.ok(c.classes.length > 0, c.id);
    for (const cl of c.classes) {
      for (const k of ['ini', 'mid', 'end']) assert.ok(Number.isFinite(cl.kcb[k]), `${c.id}/${cl.id} Kcb ${k}`);
      assert.match(source(cl.kcb.src), /^FAO-56 Rev\.1 \(2025\), tableau (7\.[123]|6\.4), p\. \d+/);
    }
    if (c.p) assert.ok((c.p.p > 0 && c.p.p < 1) || c.p.txt, `${c.id} p`);
  }
  assert.ok(parId('pommier').classes.some(cl => cl.ap));
  assert.equal(SOLS.length, 9);
  proche(solParId('sandy-loam').thetaFC, 0.23, 1e-9);
  assert.equal(solParId('clay-loam').id, 'silty-clay-loam');
  assert.equal(C.classeTextureUSDA(20, 40, 40), 'loam');
  assert.equal(C.classeTextureUSDA(5, 10, 85), 'loamy-sand');
  assert.equal(C.classeTextureUSDA(45, 45, 10), 'silty-clay');
  assert.equal(systemeParId('goutte-a-goutte').fwDefaut, 0.35);
});

test('Pluie prévue comptée telle qu’annoncée ; seuil fixe quand p n’est pas ajusté', () => {
  const p = { ...parcelle79, etatInitial: { dr: 0 } };
  const meteo = Array.from({ length: 12 }, (_, i) => ({
    date: C.ajouterJours('2026-06-01', i), et0: i < 6 ? 3 : 8, pluie: i === 9 ? 10 : 0, u2: 2, hrmin: 45
  }));
  // Prévision à partir du 6e jour : la pluie du 10e jour est entièrement comptée par défaut
  const r = simuler(p, meteo, [], { planifier: false }, meteo[5].date);
  assert.equal(r.jours[9].prevision, true);
  proche(r.jours[9].pluieRetenue, 10, 1e-9, 'pluie prévue retenue');
  // p ajusté (Éq. 8.5) : la fraction varie avec la demande ; non ajusté : constante
  const ajuste = simuler(p, meteo, [], { planifier: false, ajusterP: true }, null);
  const fixe = simuler(p, meteo, [], { planifier: false, ajusterP: false }, null);
  assert.ok(new Set(ajuste.jours.map(j => j.p.toFixed(3))).size > 1, 'p varie avec la demande');
  assert.equal(new Set(fixe.jours.map(j => j.p.toFixed(3))).size, 1, 'p reste fixe');
  proche(fixe.jours[8].seuil / fixe.jours[8].taw, parcelle79.p ?? 0.5, 1e-9, 'seuil = p fixe × RU');
});
