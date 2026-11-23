// Client Supabase partagé + état de connexion (utilisateur, droits administrateur).
// La connexion est obligatoire : sans session, l'application affiche l'écran de connexion.
import { createEmitter } from './util.js';

const emitter = createEmitter();

export const auth = {
  client: null,
  user: null,
  /** Rôle : 'normal' (lecture), 'admin' (saisie Phéno, Tavelure, Piégeage), 'full' (tout). */
  role: 'normal',
  /** admin ou full admin : saisie dans Phénologie, Tavelure, Piégeage. */
  isAdmin: false,
  /** full admin : comptes, stations, capteurs, fiches stations. */
  isFullAdmin: false,
  ready: false,
  configured: false,
  /** Lien reçu par mail : 'recovery' (mot de passe oublié), 'invite' (invitation), etc. */
  linkType: null,
  /** Erreur transmise par un lien expiré ou déjà utilisé. */
  linkError: null,
  onChange: fn => emitter.on(fn)
};

// Paramètres d'un lien Supabase (#access_token=…&type=recovery ou #error=…),
// lus avant que le client ne nettoie l'adresse.
function readAuthLink() {
  const hash = window.location.hash.replace(/^#/, '');
  if (!/(^|&)(access_token|error|error_description|error_code)=/.test(hash)) return;
  const params = new URLSearchParams(hash);
  auth.linkType = params.get('type') || null;
  const error = params.get('error_description') || params.get('error');
  if (error) {
    auth.linkError = params.get('error_code') === 'otp_expired' || /expired|invalid/i.test(error)
      ? 'Ce lien n’est plus valable (il a expiré ou a déjà servi). Demandez-en un nouveau avec « Mot de passe oublié ? ».'
      : `Lien refusé : ${error}`;
    // Le client ne traite pas ces erreurs : on nettoie l'adresse nous-mêmes.
    history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  }
}

function createClient() {
  const cfg = window.SAM_CONFIG || {};
  if (!cfg.supabaseUrl || !cfg.supabaseKey || !window.supabase?.createClient) return null;
  return window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'implicit',
      storageKey: 'samOutils-auth'
    }
  });
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Délai dépassé')), ms))
  ]);
}

async function rpcRole() {
  const { data, error } = await withTimeout(auth.client.rpc('sam_role'), 8000);
  if (!error) return ['full', 'admin'].includes(data) ? data : 'normal';
  // Fonction absente (roles.sql pas encore exécuté) : ancien contrôle, tout administrateur = full admin.
  if (error.code === 'PGRST202' || /sam_role/.test(error.message || '')) {
    const legacy = await withTimeout(auth.client.rpc('is_sam_admin'), 8000);
    if (legacy.error) throw legacy.error;
    return legacy.data === true ? 'full' : 'normal';
  }
  throw error;
}

async function checkRole() {
  if (!auth.client || !auth.user) return 'normal';
  try {
    return await rpcRole();
  } catch (error) {
    console.warn('Vérification des droits impossible', error);
    return 'normal';
  }
}

async function applySession(session) {
  const previousId = auth.user?.id || null;
  const previousRole = auth.role;
  auth.user = session?.user || null;
  auth.role = auth.user ? await checkRole() : 'normal';
  auth.isAdmin = auth.role === 'admin' || auth.role === 'full';
  auth.isFullAdmin = auth.role === 'full';
  auth.ready = true;
  if (previousId !== (auth.user?.id || null) || previousRole !== auth.role) {
    emitter.emit(auth);
  }
}

export async function initAuth() {
  readAuthLink();
  auth.client = createClient();
  auth.configured = Boolean(auth.client);
  if (!auth.client) {
    auth.ready = true;
    return auth;
  }
  try {
    const { data } = await auth.client.auth.getSession();
    await applySession(data?.session || null);
  } catch (error) {
    console.warn('Session Supabase illisible', error);
    auth.ready = true;
  }
  auth.client.auth.onAuthStateChange((event, session) => {
    // On sort de la callback avant tout appel Supabase (recommandation supabase-js).
    if (event === 'INITIAL_SESSION') return;
    if (event === 'PASSWORD_RECOVERY') auth.linkType = 'recovery';
    setTimeout(() => applySession(session), 0);
  });
  return auth;
}

