// Données météo du bilan : Open-Meteo (réanalyse ERA5 puis modèles de prévision) agrégées au
// pas journalier, ET₀ recalculée par FAO Penman-Monteith (Éq. 2.4) ; option : températures,
// humidité et pluie mesurées par une station SAM (vent et rayonnement restent Open-Meteo,
// les stations ne les mesurant pas).
//
// FAO-56 Rev.1 (2025) recommande de vérifier les données maillées (réanalyses) contre des
// stations locales : l'ET₀ d'Open-Meteo est conservée à titre de comparaison.

import { calculerJour, vent2m } from './meteo.js';

const HORAIRE = ['temperature_2m', 'relative_humidity_2m', 'wind_speed_10m', 'shortwave_radiation', 'precipitation'];
const JOURNALIER = ['et0_fao_evapotranspiration', 'precipitation_sum'];
const finite = v => typeof v === 'number' && Number.isFinite(v);

function ajouterJours(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Agrège des données horaires Open-Meteo (heure locale) en données journalières :
 * Tmax/Tmin, HRmax/HRmin, vent moyen ramené à 2 m (Éq. 3.50), rayonnement solaire cumulé
 * (W m⁻² → MJ m⁻² j⁻¹), pluie cumulée. Les jours incomplets (< 20 heures) sont écartés.
 */
export function agregerHoraire(hourly) {
  const jours = new Map();
  const t = hourly?.time || [];
  for (let i = 0; i < t.length; i++) {
    const date = String(t[i]).slice(0, 10);
    let j = jours.get(date);
    if (!j) { j = { date, T: [], H: [], U: [], R: [], P: [] }; jours.set(date, j); }
    const push = (arr, v) => { if (finite(v)) arr.push(v); };
    push(j.T, hourly.temperature_2m?.[i]);
    push(j.H, hourly.relative_humidity_2m?.[i]);
    push(j.U, hourly.wind_speed_10m?.[i]);
    push(j.R, hourly.shortwave_radiation?.[i]);
    push(j.P, hourly.precipitation?.[i]);
  }
  const res = [];
  for (const j of jours.values()) {
    if (j.T.length < 20) continue;
    const somme = a => a.reduce((s, v) => s + v, 0);
    res.push({
      date: j.date,
      tmax: Math.max(...j.T),
      tmin: Math.min(...j.T),
      hrmax: j.H.length >= 20 ? Math.min(100, Math.max(...j.H)) : null,
      hrmin: j.H.length >= 20 ? Math.max(1, Math.min(...j.H)) : null,
      u2: j.U.length >= 20 ? vent2m(somme(j.U) / j.U.length, 10) : null,
      rs: j.R.length >= 20 ? (somme(j.R) * 3600) / 1e6 : null,
      pluie: j.P.length ? somme(j.P) : null
    });
  }
  return res.sort((a, b) => a.date.localeCompare(b.date));
}

/** Calcule l'ET₀ FAO-PM de chaque jour (Éq. 2.4) et garde les grandeurs utiles au bilan. */
export function completerJours(jours, site) {
  return jours.map(j => {
    const r = calculerJour(j, site);
    return { ...j, et0: r.et0, ea: r.ea, rso: r.Rso, ra: r.Ra, estimations: r.estimations || [] };
  });
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Open-Meteo : erreur HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.reason || 'Open-Meteo : réponse invalide');
  return json;
}

function urlOpenMeteo(base, place, extra) {
  const params = new URLSearchParams({
    latitude: Number(place.latitude).toFixed(4),
    longitude: Number(place.longitude).toFixed(4),
    hourly: HORAIRE.join(','),
    daily: JOURNALIER.join(','),
    wind_speed_unit: 'ms',
    timezone: 'auto',
    ...extra
  });
  return `${base}?${params}`;
}

function journalierOM(daily) {
  const m = new Map();
  (daily?.time || []).forEach((d, i) => m.set(d, {
    et0: finite(daily.et0_fao_evapotranspiration?.[i]) ? daily.et0_fao_evapotranspiration[i] : null,
    pluie: finite(daily.precipitation_sum?.[i]) ? daily.precipitation_sum[i] : null
  }));
  return m;
}

/**
 * Mesures journalières d'une station SAM (vue station_journalier) : on ne garde que les jours
 * complets (au moins 80 % du nombre médian de mesures) et antérieurs à aujourd'hui.
 */
