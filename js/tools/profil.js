// Mon profil : informations personnelles du compte, mot de passe, double authentification,
// déconnexion.
import { updatePassword, authErrorMessage } from '../core/auth.js';
import { escapeHtml } from '../core/util.js';

const FIELDS = [
  { id: 'prenom', label: 'Prénom', type: 'text', autocomplete: 'given-name', max: 60 },
  { id: 'nom', label: 'Nom', type: 'text', autocomplete: 'family-name', max: 60 },
  { id: 'structure', label: 'Structure / exploitation', type: 'text', autocomplete: 'organization', max: 120 },
  { id: 'fonction', label: 'Fonction', type: 'text', autocomplete: 'organization-title', max: 80 },
  { id: 'telephone', label: 'Téléphone', type: 'tel', autocomplete: 'tel', max: 30 },
  { id: 'commune', label: 'Commune', type: 'text', autocomplete: 'address-level2', max: 80 }
];

const TEMPLATE = `
<div class="pro-main">
  <section class="pro-card pro-account">
    <div class="pro-avatar" id="proAvatar" aria-hidden="true"></div>
    <div class="pro-account-text">
      <h2 id="proName">Mon compte</h2>
      <p id="proEmail"></p>
      <span class="pro-badge" id="proRole"></span>
    </div>
    <button class="sam-button pro-logout" type="button" id="proLogout">Se déconnecter</button>
  </section>

  <section class="pro-card">
    <header class="pro-card-head">
      <h2>Mes informations</h2>
      <p>Elles permettent à l’équipe SudExpé de savoir qui utilise SAM. Seuls vous et les administrateurs SAM les voient.</p>
    </header>
    <form class="pro-form" id="proForm" novalidate>
      <div class="pro-grid">
        ${FIELDS.map(f => `<label class="sam-field">${f.label}<input id="pro-${f.id}" name="${f.id}" type="${f.type}" autocomplete="${f.autocomplete}" maxlength="${f.max}"></label>`).join('')}
      </div>
      <div class="pro-actions">
        <button class="sam-button sam-button-primary" type="submit" id="proSave">Enregistrer</button>
        <p class="sam-form-message" id="proMessage" role="status"></p>
      </div>
    </form>
  </section>

  <section class="pro-card">
    <header class="pro-card-head">
      <h2>Mot de passe</h2>
      <p>8 caractères au moins. Vous resterez connecté sur cet appareil.</p>
    </header>
    <form class="pro-form" id="proPasswordForm" novalidate>
      <div class="pro-grid">
        <label class="sam-field">Nouveau mot de passe<input id="proPassword" type="password" autocomplete="new-password" minlength="8"></label>
        <label class="sam-field">Confirmer<input id="proPasswordConfirm" type="password" autocomplete="new-password" minlength="8"></label>
      </div>
      <div class="pro-actions">
        <button class="sam-button" type="submit" id="proPasswordSave">Changer le mot de passe</button>
        <p class="sam-form-message" id="proPasswordMessage" role="status"></p>
      </div>
    </form>
  </section>

  <section class="pro-card" id="proMfaCard">
    <header class="pro-card-head">
      <h2>Double authentification</h2>
      <p>En plus du mot de passe, un code à 6 chiffres donné par une application de votre téléphone (Google Authenticator, Microsoft Authenticator…) est demandé à chaque connexion. Un mot de passe volé ne suffit plus pour entrer. Recommandée pour les comptes admin et full admin.</p>
    </header>
    <div id="proMfa" aria-live="polite"><p class="pro-muted">Chargement…</p></div>
  </section>

  <section class="pro-card pro-help">
    <p><strong>Besoin d’aide ?</strong> Consultez l’<a href="#/aide">aide de SAM</a> ou écrivez à <a href="mailto:jchabat@sudexpe.net?subject=SAM%20%3A%20">jchabat@sudexpe.net</a>.</p>
  </section>
</div>`;

