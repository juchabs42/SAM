// =============================================================================
// SAM · Fonction Supabase « sam-admin » : gestion des comptes
// -----------------------------------------------------------------------------
// Utilisée par l'onglet « Administration » du site (administrateurs SAM uniquement) :
// liste des comptes, invitation, rôles, suspension, suppression, retrait de la double
// authentification (téléphone perdu).
// Réservée aux « full admin » (sam_admins.niveau = 'full').
//
// Rôles : 'normal' (lecture, absent de sam_admins), 'admin' (saisie Phénologie,
// Tavelure, Piégeage), 'full' (tout : comptes, stations, capteurs).
//
// Déploiement (une seule fois) : Supabase > Edge Functions > Deploy a new function >
// Via Editor, nom « sam-admin », coller ce fichier, Deploy. Puis, dans les réglages de
// la fonction, désactiver « Verify JWT » : la fonction vérifie elle-même le compte
// appelant (connexion + niveau « full » dans public.sam_admins).
//
// La clé d'administration (service_role / secret) est fournie automatiquement par
// Supabase à la fonction : elle n'apparaît ni dans le site, ni sur GitHub.
//
// Dernière activité des comptes : exécuter une fois supabase/activite_comptes.sql
// (sinon la liste affiche seulement la dernière saisie du mot de passe).
// =============================================================================
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

class Refus extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Clé d'administration : clé « service_role » historique, ou nouvelle clé secrète.
function adminKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    const first = Object.values(keys)[0];
    if (typeof first === 'string') return first;
  } catch { /* ignoré */ }
  throw new Refus('Clé d\'administration Supabase introuvable pour la fonction.', 500);
}

// Niveau d'authentification inscrit dans le jeton de connexion : 'aal1' (mot de passe) ou 'aal2' (code saisi).
function niveauJeton(jwt: string): string | null {
  try {
    const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(part + '='.repeat((4 - (part.length % 4)) % 4))).aal ?? null;
  } catch {
    return null;
  }
}

const text = (value: unknown, max = 160) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (req.method !== 'POST') throw new Refus('Méthode non autorisée.', 405);
    const url = Deno.env.get('SUPABASE_URL');
    if (!url) throw new Refus('Adresse Supabase introuvable.', 500);
    const admin = createClient(url, adminKey(), { auth: { persistSession: false, autoRefreshToken: false } });

    // 1. Compte appelant : connecté, adresse confirmée, « full admin ».
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: who, error: whoError } = await admin.auth.getUser(jwt);
    const me = who?.user;
    if (whoError || !me?.email || !me.email_confirmed_at) throw new Refus('Connexion requise.', 401);
    // Double authentification activée sur ce compte : le code doit avoir été saisi (jeton « aal2 »).
    const doubleAuth = (me.factors ?? []).some((f: { status?: string }) => f.status === 'verified');
    if (doubleAuth && niveauJeton(jwt) !== 'aal2') throw new Refus('Saisissez d\'abord votre code de double authentification.', 403);
    const myEmail = me.email.toLowerCase();
    const { data: mine, error: adminError } = await admin.from('sam_admins').select('*').eq('email', myEmail).maybeSingle();
    if (adminError) throw adminError;
    // Sans colonne « niveau » (roles.sql pas encore exécuté), tout administrateur garde l'accès.
    if (!mine || (mine.niveau ?? 'full') !== 'full') throw new Refus('Réservé aux administrateurs « full admin ».', 403);

    // 2. Action demandée
    const body = await req.json().catch(() => ({}));
    switch (body?.action) {
      case 'list': return reply(await listAccounts(admin));
      case 'invite': return reply(await invite(admin, body));
      case 'reinvite': return reply(await reinvite(admin, body));
      case 'setRole': return reply(await setRole(admin, body, myEmail));
      case 'setAdmin': return reply(await setRole(admin, { ...body, role: body.admin === true ? 'admin' : 'normal' }, myEmail));
      case 'suspend': return reply(await suspend(admin, body, me.id));
      case 'delete': return reply(await remove(admin, body, me.id));
      case 'resetMfa': return reply(await resetMfa(admin, body, me.id));
      default: throw new Refus('Action inconnue.');
    }
  } catch (error) {
    const status = error instanceof Refus ? error.status : 400;
    const message = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error);
    return reply({ error: message }, status);
  }
});

// deno-lint-ignore no-explicit-any
type Admin = any;

async function allUsers(admin: Admin) {
  const users = [];
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    users.push(...data.users);
    if (data.users.length < 1000) break;
  }
  return users;
}

