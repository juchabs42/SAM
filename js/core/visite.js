// Visite guidée de SAM : à la première connexion (une fois par compte, notée dans le profil),
// puis à la demande (Aide, Mon profil). L'écran s'assombrit sauf l'élément expliqué ;
// une bulle décrit à quoi il sert. Étapes adaptées au rôle et à la formule du compte.
import { auth } from './auth.js';
import { profile } from './profile.js';

const $ = id => document.getElementById(id);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const mobile = () => window.matchMedia('(max-width: 1100px)').matches;

const OUTILS = [
  { id: 'indicateurs', title: 'Indicateurs agroclimatiques', text: 'Prévisions météo et indicateurs pour un lieu : pluie, températures, humidité, vent, évapotranspiration (ET0), déficit de pression de vapeur (DPV), indice de contrainte. Pour préparer la semaine.' },
  { id: 'irrigation', title: 'Programmation irrigation', text: 'Une estimation des besoins en eau de la culture pour les jours à venir, d’après les prévisions météo.' },
  { id: 'pilotage', title: 'Bilan irrigation', text: 'Le suivi de l’eau du sol de vos parcelles, jour après jour : la pluie et vos irrigations le remplissent, la culture le vide. Vos parcelles ne sont visibles que par vous.' },
  { id: 'phenologie', title: 'Suivi phénologique', text: 'Les stades des vergers suivis par SudExpé, variété par variété, pour situer votre saison.' },
  { id: 'tavelure', title: 'Tavelure', text: 'Le suivi des périthèces, de la maturité des ascospores et des projections de tavelure relevés par SudExpé.' },
  { id: 'piegeage', title: 'Piégeage', text: 'Les captures de ravageurs relevées dans les pièges suivis par SudExpé.' }
];

/** Étapes pour le compte connecté. */
function etapes() {
  const meteo = auth.voitStations;
  const outils = auth.voitOutils;
  const list = [
    { title: 'Bienvenue sur SAM', text: `SAM — Sud Agro Météo réunit les mesures des stations du réseau${outils ? ' et les outils de SudExpé pour piloter l’irrigation et suivre la saison' : ''}. Cette visite vous montre l’essentiel en une minute. Vous pourrez la revoir depuis l’Aide.` }
  ];
  if (meteo) {
    list.push(
      { route: 'donnees', target: '#sam-sidebar', drawer: true, title: 'Les stations du réseau', text: 'Toutes les stations SAM. Le point de couleur indique leur état : vert, elle transmet ; orange, elle a du retard ; rouge, elle ne transmet plus. Touchez une station pour l’ouvrir, et son étoile pour la garder en haut de la liste.' }
    );
    if (auth.peutGrouper) {
      list.push({ route: 'donnees', target: '#sam-groups', drawer: true, title: 'Mes groupes', text: 'Réunissez plusieurs stations proches dans un groupe (« Nouveau groupe ») : touchez-le pour comparer leurs courbes de température, d’humidité et de pluie, une couleur par station. Vos groupes ne sont visibles que par vous.' });
    }
    list.push(
      { route: 'donnees', target: '#donStation', title: 'Les données de la station', text: 'La station ouverte : dernières mesures (température, humidité, pluie) et état de transmission. « Exporter (Excel) » télécharge ses mesures.' },
      { route: 'donnees', target: '#donToolbar', title: 'Onglets, période et pas de temps', text: 'Les onglets Météo, Irrigation et Maladies / ravageurs (modèles RIMpro) s’affichent selon les capteurs de la station. Choisissez ensuite les dates et l’affichage heure par heure ou jour par jour. Sur un graphique, glissez pour zoomer ; un double-clic revient en arrière.' }
    );
  }
  if (outils) {
    list.push({ route: 'indicateurs', target: '#sam-nav-outils', title: 'Les Outils SAM', text: `${OUTILS.length} outils d’aide à la décision. Ils s’ouvrent ici et se retrouvent ensuite dans les cartes en haut de la page. Voyons-les un par un.` });
    OUTILS.forEach(outil => list.push({
      route: 'indicateurs',
      target: `#sam-tools a[href="#/${outil.id}"]`,
      title: outil.title,
      text: outil.text
    }));
  }
  if (meteo) {
    list.push({ route: 'carte', target: '#carteMap', place: 'corner', title: 'Cartographie', text: 'Toutes les stations sur la carte, avec leur température et leur pluie du jour. Touchez une station pour ouvrir ses données.' });
  }
  if (auth.isFullAdmin) {
    list.push({ target: '#sam-nav-admin', title: 'Administration', text: 'Les comptes (invitations, rôles, formules, demandes d’accès), les stations et leurs capteurs. Le badge signale ce qui demande votre attention.' });
  }
  list.push(
    { route: 'profil', target: '.tool-profil .pro-main', place: 'corner', page: true, title: 'Mon profil', text: `Votre page : vos coordonnées, votre mot de passe et la double authentification${meteo ? ', et vos alertes gel, par notification ou par mail dès qu’une station passe sous votre seuil' : ''}. On y revient avec l’icône de compte, en haut à droite.` },
    { target: '#sam-footer a[href="#/aide"]', title: 'Besoin d’aide ?', text: 'Les questions fréquentes et le contact de l’équipe SudExpé sont dans l’Aide. Vous pourrez y relancer cette visite à tout moment. Bonne saison !' }
  );
  return list;
}