export async function mount(root, ctx) {
  root.innerHTML = TEMPLATE;
  const $ = id => root.querySelector(`#${id}`);
  const user = ctx.user;

  function setMessage(id, text, isError = false) {
    $(id).textContent = text;
    $(id).classList.toggle('is-error', Boolean(isError));
  }

  function renderHeader(data) {
    const name = [data?.prenom, data?.nom].filter(Boolean).join(' ').trim();
    $('proName').textContent = name || 'Mon compte';
    $('proEmail').textContent = user?.email || '';
    const initials = name
      ? name.split(/\s+/).map(part => part[0]).join('').slice(0, 2)
      : (user?.email || '?')[0];
    $('proAvatar').textContent = initials.toUpperCase();
    $('proRole').textContent = ctx.isFullAdmin
      ? 'Full admin — accès complet (comptes, stations, saisie)'
      : ctx.isAdmin
        ? 'Admin — saisie Phénologie, Tavelure, Piégeage'
        : 'Normal — consultation (lecture seule)';
    $('proRole').classList.toggle('is-admin', Boolean(ctx.isAdmin));
  }

  function fillForm(data) {
    FIELDS.forEach(f => { $(`pro-${f.id}`).value = data?.[f.id] || ''; });
  }

  const data = await ctx.profile.load(true).catch(() => null);
  if (ctx.scope.disposed) return {};
  fillForm(data);
  renderHeader(data);

  $('proForm').addEventListener('submit', async event => {
    event.preventDefault();
    const patch = Object.fromEntries(FIELDS.map(f => [f.id, $(`pro-${f.id}`).value.trim()]));
    $('proSave').disabled = true;
    setMessage('proMessage', 'Enregistrement…');
    const { error } = await ctx.profile.save(patch);
    $('proSave').disabled = false;
    if (error) {
      const missing = /relation|does not exist|schema cache|profils/i.test(error.message || '');
      setMessage('proMessage', missing
        ? 'Enregistré sur cet appareil seulement : la table des profils n’est pas encore créée dans Supabase.'
        : `Enregistrement impossible : ${error.message || String(error)}`, true);
      return;
    }
    setMessage('proMessage', 'Informations enregistrées.');
    renderHeader(ctx.profile.data);
  });

  $('proPasswordForm').addEventListener('submit', async event => {
    event.preventDefault();
    const password = $('proPassword').value;
    const confirm = $('proPasswordConfirm').value;
    if (password.length < 8) return setMessage('proPasswordMessage', 'Le mot de passe doit faire 8 caractères au moins.', true);
    if (password !== confirm) return setMessage('proPasswordMessage', 'Les deux mots de passe ne sont pas identiques.', true);
    $('proPasswordSave').disabled = true;
    setMessage('proPasswordMessage', 'Enregistrement…');
    try {
      await updatePassword(password);
      $('proPassword').value = '';
      $('proPasswordConfirm').value = '';
      setMessage('proPasswordMessage', 'Mot de passe changé.');
    } catch (error) {
      setMessage('proPasswordMessage', authErrorMessage(error), true);
    } finally {
      $('proPasswordSave').disabled = false;
    }
  });

  $('proLogout').addEventListener('click', () => ctx.ui.logout());
  ctx.onAuthChange(() => renderHeader(ctx.profile.data));

  // ---------------------------------------------------------------------------
  // Double authentification (TOTP Supabase)
  // ---------------------------------------------------------------------------
  const mfa = ctx.supabase?.auth?.mfa;
  const mfaBox = $('proMfa');
  const dateFr = iso => (iso ? new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
  let enrolling = null;

  async function listTotp() {
    const { data, error } = await mfa.listFactors();
    if (error) throw error;
    return (data?.all || []).filter(f => f.factor_type === 'totp');
  }

  async function renderMfa(message = '', isError = false) {
    if (!mfa) { $('proMfaCard').hidden = true; return; }
    let factors;
    try {
      factors = await listTotp();
    } catch (error) {
      mfaBox.innerHTML = `<p class="sam-form-message is-error">Double authentification indisponible : ${escapeHtml(error.message || String(error))}</p>`;
      return;
    }
    if (ctx.scope.disposed) return;
    const active = factors.find(f => f.status === 'verified');
    const note = message ? `<p class="sam-form-message${isError ? ' is-error' : ''}" role="status">${escapeHtml(message)}</p>` : '';
    if (active) {
      mfaBox.innerHTML = `
        <p class="pro-status is-on"><span class="pro-dot" aria-hidden="true"></span>Activée${active.created_at ? ` depuis le ${escapeHtml(dateFr(active.created_at))}` : ''}</p>
        <p class="pro-muted">Téléphone perdu ou changé : un administrateur SAM peut retirer la double authentification de votre compte, que vous réactivez ensuite ici.</p>
        <div class="pro-actions" id="proMfaActions">
          <button class="sam-button" type="button" data-mfa="off">Désactiver</button>
          ${note}
        </div>`;
      return;
    }
    mfaBox.innerHTML = `
      <p class="pro-status"><span class="pro-dot" aria-hidden="true"></span>Non activée</p>
      <div class="pro-actions">
        <button class="sam-button sam-button-primary" type="button" data-mfa="start">Activer la double authentification</button>
        ${note}
      </div>`;
  }

  async function startEnroll(button) {
    button.disabled = true;
    try {
      // Essais précédents non terminés : retirés avant d'en créer un nouveau.
      for (const f of await listTotp()) if (f.status !== 'verified') await mfa.unenroll({ factorId: f.id });
      const { data, error } = await mfa.enroll({ factorType: 'totp', friendlyName: 'SAM', issuer: 'SAM (SudExpé)' });
      if (error) throw error;
      enrolling = data.id;
      const secret = data.totp?.secret || '';
      mfaBox.innerHTML = `
        <ol class="pro-steps">
          <li>Installez une application d’authentification sur votre téléphone si vous n’en avez pas : <strong>Google Authenticator</strong> ou <strong>Microsoft Authenticator</strong> (gratuites).</li>
          <li>Dans l’application, ajoutez un compte en scannant ce code :
            <div class="pro-qr"><img alt="QR code à scanner avec l’application d’authentification" width="180" height="180"></div>
            <span class="pro-muted">Pas d’appareil photo ? Saisissez cette clé dans l’application : <code class="pro-secret">${escapeHtml(secret.replace(/(.{4})/g, '$1 ').trim())}</code></span>
          </li>
          <li>Saisissez le code à 6 chiffres affiché par l’application :</li>
        </ol>
        <form class="pro-form" id="proMfaForm" novalidate>
          <div class="pro-grid">
            <label class="sam-field">Code à 6 chiffres<input id="proMfaCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required></label>
          </div>
          <div class="pro-actions">
            <button class="sam-button sam-button-primary" type="submit" id="proMfaVerify">Valider et activer</button>
            <button class="sam-button" type="button" data-mfa="cancel">Annuler</button>
            <p class="sam-form-message" id="proMfaMessage" role="status"></p>
          </div>
        </form>`;
      // Image SVG fournie par Supabase, réencodée (un « # » dans le SVG couperait l'adresse
      // « data: ») et posée par propriété, sans passer par le HTML.
      const qr = String(data.totp?.qr_code || '');
      const svgText = qr.replace(/^data:image\/svg\+xml;[^,]*,/, '');
      mfaBox.querySelector('.pro-qr img').src = svgText.trim().startsWith('<')
        ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`
        : qr;
      $('proMfaCode').focus();
      $('proMfaForm').addEventListener('submit', verifyEnroll);
    } catch (error) {
      enrolling = null;
      renderMfa(`Activation impossible : ${authErrorMessage(error)}`, true);
    }
  }

  async function verifyEnroll(event) {
    event.preventDefault();
    const code = $('proMfaCode').value.replace(/\D/g, '');
    const msg = $('proMfaMessage');
    if (code.length !== 6) { msg.textContent = 'Le code compte 6 chiffres.'; msg.classList.add('is-error'); return; }
    $('proMfaVerify').disabled = true;
    msg.textContent = 'Vérification…';
    msg.classList.remove('is-error');
    const { error } = await mfa.challengeAndVerify({ factorId: enrolling, code });
    if (ctx.scope.disposed) return;
    if (error) {
      $('proMfaVerify').disabled = false;
      msg.textContent = authErrorMessage(error);
      msg.classList.add('is-error');
      $('proMfaCode').select();
      return;
    }
    enrolling = null;
    ctx.ui.toast('Double authentification activée : le code sera demandé à chaque connexion.', 5000);
    renderMfa();
  }

  mfaBox.addEventListener('click', async event => {
    const button = event.target.closest('button[data-mfa]');
    if (!button) return;
    const action = button.dataset.mfa;
    if (action === 'start') startEnroll(button);
    if (action === 'cancel') {
      if (enrolling) await mfa.unenroll({ factorId: enrolling }).catch(() => {});
      enrolling = null;
      renderMfa();
    }
    if (action === 'off') {
      // Confirmation sur place (pas de fenêtre du navigateur)
      $('proMfaActions').innerHTML = `<span class="pro-muted">Le code ne sera plus demandé à la connexion.</span>
        <button class="sam-button sam-button-danger" type="button" data-mfa="off-confirm">Confirmer la désactivation</button>
        <button class="sam-button" type="button" data-mfa="keep">Garder</button>`;
    }
    if (action === 'keep') renderMfa();
    if (action === 'off-confirm') {
      button.disabled = true;
      try {
        const active = (await listTotp()).find(f => f.status === 'verified');
        if (active) {
          const { error } = await mfa.unenroll({ factorId: active.id });
          if (error) throw error;
        }
        ctx.ui.toast('Double authentification désactivée.');
        renderMfa();
      } catch (error) {
        renderMfa(`Désactivation impossible : ${authErrorMessage(error)}`, true);
      }
    }
  });
  // Essai d'activation abandonné en quittant la page : rien ne reste en attente.
  ctx.scope.add(() => { if (enrolling) mfa?.unenroll({ factorId: enrolling }).catch(() => {}); });
  renderMfa();

  return {};
}
