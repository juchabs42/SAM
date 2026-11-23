// Écran de connexion (obligatoire) : connexion, mot de passe oublié, demande d'accès,
// code de double authentification, choix du mot de passe après un lien reçu par mail.
import { auth, signIn, signOut, sendPasswordReset, updatePassword, authErrorMessage, mfaRequired, verifyMfa, requestAccess } from './auth.js';

const $ = id => document.getElementById(id);
const VIEWS = ['login', 'reset', 'request', 'mfa', 'password'];
const FOCUS = { login: 'sam-gate-email', reset: 'sam-gate-reset-email', request: 'sam-req-prenom', mfa: 'sam-gate-mfa-code', password: 'sam-gate-new' };

function setMessage(id, text = '', isError = false) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('is-error', Boolean(isError));
}

function showView(name) {
  VIEWS.forEach(view => { $(`sam-gate-${view}-view`).hidden = view !== name; });
  setTimeout(() => {
    const field = $(FOCUS[name]);
    if (name === 'login' && field.value) $('sam-gate-password').focus();
    else field?.focus();
  }, 30);
}

const isEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

/**
 * Affiche l'écran de connexion et résout quand un compte est connecté
 * (code de double authentification saisi, mot de passe choisi après un lien reçu par mail).
 * mode : 'login' (défaut), 'password' (lien d'invitation ou de mot de passe), 'mfa' (session à compléter).
 */