const state = { running: false, steps: [], index: 0, root: null, onResize: null, collapsed: false };

async function cible(selector, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = document.querySelector(selector);
    if (el && el.getClientRects().length && !el.closest('[hidden]')) return el;
    await wait(120);
  }
  return null;
}

function placer(el) {
  const spot = state.root.querySelector('.sam-tour-spot');
  const bubble = state.root.querySelector('.sam-tour-bubble');
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!el) {
    spot.style.cssText = `left:${vw / 2}px;top:${vh / 2}px;width:0;height:0`;
    bubble.style.left = `${Math.max(12, (vw - bubble.offsetWidth) / 2)}px`;
    bubble.style.top = `${Math.max(12, (vh - bubble.offsetHeight) / 2)}px`;
    return;
  }
  const r = el.getBoundingClientRect();
  const step = state.steps[state.index];
  const pad = step?.page ? 0 : 6;
  // Page entière : la zone visible sous la barre du haut, sans déborder de l'écran
  const haut = step?.page ? ($('sam-app').querySelector('.sam-topbar')?.getBoundingClientRect().bottom || 0) + 8 : 4;
  const top = Math.max(haut, r.top - pad);
  const left = Math.max(4, r.left - pad);
  const bottom = Math.min(vh - (step?.page ? 8 : 4), r.bottom + pad);
  const right = Math.min(vw - 4, r.right + pad);
  spot.style.cssText = `left:${left}px;top:${top}px;width:${right - left}px;height:${bottom - top}px`;
  const bw = bubble.offsetWidth;
  const bh = bubble.offsetHeight;
  const gap = 14;
  let x;
  let y;
  if (state.steps[state.index]?.place === 'corner') {
    // Grande zone (carte, page) : la bulle dans un coin, par-dessus
    x = vw < 700 ? (vw - bw) / 2 : vw - bw - 24;
    y = vh - bh - (vw < 700 ? 12 : 24);
  } else if (mobile() && vw < 700) {
    // Téléphone : la bulle en bas (ou en haut si l'élément est en bas de l'écran)
    x = (vw - bw) / 2;
    y = bottom + gap + bh < vh - 8 ? bottom + gap : top - gap - bh >= 8 ? top - gap - bh : vh - bh - 12;
  } else if (right + gap + bw < vw - 12 && r.height > vh * 0.45) {
    // Élément haut (bandeau) : la bulle à droite
    x = right + gap;
    y = Math.min(Math.max(12, r.top + 40), vh - bh - 12);
  } else if (bottom + gap + bh < vh - 12) {
    x = r.left + r.width / 2 - bw / 2;
    y = bottom + gap;
  } else {
    x = r.left + r.width / 2 - bw / 2;
    y = Math.max(12, top - gap - bh);
  }
  bubble.style.left = `${Math.min(Math.max(12, x), vw - bw - 12)}px`;
  bubble.style.top = `${Math.min(Math.max(12, y), vh - bh - 12)}px`;
}

async function montrer(i) {
  const step = state.steps[i];
  if (!step) return terminer();
  state.index = i;
  const app = $('sam-app');
  if (step.route && !location.hash.startsWith(`#/${step.route}`)) location.hash = `#/${step.route}`;
  // Bandeau des stations : tiroir ouvert sur téléphone, déplié sur ordinateur
  if (step.drawer && mobile()) state.openDrawer?.();
  else if (mobile()) state.closeDrawer?.();
  if (step.drawer && !mobile() && app.classList.contains('is-collapsed')) {
    state.collapsed = true;
    app.classList.remove('is-collapsed');
  }
  const bubble = state.root.querySelector('.sam-tour-bubble');
  bubble.querySelector('.sam-tour-count').textContent = `${i + 1} / ${state.steps.length}`;
  bubble.querySelector('.sam-tour-title').textContent = step.title;
  bubble.querySelector('.sam-tour-text').textContent = step.text;
  bubble.querySelector('[data-tour="prev"]').hidden = i === 0;
  const last = i === state.steps.length - 1;
  bubble.querySelector('[data-tour="next"]').textContent = last ? 'Terminer' : i === 0 ? 'Commencer' : 'Suivant';
  bubble.querySelector('[data-tour="skip"]').hidden = last;
  state.root.classList.add('is-moving');
  let el = null;
  if (step.target) {
    el = await cible(step.target);
    if (state.steps[state.index] !== step || !state.running) return;
    // Élément absent (page pas encore chargée, rubrique masquée) : étape sautée
    const next = i + (state.dir || 1);
    if (!el && next >= 0 && next < state.steps.length) return montrer(next);
  }
  if (el) {
    // Page entière (Mon profil) : en haut de la page ; sinon, l'élément au centre de l'écran
    if (step.page) window.scrollTo({ top: 0, behavior: 'instant' });
    else el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await wait(mobile() ? 260 : 60);
  }
  state.target = el;
  state.root.classList.toggle('is-centered', !el);
  placer(el);
  state.root.classList.remove('is-moving');
  bubble.querySelector('[data-tour="next"]').focus({ preventScroll: true });
}