export async function chargerStation(client, stationId, debut, fin) {
  if (!client || !stationId) return new Map();
  const { data, error } = await client.from('station_journalier')
    .select('jour,t_min,t_max,hr_min,hr_max,pluie,nb_mesures')
    .eq('station_id', stationId).gte('jour', debut).lte('jour', fin).order('jour');
  if (error) throw error;
  const rows = data || [];
  const nb = rows.map(r => r.nb_mesures).filter(n => n > 0).sort((a, b) => a - b);
  const mediane = nb.length ? nb[Math.floor(nb.length / 2)] : 0;
  const m = new Map();
  for (const r of rows) {
    if (!(r.nb_mesures >= 0.8 * mediane)) continue;
    m.set(r.jour, {
      tmax: finite(r.t_max) ? r.t_max : null,
      tmin: finite(r.t_min) ? r.t_min : null,
      hrmax: finite(r.hr_max) ? r.hr_max : null,
      hrmin: finite(r.hr_min) ? r.hr_min : null,
      pluie: finite(Number(r.pluie)) ? Number(r.pluie) : null
    });
  }
  return m;
}

/**
 * Charge la série journalière [debut, fin] pour un lieu : réanalyse jusqu'à J−8 (mise en cache),
 * prévision pour J−7 à J+7. Renvoie { jours, altitude, sources }.
 * options : { client, stationId, aujourdhui, cache (objet type storage) }
 */
export async function chargerMeteo(place, debut, fin, { client = null, stationId = null, aujourdhui, cache = null } = {}) {
  const finArchive = ajouterJours(aujourdhui, -8);
  const cleCache = `pilotage.meteo.${Number(place.latitude).toFixed(3)}_${Number(place.longitude).toFixed(3)}`;
  const enCache = cache?.get(cleCache, null) || { altitude: null, jours: {} };
  const parDate = new Map();
  let altitude = finite(place.altitude) ? place.altitude : enCache.altitude;
  const sources = { archive: 0, prevision: 0, station: 0, stationPluie: 0, cache: 0 };

  // 1. Réanalyse (jours définitifs, mis en cache sur l'appareil)
  if (debut <= finArchive) {
    const fa = fin < finArchive ? fin : finArchive;
    let manque = false;
    for (let d = debut; d <= fa; d = ajouterJours(d, 1)) if (!enCache.jours[d]) { manque = true; break; }
    if (manque) {
      const data = await fetchJson(urlOpenMeteo('https://archive-api.open-meteo.com/v1/archive', place, { start_date: debut, end_date: fa }));
      if (finite(data.elevation)) altitude = altitude ?? data.elevation;
      const om = journalierOM(data.daily);
      for (const j of agregerHoraire(data.hourly)) {
        enCache.jours[j.date] = { ...j, et0OM: om.get(j.date)?.et0 ?? null };
      }
      enCache.altitude = altitude;
      try { cache?.set(cleCache, enCache); } catch { /* stockage plein : on continue sans cache */ }
    } else {
      sources.cache = 1;
    }
    for (let d = debut; d <= fa; d = ajouterJours(d, 1)) {
      if (enCache.jours[d]) { parDate.set(d, { ...enCache.jours[d], origine: 'réanalyse' }); sources.archive++; }
    }
  }

  // 2. Prévision (7 jours passés + 8 jours à venir)
  if (fin > finArchive) {
    const data = await fetchJson(urlOpenMeteo('https://api.open-meteo.com/v1/forecast', place, { past_days: '7', forecast_days: '8' }));
    if (finite(data.elevation)) altitude = altitude ?? data.elevation;
    const om = journalierOM(data.daily);
    for (const j of agregerHoraire(data.hourly)) {
      if (j.date <= finArchive && parDate.has(j.date)) continue;
      if (j.date < debut || j.date > fin) continue;
      parDate.set(j.date, { ...j, et0OM: om.get(j.date)?.et0 ?? null, origine: j.date >= aujourdhui ? 'prévision' : 'modèle' });
      sources.prevision++;
    }
  }

  // 3. Station SAM : T, HR et pluie mesurées remplacent Open-Meteo sur les jours passés complets
  if (stationId && client) {
    const veille = ajouterJours(aujourdhui, -1);
    const st = await chargerStation(client, stationId, debut, fin < veille ? fin : veille).catch(() => new Map());
    for (const [d, s] of st) {
      const j = parDate.get(d);
      if (!j) continue;
      const remplace = {};
      for (const k of ['tmax', 'tmin', 'hrmax', 'hrmin', 'pluie']) if (finite(s[k])) remplace[k] = s[k];
      if (finite(remplace.tmax) && finite(remplace.tmin) && remplace.tmax >= remplace.tmin) {
        parDate.set(d, { ...j, ...remplace, origine: 'station', omPluie: j.pluie });
        sources.station++;
        // Pluviomètre masqué (Administration > Capteurs) : la pluie reste celle d'Open-Meteo.
        if (finite(remplace.pluie)) sources.stationPluie++;
      }
    }
  }

  const site = { latitude: place.latitude, altitude: altitude ?? 0 };
  const jours = completerJours([...parDate.values()].sort((a, b) => a.date.localeCompare(b.date)), site)
    .map(j => ({ ...j, prevision: j.date >= aujourdhui }));
  return { jours, altitude: altitude ?? 0, sources };
}