export function runGate({ mode = 'login', message = '' } = {}) {
  const gate = $('sam-gate');
  const app = $('sam-app');
  gate.hidden = false;
  app.hidden = true;
  document.body.classList.add('is-gated');

  return new Promise(resolve => {
    // Après la page de connexion : toujours l'onglet Données.
    const done = () => {
      if (window.location.hash !== '#/donnees') window.location.hash = '#/donnees';
      gate.hidden = true;
      app.hidden = false;
      document.body.classList.remove('is-gated');
      resolve(auth);
    };

    const showPassword = () => {
      const invite = auth.linkType === 'invite' || auth.linkType === 'signup';
      $('sam-gate-password-title').textContent = invite ? 'Bienvenue sur SAM' : 'Nouveau mot de passe';
      $('sam-gate-password-text').textContent = invite
        ? `Choisissez le mot de passe de votre compte ${auth.user?.email || ''}. Il vous servira à chaque connexion.`
        : `Choisissez un nouveau mot de passe pour ${auth.user?.email || 'votre compte'}.`;
      showView('password');
    };

    // Code de double authentification, puis la suite (l'application, ou le choix du mot de passe).
    let afterMfa = done;
    const askMfa = next => {
      afterMfa = next;
      $('sam-gate-mfa-code').value = '';
      setMessage('sam-gate-mfa-message', '');
      showView('mfa');
    };

    if (mode === 'mfa') {
      askMfa(done);
    } else if (mode === 'password') {
      // Compte protégé par la double authentification : le code avant le nouveau mot de passe.
      mfaRequired().then(needed => (needed ? askMfa(showPassword) : showPassword()));
    } else {
      showView('login');
      if (message) setMessage('sam-gate-login-message', message, true);
    }

    $('sam-gate-login').onsubmit = async event => {
      event.preventDefault();
      const email = $('sam-gate-email').value.trim();
      const password = $('sam-gate-password').value;
      if (!isEmail(email)) return setMessage('sam-gate-login-message', 'Indiquez une adresse mail valide.', true);
      if (!password) return setMessage('sam-gate-login-message', 'Indiquez votre mot de passe.', true);
      const submit = $('sam-gate-login-submit');
      submit.disabled = true;
      setMessage('sam-gate-login-message', 'Connexion…');
      try {
        await signIn(email, password);
        $('sam-gate-password').value = '';
        setMessage('sam-gate-login-message', '');
        if (await mfaRequired()) askMfa(done);
        else done();
      } catch (error) {
        setMessage('sam-gate-login-message', authErrorMessage(error), true);
      } finally {
        submit.disabled = false;
      }
    };

    $('sam-gate-mfa').onsubmit = async event => {
      event.preventDefault();
      const code = $('sam-gate-mfa-code').value.replace(/\D/g, '');
      if (code.length !== 6) return setMessage('sam-gate-mfa-message', 'Le code compte 6 chiffres.', true);
      const submit = $('sam-gate-mfa-submit');
      submit.disabled = true;
      setMessage('sam-gate-mfa-message', 'Vérification…');
      try {
        await verifyMfa(code);
        setMessage('sam-gate-mfa-message', '');
        afterMfa();
      } catch (error) {
        setMessage('sam-gate-mfa-message', authErrorMessage(error), true);
        $('sam-gate-mfa-code').select();
      } finally {
        submit.disabled = false;
      }
    };
    $('sam-gate-mfa-cancel').onclick = async () => {
      await signOut().catch(() => {});
      setMessage('sam-gate-login-message', '');
      showView('login');
    };

    $('sam-gate-forgot').onclick = () => {
      $('sam-gate-reset-email').value = $('sam-gate-email').value.trim();
      setMessage('sam-gate-reset-message', '');
      showView('reset');
    };
    $('sam-gate-back').onclick = () => {
      setMessage('sam-gate-login-message', '');
      showView('login');
    };

    $('sam-gate-reset').onsubmit = async event => {
      event.preventDefault();
      const email = $('sam-gate-reset-email').value.trim();
      if (!isEmail(email)) return setMessage('sam-gate-reset-message', 'Indiquez une adresse mail valide.', true);
      const submit = $('sam-gate-reset-submit');
      submit.disabled = true;
      setMessage('sam-gate-reset-message', 'Envoi…');
      try {
        await sendPasswordReset(email);
        setMessage('sam-gate-reset-message', 'C’est envoyé. Si un compte existe pour cette adresse, un mail arrive dans quelques minutes (pensez aux indésirables).');
      } catch (error) {
        setMessage('sam-gate-reset-message', authErrorMessage(error), true);
      } finally {
        submit.disabled = false;
      }
    };

    // Demande d'accès : formulaire public, enregistré dans Supabase (Administration > Comptes).
    $('sam-gate-request').onclick = () => {
      if (!$('sam-req-email').value) $('sam-req-email').value = $('sam-gate-email').value.trim();
      setMessage('sam-gate-request-message', '');
      showView('request');
    };
    $('sam-gate-request-back').onclick = () => {
      setMessage('sam-gate-login-message', '');
      showView('login');
    };
    $('sam-gate-request-form').onsubmit = async event => {
      event.preventDefault();
      const value = id => $(id).value.trim();
      const fields = {
        prenom: value('sam-req-prenom'),
        nom: value('sam-req-nom'),
        email: value('sam-req-email').toLowerCase(),
        telephone: value('sam-req-telephone'),
        structure: value('sam-req-structure'),
        commune: value('sam-req-commune'),
        profil: value('sam-req-profil'),
        message: value('sam-req-message'),
        site: value('sam-req-site')
      };
      const missing = [['sam-req-prenom', fields.prenom], ['sam-req-nom', fields.nom], ['sam-req-email', fields.email], ['sam-req-structure', fields.structure]].find(([, v]) => !v);
      if (missing) {
        setMessage('sam-gate-request-message', 'Complétez les champs marqués d’une étoile.', true);
        $(missing[0]).focus();
        return;
      }
      if (!isEmail(fields.email)) {
        setMessage('sam-gate-request-message', 'Indiquez une adresse mail valide.', true);
        $('sam-req-email').focus();
        return;
      }
      if (!$('sam-req-accord').checked) {
        setMessage('sam-gate-request-message', 'Cochez la case d’accord pour envoyer la demande.', true);
        $('sam-req-accord').focus();
        return;
      }
      const submit = $('sam-gate-request-submit');
      submit.disabled = true;
      setMessage('sam-gate-request-message', 'Envoi…');
      try {
        await requestAccess(fields);
        const body = $('sam-gate-request-body');
        body.innerHTML = '';
        const box = document.createElement('div');
        box.className = 'sam-gate-done';
        box.setAttribute('role', 'status');
        const title = document.createElement('strong');
        title.textContent = 'Demande envoyée, merci.';
        const text = document.createElement('span');
        text.textContent = `L’équipe SudExpé vous répond à l’adresse ${fields.email}. Si votre accès est validé, vous recevrez un mail pour choisir votre mot de passe (pensez aux indésirables).`;
        box.append(title, text);
        body.append(box);
        $('sam-gate-request-back').focus();
      } catch (error) {
        setMessage('sam-gate-request-message', `Envoi impossible : ${authErrorMessage(error)}`, true);
      } finally {
        submit.disabled = false;
      }
    };

    $('sam-gate-new-password').onsubmit = async event => {
      event.preventDefault();
      const password = $('sam-gate-new').value;
      const confirm = $('sam-gate-confirm').value;
      if (password.length < 8) return setMessage('sam-gate-password-message', 'Le mot de passe doit faire 8 caractères au moins.', true);
      if (password !== confirm) return setMessage('sam-gate-password-message', 'Les deux mots de passe ne sont pas identiques.', true);
      const submit = $('sam-gate-password-submit');
      submit.disabled = true;
      setMessage('sam-gate-password-message', 'Enregistrement…');
      try {
        await updatePassword(password);
        $('sam-gate-new').value = '';
        $('sam-gate-confirm').value = '';
        done();
      } catch (error) {
        setMessage('sam-gate-password-message', authErrorMessage(error), true);
      } finally {
        submit.disabled = false;
      }
    };
  });
}
