// Tests du module météo : exemples chiffrés du chapitre 3 et 4 de FAO-56 Rev.1 (2025).
// Lancer : node --test tests/fao56/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../js/fao56/meteo.js';

const proche = (v, attendu, tol, msg) =>
  assert.ok(Math.abs(v - attendu) <= tol, `${msg ?? ''} : obtenu ${v.toFixed(4)}, attendu ${attendu} ± ${tol}`);

test('Exemple 4.1 — Bangkok, avril, données mensuelles', () => {
  const P = M.pression(2);
  proche(P, 101.3, 0.05, 'P');
  proche(M.psychrometrique(P), 0.0673, 0.0002, 'γ');
  proche(M.pente(30.2), 0.246, 0.001, 'Δ');
  const es = M.esMoyenne(34.8, 25.6);
  proche(es, 4.42, 0.01, 'es');
  const Ra = M.raJour(13 + 44 / 60, 105);
  proche(Ra, 38.06, 0.05, 'Ra');
  const N = M.dureeJour(13 + 44 / 60, 105);
  proche(N, 12.31, 0.03, 'N');
  const Rs = M.rsAngstrom(8.5, N, Ra);
  proche(Rs, 22.65, 0.1, 'Rs');
  const Rso = M.rsoAltitude(Ra, 2);
  proche(Rso, 28.54, 0.05, 'Rso');
  const Rnl = M.rnl(34.8, 25.6, 2.85, Rs, Rso);
  proche(Rnl, 3.11, 0.05, 'Rnl');
  const Rn = M.rns(Rs) - Rnl;
  proche(Rn, 14.33, 0.1, 'Rn');
  const G = M.gMois(29.2, null, 30.2);
  proche(G, 0.14, 0.001, 'G');
  const et0 = M.et0Journaliere({ T: 30.2, Rn, G, u2: 2, es, ea: 2.85, P });
  proche(et0, 5.72, 0.05, 'ET0');
});

test('Exemple 4.2 — Uccle, 6 juillet, données journalières', () => {
  const u2 = M.vent2m(10 / 3.6, 10);
  proche(u2, 2.078, 0.002, 'u2');
  proche(M.pression(100), 100.1, 0.05, 'P');
  const ea = M.eaHrMinMax(21.5, 12.3, 84, 63);
  proche(ea, 1.409, 0.002, 'ea');
  proche(M.jourAnnee('2026-07-06'), 187, 0, 'J');
  proche(M.raJour(50.8, 187), 41.09, 0.05, 'Ra');
  // Calcul complet par la fonction de haut niveau (insolation mesurée)
  const r = M.calculerJour(
    { date: '2026-07-06', tmax: 21.5, tmin: 12.3, hrmax: 84, hrmin: 63, uz: 10 / 3.6, zVent: 10, insolation: 9.25 },
    { latitude: 50.8, altitude: 100 }
  );
  proche(r.Rs, 22.07, 0.25, 'Rs');      // le texte arrondit n/N
  proche(r.Rnl, 3.71, 0.06, 'Rnl');
  proche(r.et0, 3.88, 0.05, 'ET0');
  assert.deepEqual(r.estimations, []);
});

test('Exemple 4.3 — N’Diaye, données horaires (jour et nuit, Éq. 2.5a/2.5b)', () => {
  const P = M.pression(8);
  proche(P, 101.2, 0.05, 'P');
  const J = 274;
  // 14 h – 15 h
  const RaJ = M.raHeure(16 + 13 / 60, J, 14.5, 15, 16.25, 1);
  proche(RaJ, 3.543, 0.01, 'Ra horaire');
  const eaJ = M.eSat(38) * 0.52;
  proche(eaJ, 3.445, 0.003, 'ea jour');
  const Rso = M.rsoAltitude(RaJ, 8);
  proche(Rso, 2.658, 0.01, 'Rso');
  const RnJ = M.rns(2.45) - M.rnlHoraire(38, eaJ, 2.45 / Rso);
  proche(RnJ, 1.749, 0.01, 'Rn jour');
  const etJ = M.et0Horaire({ T: 38, Rn: RnJ, u2: 3.3, es: M.eSat(38), ea: eaJ, P });
  proche(etJ, 0.656, 0.01, 'ET0 jour');
  // 2 h – 3 h (nuit, Rs/Rso = 0,8 supposé)
  proche(M.raHeure(16 + 13 / 60, J, 2.5, 15, 16.25, 1), 0, 1e-9, 'Ra nuit');
  const eaN = M.eSat(28) * 0.9;
  const RnN = 0 - M.rnlHoraire(28, eaN, 0.8);
  proche(RnN, -0.100, 0.005, 'Rn nuit');
  const etN = M.et0Horaire({ T: 28, Rn: RnN, u2: 1.9, es: M.eSat(28), ea: eaN, P });
  proche(etN, 0.004, 0.005, 'ET0 nuit');
});