export async function signIn(email, password) {
  if (!auth.client) throw new Error('Connexion indisponible : Supabase n’est pas configuré.');
  const { data, error } = await auth.client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  await applySession(data.session);
  return auth;
}

export async function signOut() {
  if (!auth.client) return;
  try {
    await auth.client.auth.signOut();
  } finally {
    await applySession(null);
  }
}

/** Envoie le mail « mot de passe oublié » ; le lien ramène sur cette page. */
export async function sendPasswordReset(email) {
  if (!auth.client) throw new Error('Connexion indisponible : Supabase n’est pas configuré.');
  const redirectTo = `${window.location.origin}${window.location.pathname}`;
  const { error } = await auth.client.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw error;
}

/** Nouveau mot de passe pour le compte connecté (lien reçu par mail ou page profil). */
export async function updatePassword(password) {
  if (!auth.client) throw new Error('Connexion indisponible : Supabase n’est pas configuré.');
  const { error } = await auth.client.auth.updateUser({ password });
  if (error) throw error;
  auth.linkType = null;
}

// ---------------------------------------------------------------------------
// Double authentification (code à 6 chiffres d'une application : Google Authenticator…)
// ---------------------------------------------------------------------------
/** Vrai si le compte connecté a activé la double authentification sans avoir encore saisi son code. */
export async function mfaRequired() {
  if (!auth.client?.auth?.mfa || !auth.user) return false;
  try {
    // Jeton passé en paramètre : la liste des codes activés est relue sur le serveur
    // (une session ouverte avant l'activation sur un autre appareil ne la connaît pas).
    const { data: current } = await auth.client.auth.getSession();
    const { data, error } = await auth.client.auth.mfa.getAuthenticatorAssuranceLevel(current?.session?.access_token);
    if (error) return false;
    return data?.nextLevel === 'aal2' && data?.currentLevel !== 'aal2';
  } catch {
    return false;
  }
}

/** Vérifie le code de l'application ; la session passe au niveau « aal2 » et les droits sont relus. */
export async function verifyMfa(code) {
  const { data: factors, error } = await auth.client.auth.mfa.listFactors();
  if (error) throw error;
  const factor = (factors?.totp || []).find(f => f.status === 'verified');
  if (!factor) throw new Error('Aucune double authentification n’est active sur ce compte.');
  const { error: verifyError } = await auth.client.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
  if (verifyError) throw verifyError;
  const { data } = await auth.client.auth.getSession();
  await applySession(data?.session || null);
}

/** Demande d'accès déposée depuis la page de connexion (sans compte). */
export async function requestAccess(fields) {
  if (!auth.client) throw new Error('Connexion indisponible : Supabase n’est pas configuré.');
  const { error } = await auth.client.rpc('sam_demander_acces', { p: fields });
  if (error) throw error;
}

/** Message lisible pour les erreurs de connexion Supabase. */
export function authErrorMessage(error) {
  const text = error?.message || String(error || '');
  if (/invalid totp|invalid.*code|mfa_verification_failed|code.*(invalid|expired)/i.test(text)) return 'Code incorrect ou expiré : saisissez le code affiché en ce moment par l’application.';
  if (/insufficient_aal|aal2/i.test(text)) return 'Saisissez d’abord votre code de double authentification.';
  if (/invalid login|invalid credentials/i.test(text)) return 'Adresse mail ou mot de passe incorrect.';
  if (/email not confirmed/i.test(text)) return 'Ce compte n’est pas encore confirmé : contactez SudExpé.';
  if (/rate limit|too many/i.test(text)) return 'Trop de tentatives : réessayez dans quelques minutes.';
  if (/should be different|same.*password/i.test(text)) return 'Choisissez un mot de passe différent de l’ancien.';
  if (/password.*(at least|characters|weak|short)/i.test(text)) return 'Mot de passe trop court ou trop simple (8 caractères au moins).';
  if (/failed to fetch|network/i.test(text)) return 'Pas de connexion internet.';
  if (/trop de demandes|adresse mail invalide|champ trop long|message trop long/i.test(text)) return text.replace(/^.*?(Trop|Adresse|Champ|Message)/, '$1');
  return text;
}
