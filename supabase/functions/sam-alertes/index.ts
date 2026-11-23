// =============================================================================
// SAM · Fonction Supabase « sam-alertes » : alertes gel (notification et mail)
// -----------------------------------------------------------------------------
// Appelée par deux tâches automatiques (supabase/alertes_gel.sql) :
//   - « mesures »   : toutes les 5 minutes, juste après la collecte Comsag : une station
//                     suivie vient de mesurer une température sous le seuil choisi ;
//   - « prevision » : chaque soir vers 18 h : la prévision Open-Meteo de la nuit, au point
//                     de la station, descend sous le seuil.
// Et par le site (compte connecté) : « test » envoie une alerte d'essai au compte appelant.
//
// Réglages :
//   - dans la base (sam_private.reglages, lus par sam_alertes_reglage) : clé des tâches
//     automatiques (alertes_cle), clés des notifications (vapid_public, vapid_prive, créées
//     au premier appel), adresse d'envoi des mails (mail_expediteur, validée dans Brevo) ;
//   - Supabase > Edge Functions > Secrets : BREVO_CLE, clé d'API Brevo. Sans elle, les
//     alertes partent en notification seulement.
// Déploiement : « Verify JWT » désactivé (la fonction vérifie elle-même l'appelant).
// =============================================================================
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// deno-lint-ignore no-explicit-any
type Any = any;

function adminKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
  const first = Object.values(keys)[0];
  if (typeof first === 'string') return first;
  throw new Error('Clé d\'administration Supabase introuvable.');
}

const fr = (n: number, digits = 1) => n.toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace('-', '−');
const heure = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });

const reglage = async (admin: Any, cle: string): Promise<string | null> => {
  const { data, error } = await admin.rpc('sam_alertes_reglage', { p_cle: cle });
  if (error) throw error;
  return data ?? null;
};

// Clés des notifications : créées une fois, gardées dans la base.
let vapidPret = false;
async function vapid(admin: Any) {
  if (vapidPret) return;
  let pub = await reglage(admin, 'vapid_public');
  let priv = await reglage(admin, 'vapid_prive');
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    await admin.rpc('sam_alertes_reglage_creer', { p_cle: 'vapid_prive', p_valeur: k.privateKey });
    await admin.rpc('sam_alertes_reglage_creer', { p_cle: 'vapid_public', p_valeur: k.publicKey });
    pub = await reglage(admin, 'vapid_public');
    priv = await reglage(admin, 'vapid_prive');
  }
  webpush.setVapidDetails('mailto:jchabat@sudexpe.net', pub as string, priv as string);
  vapidPret = true;
}
let expediteur: string | null = null;

/** Notification sur chaque appareil abonné du compte ; abonnements expirés retirés. */
async function envoyerNotif(admin: Any, userId: string, message: { title: string; body: string; tag: string; url?: string }) {
  await vapid(admin);
  const { data: abonnements } = await admin.from('notifications_push').select('endpoint,p256dh,auth').eq('user_id', userId);
  let envoyes = 0;
  for (const a of abonnements ?? []) {
    try {
      await webpush.sendNotification({ endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } },
        JSON.stringify({ url: './#/donnees', ...message }), { TTL: 6 * 3600, urgency: 'high' });
      envoyes += 1;
    } catch (error) {
      const code = (error as { statusCode?: number })?.statusCode;
      if (code === 404 || code === 410) await admin.from('notifications_push').delete().eq('user_id', userId).eq('endpoint', a.endpoint);
      else console.error('notification', code, (error as Error)?.message);
    }
  }
  return envoyes;
}

