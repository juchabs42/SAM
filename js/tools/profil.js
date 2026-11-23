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

  <section class="pro-card" id="proGelCard">
    <header class="pro-card-head">
      <h2>Alertes gel</h2>
      <p>Deux alertes possibles par station : le soir vers 18 h si la prévision de la nuit descend sous votre seuil, et la nuit dès qu’une mesure de la station passe sous le seuil. Par notification sur votre téléphone et par mail.</p>
    </header>
    <div id="proGel" aria-live="polite"><p class="pro-muted">Chargement…</p></div>
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
  // ---------------------------------------------------------------------------
  // Alertes gel : réglages (table alertes_gel) et notifications de cet appareil
  // ---------------------------------------------------------------------------
  const gelBox = $('proGel');
  const supa = ctx.supabase;
  const fmtSeuil = v => `${String(Number(v)).replace('.', ',').replace('-', '−')} °C`;
  const pushPossible = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const iphoneSansAppli = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.matchMedia('(display-mode: standalone)').matches;
  let gelState = { alertes: [], stations: [], abonne: false };

  const b64 = s => {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  };

  async function abonnementActuel() {
    if (!pushPossible() || Notification.permission !== 'granted') return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
  }

  async function chargerGel() {
    if (!supa) { $('proGelCard').hidden = true; return; }
    const [alertes, , sub] = await Promise.all([
      supa.from('alertes_gel').select('*').eq('user_id', ctx.user?.id).order('cree_le'),
      ctx.stations.store.load().catch(() => []),
      abonnementActuel().catch(() => null)
    ]);
    if (ctx.scope.disposed) return;
    if (alertes.error) { $('proGelCard').hidden = true; return; }
    gelState.alertes = alertes.data || [];
    // Stations proposées : installées, dont la température est visible par ce compte
    gelState.stations = (ctx.stations.store.list || [])
      .filter(st => st.installee !== false && st.acces?.meteo !== false && !(st.capteurs_masques || []).includes('t1'))
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    gelState.abonne = Boolean(sub);
    renderGel();
  }

  function renderGel(message = '', isError = false) {
    const { alertes, stations } = gelState;
    const nom = id => stations.find(st => st.id === id)?.nom || ctx.stations.store.list.find(st => st.id === id)?.nom || id;
    const libres = stations.filter(st => !alertes.some(a => a.station_id === st.id));
    const peutAjouter = libres.length > 0;
    const note = message ? `<p class="sam-form-message${isError ? ' is-error' : ''}" role="status">${escapeHtml(message)}</p>` : '';
    const appareil = !pushPossible()
      ? `<p class="pro-muted">${iphoneSansAppli() ? 'Sur iPhone, les notifications demandent d’installer SAM : bouton Partager de Safari, « Sur l’écran d’accueil », puis ouvrez SAM depuis son icône et revenez ici.' : 'Ce navigateur ne reçoit pas les notifications : les alertes arriveront par mail.'}</p>`
      : gelState.abonne
        ? '<p class="pro-status is-on"><span class="pro-dot" aria-hidden="true"></span>Notifications activées sur cet appareil</p>'
        : `<p class="pro-status"><span class="pro-dot" aria-hidden="true"></span>Notifications pas encore activées sur cet appareil</p>
           ${Notification.permission === 'denied' ? '<p class="pro-muted">Les notifications de SAM sont bloquées dans les réglages du navigateur : autorisez-les pour ce site, puis revenez ici.</p>' : ''}`;
    gelBox.innerHTML = `
      ${alertes.length ? `<ul class="pro-gel-liste">${alertes.map(a => `
        <li data-alerte="${escapeHtml(a.id)}">
          <div class="pro-gel-titre"><strong>${escapeHtml(nom(a.station_id))}</strong><span>seuil ${escapeHtml(fmtSeuil(a.seuil))}</span></div>
          <div class="pro-gel-options">
            <label class="sam-check"><input type="checkbox" data-champ="prevision"${a.prevision ? ' checked' : ''}><span>Prévision du soir</span></label>
            <label class="sam-check"><input type="checkbox" data-champ="mesure"${a.mesure ? ' checked' : ''}><span>Mesure de la station</span></label>
            <label class="sam-check"><input type="checkbox" data-champ="par_notification"${a.par_notification ? ' checked' : ''}><span>Notification</span></label>
            <label class="sam-check"><input type="checkbox" data-champ="par_mail"${a.par_mail ? ' checked' : ''}><span>Mail</span></label>
          </div>
          <button class="sam-button" type="button" data-gel="retirer">Retirer</button>
        </li>`).join('')}</ul>` : '<p class="pro-muted">Aucune alerte pour l’instant.</p>'}
      ${peutAjouter ? `<form class="pro-gel-ajout" id="proGelForm" novalidate>
        <label class="sam-field">Station<select id="proGelStation">${libres.map(st => `<option value="${escapeHtml(st.id)}">${escapeHtml(st.nom)}</option>`).join('')}</select></label>
        <label class="sam-field">Seuil (°C)<input id="proGelSeuil" type="number" step="0.5" min="-15" max="10" value="0" inputmode="decimal"></label>
        <button class="sam-button sam-button-primary" type="submit">Ajouter l’alerte</button>
      </form>` : !stations.length ? '<p class="pro-muted">Aucune station avec température ne vous est ouverte.</p>' : ''}
      <div class="pro-gel-appareil">
        ${appareil}
        <div class="pro-actions">
          ${pushPossible() && !gelState.abonne && Notification.permission !== 'denied' ? '<button class="sam-button sam-button-primary" type="button" data-gel="activer">Activer les notifications sur cet appareil</button>' : ''}
          ${alertes.length || gelState.abonne ? '<button class="sam-button" type="button" data-gel="essai">Envoyer une alerte d’essai</button>' : ''}
          ${note}
        </div>
      </div>`;
    $('proGelForm')?.addEventListener('submit', ajouterGel);
  }

  async function ajouterGel(event) {
    event.preventDefault();
    const seuil = Number(String($('proGelSeuil').value).replace(',', '.'));
    if (!Number.isFinite(seuil) || seuil < -15 || seuil > 10) return renderGel('Le seuil doit être compris entre −15 et 10 °C.', true);
    const { error } = await supa.from('alertes_gel').insert({ user_id: ctx.user.id, station_id: $('proGelStation').value, seuil });
    if (error) return renderGel(`Ajout impossible : ${error.message}`, true);
    await chargerGel();
    // Première alerte : on propose tout de suite les notifications de cet appareil.
    if (pushPossible() && !gelState.abonne && Notification.permission === 'default') renderGel('Alerte ajoutée. Activez les notifications sur cet appareil pour la recevoir ici.');
    else renderGel('Alerte ajoutée.');
  }

  async function activerNotifications() {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return renderGel('Notifications refusées : les alertes arriveront par mail.', true);
      const { data, error } = await supa.functions.invoke('sam-alertes', { body: { action: 'cle' } });
      if (error || !data?.cle) throw new Error(data?.error || error?.message || 'clé indisponible');
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(data.cle) });
      const j = sub.toJSON();
      const { error: e2 } = await supa.from('notifications_push').upsert({ user_id: ctx.user.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, appareil: navigator.userAgent.slice(0, 200) }, { onConflict: 'user_id,endpoint' });
      if (e2) throw e2;
      gelState.abonne = true;
      renderGel('Notifications activées sur cet appareil.');
    } catch (error) {
      renderGel(`Activation impossible : ${error.message || error}`, true);
    }
  }

  async function essaiGel() {
    const { data, error } = await supa.functions.invoke('sam-alertes', { body: { action: 'test', mail: true } });
    if (error || !data?.ok) return renderGel(`Essai impossible : ${data?.error || error?.message}`, true);
    const parts = [
      data.notifications ? `notification envoyée sur ${data.notifications} appareil${data.notifications > 1 ? 's' : ''}` : 'aucun appareil abonné aux notifications',
      data.mail ? 'mail envoyé' : data.mailDisponible ? 'mail non envoyé' : 'mails pas encore activés par SudExpé'
    ];
    renderGel(`Essai : ${parts.join(', ')}.`);
  }

  gelBox.addEventListener('click', async event => {
    const button = event.target.closest('button[data-gel]');
    if (!button) return;
    button.disabled = true;
    const action = button.dataset.gel;
    if (action === 'activer') await activerNotifications();
    if (action === 'essai') await essaiGel();
    if (action === 'retirer') {
      const id = button.closest('[data-alerte]').dataset.alerte;
      const { error } = await supa.from('alertes_gel').delete().eq('id', id);
      if (error) renderGel(`Retrait impossible : ${error.message}`, true);
      else { gelState.alertes = gelState.alertes.filter(a => String(a.id) !== id); renderGel('Alerte retirée.'); }
    }
    if (button.isConnected) button.disabled = false;
  });
  gelBox.addEventListener('change', async event => {
    const input = event.target.closest('input[data-champ]');
    if (!input) return;
    const id = input.closest('[data-alerte]').dataset.alerte;
    const { error } = await supa.from('alertes_gel').update({ [input.dataset.champ]: input.checked }).eq('id', id);
    if (error) { input.checked = !input.checked; return renderGel(`Enregistrement impossible : ${error.message}`, true); }
    const a = gelState.alertes.find(x => String(x.id) === id);
    if (a) a[input.dataset.champ] = input.checked;
  });
  chargerGel();

  // Essai d'activation abandonné en quittant la page : rien ne reste en attente.
  ctx.scope.add(() => { if (enrolling) mfa?.unenroll({ factorId: enrolling }).catch(() => {}); });
  renderMfa();

  return {};
}