test('Données minimales : Tmax/Tmin seules (procédures du chapitre 2 et 3)', () => {
  // Valeurs de l'exemple 4.4 (Foggia, juillet) : Tdew = Tmin − 1, kRs = 0,19, u2 = 2,42
  const r = M.calculerJour(
    { date: '2026-07-15', tmax: 32.2, tmin: 19.2, u2: 2.42 },
    { latitude: 41 + 28 / 60, altitude: 74, aT: 1, kRs: 0.19 }
  );
  proche(r.ea, 2.09, 0.01, 'ea');
  proche(r.Ra, 40.76, 0.15, 'Ra');
  proche(r.Rs, 28.12, 0.4, 'Rs');
  proche(r.et0, 6.41, 0.15, 'ET0');
  assert.equal(r.estimations.length, 2);
});

test('Hargreaves-Samani et régressions kRs', () => {
  // Exemple 3.14 (Lyon) : kRs = 0,19 avec la régression 3.54
  const k = M.kRsRegression(10.1, 2.42, 71, 'subhumide');
  assert.ok(k > 0.15 && k < 0.25);
  const et = M.et0HargreavesSamani(30, 15, 40);
  assert.ok(et > 4 && et < 7, `HS = ${et}`);
});

test('Garde-fous', () => {
  const r = M.calculerJour({ date: '2026-07-15', tmax: null, tmin: 10 }, { latitude: 43.6 });
  assert.equal(r.et0, null);
  // Vent nul → borné à 0,5 m/s ; humidité absente → Tdew ≈ Tmin
  const r2 = M.calculerJour({ date: '2026-01-15', tmax: 12, tmin: -2, u2: 0, rs: 8 }, { latitude: 43.6, altitude: 50 });
  assert.equal(r2.u2, 0.5);
  assert.ok(r2.et0 >= 0);
  // Rnl : rapport Rs/Rso borné à [0,3 ; 1]
  assert.ok(M.rnl(20, 10, 1.2, 50, 10) === M.rnl(20, 10, 1.2, 10, 10));
});

test('Agrégation des données horaires Open-Meteo en journalier', async () => {
  const { agregerHoraire, completerJours } = await import('../../js/fao56/meteo-source.js');
  const time = [];
  const T = [], H = [], U = [], R = [], P = [];
  for (const d of ['2026-07-01', '2026-07-02']) {
    for (let h = 0; h < 24; h++) {
      time.push(`${d}T${String(h).padStart(2, '0')}:00`);
      T.push(20 + 8 * Math.sin(((h - 9) / 24) * 2 * Math.PI));
      H.push(60 - 25 * Math.sin(((h - 9) / 24) * 2 * Math.PI));
      U.push(3);
      R.push(h >= 6 && h <= 19 ? 600 : 0);
      P.push(h === 3 ? 1.5 : 0);
    }
  }
  time.push('2026-07-03T00:00'); T.push(18); H.push(70); U.push(2); R.push(0); P.push(0); // jour incomplet
  const jours = agregerHoraire({ time, temperature_2m: T, relative_humidity_2m: H, wind_speed_10m: U, shortwave_radiation: R, precipitation: P });
  assert.equal(jours.length, 2, 'le jour incomplet est écarté');
  proche(jours[0].tmax, 28, 0.01, 'Tmax');
  proche(jours[0].tmin, 12, 0.01, 'Tmin');
  proche(jours[0].hrmin, 35, 0.01, 'HRmin');
  proche(jours[0].u2, 3 * 4.87 / Math.log(67.8 * 10 - 5.42), 1e-9, 'u2');
  proche(jours[0].rs, 14 * 600 * 3600 / 1e6, 1e-9, 'Rs (MJ/m²/j)');
  proche(jours[0].pluie, 1.5, 1e-9, 'pluie');
  const c = completerJours(jours, { latitude: 43.6, altitude: 10 });
  assert.ok(c[0].et0 > 3 && c[0].et0 < 8, `ET0 = ${c[0].et0}`);
});