const echappe = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** Mail par Brevo (si la clé est réglée). */
async function envoyerMail(to: string, sujet: string, lignes: string[]) {
  const cle = Deno.env.get('BREVO_CLE');
  if (!cle || !expediteur || !to) return false;
  const pied = 'Alerte réglée dans SAM, Mon profil > Alertes gel. https://sam.juju-chabat42.workers.dev/#/profil';
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1e2126;line-height:1.5">
    <p style="margin:0 0 12px;font-size:18px;font-weight:bold;color:#a20117">${echappe(sujet)}</p>
    ${lignes.map(l => `<p style="margin:0 0 8px">${echappe(l)}</p>`).join('')}
    <p style="margin:18px 0 0;font-size:12px;color:#6b7280">${echappe(pied)}</p></div>`;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': cle, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { name: 'SAM — Sud Agro Météo', email: expediteur }, to: [{ email: to }], subject: sujet, htmlContent: html, textContent: [...lignes, '', pied].join('\n') })
  });
  if (!res.ok) console.error('mail', res.status, await res.text());
  return res.ok;
}

async function alerter(admin: Any, a: Any, titre: string, lignes: string[], tag: string) {
  const [notif, mail] = await Promise.all([
    a.par_notification ? envoyerNotif(admin, a.user_id, { title: titre, body: lignes[0], tag }) : Promise.resolve(0),
    a.par_mail ? envoyerMail(a.email, titre, lignes) : Promise.resolve(false)
  ]);
  return notif > 0 || mail;
}

// Température mesurée sous le seuil (alerte dès la mesure reçue)
async function mesures(admin: Any) {
  const { data, error } = await admin.rpc('sam_alertes_gel_mesures');
  if (error) throw error;
  const faites: string[] = [];
  for (const a of data ?? []) {
    const titre = `Gel à ${a.station_nom} : ${fr(a.t_air)} °C`;
    const lignes = [
      `${fr(a.t_air)} °C mesurés à ${heure(a.mesure_le)}, sous votre seuil de ${fr(a.seuil)} °C.`,
      'Mesure de la station SAM, transmise par Comsag.'
    ];
    if (await alerter(admin, a, titre, lignes, `gel-${a.station_id}`)) faites.push(a.alerte_id);
  }
  if (faites.length) await admin.rpc('sam_alertes_gel_marquer', { p_ids: faites, p_type: 'mesure' });
  return { alertes: (data ?? []).length, envoyees: faites.length };
}

// Prévision de la nuit (18 h → 10 h le lendemain) au point de la station
async function prevision(admin: Any) {
  const { data, error } = await admin.rpc('sam_alertes_gel_prevision');
  if (error) throw error;
  const parStation = new Map<string, { min: number; at: string } | null>();
  for (const a of data ?? []) {
    if (parStation.has(a.station_id)) continue;
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${a.latitude}&longitude=${a.longitude}&hourly=temperature_2m&timezone=Europe%2FParis&forecast_days=2`;
      const json = await (await fetch(url)).json();
      const maintenant = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Paris' }).slice(0, 13).replace(' ', 'T');
      const demain = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
      let best: { min: number; at: string } | null = null;
      (json.hourly?.time ?? []).forEach((t: string, i: number) => {
        const v = json.hourly.temperature_2m[i];
        if (t.slice(0, 13) < maintenant || t > `${demain}T10:00` || !Number.isFinite(v)) return;
        if (!best || v < best.min) best = { min: v, at: t };
      });
      parStation.set(a.station_id, best);
    } catch (e) {
      console.error('prévision', a.station_id, (e as Error).message);
      parStation.set(a.station_id, null);
    }
  }
  const faites: string[] = [];
  for (const a of data ?? []) {
    const p = parStation.get(a.station_id);
    if (!p || p.min > a.seuil) continue;
    const h = Number(p.at.slice(11, 13));
    const titre = `Risque de gel cette nuit à ${a.station_nom}`;
    const lignes = [
      `Prévision : jusqu'à ${fr(p.min)} °C vers ${h} h, sous votre seuil de ${fr(a.seuil)} °C.`,
      'Prévision Open-Meteo au point de la station. Une seconde alerte part si la station mesure une température sous le seuil.'
    ];
    if (await alerter(admin, a, titre, lignes, `gel-prev-${a.station_id}`)) faites.push(a.alerte_id);
  }
  if (faites.length) await admin.rpc('sam_alertes_gel_marquer', { p_ids: faites, p_type: 'prevision' });
  return { alertes: (data ?? []).length, envoyees: faites.length };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const url = Deno.env.get('SUPABASE_URL') as string;
    const admin = createClient(url, adminKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    const body = await req.json().catch(() => ({}));
    expediteur = await reglage(admin, 'mail_expediteur');

    // Tâches automatiques : clé partagée
    const cle = await reglage(admin, 'alertes_cle');
    const recue = req.headers.get('x-sam-cle');
    if (cle && recue && recue === cle) {
      if (body?.mode === 'mesures') return reply(await mesures(admin));
      if (body?.mode === 'prevision') return reply(await prevision(admin));
      return reply({ error: 'Mode inconnu.' }, 400);
    }

    // Site : alerte d'essai pour le compte connecté
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: who } = await admin.auth.getUser(jwt);
    const me = who?.user;
    if (!me?.email) return reply({ error: 'Connexion requise.' }, 401);
    // Clé publique des notifications (créée au premier appel)
    if (body?.action === 'cle') {
      await vapid(admin);
      return reply({ cle: await reglage(admin, 'vapid_public') });
    }
    if (body?.action !== 'test') return reply({ error: 'Action inconnue.' }, 400);
    const notifications = await envoyerNotif(admin, me.id, { title: 'SAM : alerte gel d\'essai', body: 'Les alertes gel arriveront comme ceci sur cet appareil.', tag: 'gel-essai' });
    const mail = body.mail === true ? await envoyerMail(me.email, 'SAM : alerte gel d\'essai', ['Les alertes gel arriveront comme ceci dans votre messagerie.']) : false;
    return reply({ ok: true, notifications, mail, mailDisponible: Boolean(Deno.env.get('BREVO_CLE') && expediteur) });
  } catch (error) {
    return reply({ error: (error as Error)?.message ?? String(error) }, 500);
  }
});