function aller(delta) {
  state.dir = delta;
  const next = state.index + delta;
  if (next < 0) return;
  if (next >= state.steps.length) return terminer();
  montrer(next);
}

function clavier(event) {
  if (!state.running) return;
  if (event.key === 'Escape') { event.preventDefault(); terminer(); }
  else if (event.key === 'ArrowRight') { event.preventDefault(); aller(1); }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); aller(-1); }
  else if (event.key === 'Tab') {
    // La touche Tab reste dans la bulle
    const items = [...state.root.querySelectorAll('.sam-tour-bubble button:not([hidden])')];
    const at = items.indexOf(document.activeElement);
    event.preventDefault();
    items[(at + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
  }
}

async function terminer() {
  if (!state.running) return;
  state.running = false;
  window.removeEventListener('resize', state.onResize);
  window.removeEventListener('scroll', state.onResize, true);
  document.removeEventListener('keydown', clavier, true);
  state.root?.remove();
  state.root = null;
  if (mobile()) state.closeDrawer?.();
  if (state.collapsed) $('sam-app').classList.add('is-collapsed');
  state.collapsed = false;
  window.dispatchEvent(new Event('resize'));
  // Vue : la visite ne se relance plus d'elle-même (sur tous les appareils du compte)
  try {
    await profile.save({ visite_vue_le: new Date().toISOString() });
  } catch { /* profil indisponible : noté sur l'appareil par profile.save */ }
}

/** Lance la visite. `options.openDrawer` / `closeDrawer` : tiroir des stations (téléphone). */
export function startTour(options = {}) {
  if (state.running || !auth.user || auth.formule === 'terminee') return;
  state.openDrawer = options.openDrawer;
  state.closeDrawer = options.closeDrawer;
  state.steps = etapes();
  state.running = true;
  state.dir = 1;
  const root = document.createElement('div');
  root.className = 'sam-tour is-centered';
  root.innerHTML = `
    <div class="sam-tour-spot" aria-hidden="true"></div>
    <div class="sam-tour-bubble" role="dialog" aria-modal="true" aria-labelledby="sam-tour-title" aria-describedby="sam-tour-text">
      <p class="sam-tour-count"></p>
      <h2 class="sam-tour-title" id="sam-tour-title"></h2>
      <p class="sam-tour-text" id="sam-tour-text"></p>
      <div class="sam-tour-actions">
        <button type="button" class="sam-tour-skip" data-tour="skip">Passer la visite</button>
        <span>
          <button type="button" class="sam-button" data-tour="prev">Précédent</button>
          <button type="button" class="sam-button sam-button-primary" data-tour="next">Suivant</button>
        </span>
      </div>
    </div>`;
  root.addEventListener('click', event => {
    const action = event.target.closest('[data-tour]')?.dataset.tour;
    if (action === 'next') aller(1);
    else if (action === 'prev') aller(-1);
    else if (action === 'skip') terminer();
  });
  document.body.appendChild(root);
  state.root = root;
  state.onResize = () => { if (state.running) placer(state.target && state.target.isConnected ? state.target : null); };
  window.addEventListener('resize', state.onResize);
  window.addEventListener('scroll', state.onResize, true);
  document.addEventListener('keydown', clavier, true);
  montrer(0);
}

/** Première connexion : la visite démarre seule si elle n'a jamais été vue sur ce compte. */
export async function maybeStartTour(options = {}) {
  if (!auth.user || auth.formule === 'terminee') return;
  const data = await profile.load().catch(() => null);
  if (!data || data.visite_vue_le) return;
  await wait(900);
  if (!auth.user || document.querySelector('dialog[open]')) return;
  startTour(options);
}

export const _test = { etapes };