async function listAccounts(admin: Admin) {
  const [users, admins, profiles, activites] = await Promise.all([
    allUsers(admin),
    admin.from('sam_admins').select('*'),
    admin.from('profils').select('*'),
    // Dernier renouvellement de session (supabase/activite_comptes.sql) : dernière utilisation réelle
    admin.rpc('sam_dernieres_activites')
  ]);
  if (admins.error) throw admins.error;
  const roles = new Map((admins.data ?? []).map((a: { email: string; niveau?: string }) => [a.email, a.niveau === 'admin' ? 'admin' : 'full']));
  // La table des profils peut ne pas encore exister : les comptes restent listés.
  const byId = new Map((profiles.error ? [] : profiles.data ?? []).map((p: { id: string }) => [p.id, p]));
  const activite = new Map((activites.error ? [] : activites.data ?? []).map((r: { user_id: string; derniere_activite: string }) => [r.user_id, r.derniere_activite]));
  const plusRecent = (...dates: (string | null | undefined)[]) => {
    const t = dates.filter(Boolean).map(d => new Date(d as string).getTime()).filter(Number.isFinite);
    return t.length ? new Date(Math.max(...t)).toISOString() : null;
  };
  const now = Date.now();
  const accounts = users.map((u: Admin) => {
    const p: Admin = byId.get(u.id) ?? {};
    const meta = u.user_metadata ?? {};
    return {
      id: u.id,
      email: u.email ?? '',
      created_at: u.created_at ?? null,
      invited_at: u.invited_at ?? null,
      last_sign_in_at: u.last_sign_in_at ?? null,
      // Dernière utilisation : dernière connexion ou dernier renouvellement de session
      derniere_activite: plusRecent(u.last_sign_in_at, activite.get(u.id) as string | undefined),
      confirmed: Boolean(u.email_confirmed_at),
      // Double authentification activée (code d'une application)
      mfa: (u.factors ?? []).some((f: { status?: string }) => f.status === 'verified'),
      banned: Boolean(u.banned_until && new Date(u.banned_until).getTime() > now),
      role: roles.get(String(u.email ?? '').toLowerCase()) ?? 'normal',
      admin: roles.has(String(u.email ?? '').toLowerCase()),
      prenom: p.prenom ?? meta.prenom ?? null,
      nom: p.nom ?? meta.nom ?? null,
      structure: p.structure ?? meta.structure ?? null,
      fonction: p.fonction ?? meta.fonction ?? null,
      telephone: p.telephone ?? meta.telephone ?? null,
      commune: p.commune ?? null,
      stations_favorites: Array.isArray(p.stations_favorites) ? p.stations_favorites : [],
      profil_maj: p.updated_at ?? null
    };
  }).sort((a: Admin, b: Admin) => a.email.localeCompare(b.email));
  return { accounts, activite_disponible: !activites.error };
}

async function invite(admin: Admin, body: Admin) {
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Refus('Adresse mail invalide.');
  const profile = {
    prenom: text(body.prenom), nom: text(body.nom), structure: text(body.structure),
    fonction: text(body.fonction), telephone: text(body.telephone, 40)
  };
  const redirectTo = typeof body.redirectTo === 'string' && /^https:\/\//.test(body.redirectTo) ? body.redirectTo : undefined;
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo, data: profile });
  if (error) {
    if (/already|exist|registered/i.test(error.message)) throw new Refus('Un compte existe déjà avec cette adresse.');
    throw error;
  }
  const id = data.user.id;
  await admin.from('profils').upsert({ id, ...profile, updated_at: new Date().toISOString() });
  const role = roleOf(body.role ?? (body.admin === true ? 'admin' : 'normal'));
  if (role !== 'normal') await writeRole(admin, email, role);
  return { ok: true, id };
}

// Nouvel envoi du mail d'invitation (compte pas encore activé).
async function reinvite(admin: Admin, body: Admin) {
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!email) throw new Refus('Adresse manquante.');
  const redirectTo = typeof body.redirectTo === 'string' && /^https:\/\//.test(body.redirectTo) ? body.redirectTo : undefined;
  const { error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
  if (error) throw error;
  return { ok: true };
}

const roleOf = (value: unknown) => (value === 'full' || value === 'admin' ? value : 'normal') as 'normal' | 'admin' | 'full';

async function writeRole(admin: Admin, email: string, role: 'normal' | 'admin' | 'full') {
  if (role === 'normal') {
    const { error } = await admin.from('sam_admins').delete().eq('email', email);
    if (error) throw error;
    return;
  }
  const { error } = await admin.from('sam_admins').upsert({ email, niveau: role });
  if (error) {
    if (/niveau/i.test(error.message)) throw new Refus('Exécutez d\'abord supabase/roles.sql dans Supabase (SQL Editor).');
    throw error;
  }
}

async function setRole(admin: Admin, body: Admin, myEmail: string) {
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!email) throw new Refus('Adresse manquante.');
  const role = roleOf(body.role);
  if (email === myEmail && role !== 'full') throw new Refus('Vous ne pouvez pas retirer vos propres droits « full admin ».');
  await writeRole(admin, email, role);
  return { ok: true };
}

async function suspend(admin: Admin, body: Admin, myId: string) {
  if (!body.id) throw new Refus('Compte manquant.');
  if (body.id === myId) throw new Refus('Vous ne pouvez pas suspendre votre propre compte.');
  const { error } = await admin.auth.admin.updateUserById(body.id, { ban_duration: body.suspended ? '876000h' : 'none' });
  if (error) throw error;
  return { ok: true };
}

// Téléphone perdu : retire la double authentification du compte ; la personne la réactive
// ensuite dans « Mon profil ». Pas pour son propre compte (à faire dans « Mon profil »).
async function resetMfa(admin: Admin, body: Admin, myId: string) {
  if (!body.id) throw new Refus('Compte manquant.');
  if (body.id === myId) throw new Refus('Pour votre propre compte, passez par « Mon profil ».');
  const { data, error } = await admin.auth.admin.mfa.listFactors({ userId: body.id });
  if (error) throw error;
  for (const factor of data?.factors ?? []) {
    const { error: e } = await admin.auth.admin.mfa.deleteFactor({ userId: body.id, id: factor.id });
    if (e) throw e;
  }
  return { ok: true, removed: (data?.factors ?? []).length };
}

async function remove(admin: Admin, body: Admin, myId: string) {
  if (!body.id) throw new Refus('Compte manquant.');
  if (body.id === myId) throw new Refus('Vous ne pouvez pas supprimer votre propre compte.');
  const { data } = await admin.auth.admin.getUserById(body.id);
  const { error } = await admin.auth.admin.deleteUser(body.id);
  if (error) throw error;
  const email = String(data?.user?.email ?? '').toLowerCase();
  if (email) await admin.from('sam_admins').delete().eq('email', email);
  return { ok: true };
}
