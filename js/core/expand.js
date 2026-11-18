// SAM Outils — bouton « Agrandir » sur tous les graphiques.
// Posé en haut à droite du graphique ; à côté du bouton CSV seulement quand ce CSV est
// dans l'en-tête du graphique (juste au-dessus). Le graphique passe en pleine page avec un bouton « Retour » ; Échap ou le retour du navigateur /
// du téléphone le referment aussi.

const ICON_EXPAND = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5M4 4l6 6M20 4l-6 6M4 20l6-6M20 20l-6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_BACK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CSV_SELECTOR = '.sam-csv-button:not(.sam-expand-button), [data-action="csv"]';

let open = null; // { wrapper, header, pushed, saved }

const chartOf = canvas => window.Chart?.getChart?.(canvas) || null;

function refresh(wrapper) {
  const canvas = wrapper.querySelector(':scope > canvas');
  const chart = canvas && chartOf(canvas);
  if (chart) chart.resize();
  // Graphiques dessinés à la main (Phénologie) : ils se redessinent sur « resize ».
  window.dispatchEvent(new Event('resize'));
}

// Titre du graphique : titre de sa carte, sinon description du canvas.
function titleOf(wrapper, root) {
  let el = wrapper;
  for (let i = 0; i < 6 && el && el !== root; i += 1) {
    el = el.parentElement;
    if (!el || el === root || el.querySelectorAll('canvas').length > 1) break;
    const heading = el.querySelector('h2, h3, h4, .don-chart-title, .panel-title');
    if (heading && heading.textContent.trim()) return heading.textContent.trim().replace(/\s+/g, ' ');
  }
  const canvas = wrapper.querySelector(':scope > canvas');
  return canvas?.getAttribute('aria-label') || 'Graphique';
}

// Bouton CSV « dans le graphique » : dans l'en-tête placé juste au-dessus du graphique
// (une légende peut s'intercaler). Un CSV ailleurs dans la page ne compte pas.
function csvOf(wrapper) {
  const card = wrapper.parentElement;
  if (!card) return null;
  let el = wrapper.previousElementSibling;
  for (let steps = 0; el && steps < 3; el = el.previousElementSibling) {
    if (el.getClientRects().length === 0 && !el.querySelector(CSV_SELECTOR)) continue; // élément masqué
    const found = el.matches(CSV_SELECTOR) ? [el] : [...el.querySelectorAll(CSV_SELECTOR)];
    if (found.length) return found[0];
    if (!/legend|legende/i.test(el.className || '')) return null;
    steps += 1;
  }
  return null;
}

function close({ fromHistory = false } = {}) {
  if (!open) return;
  const { wrapper, header, pushed, saved } = open;
  open = null;
  header.remove();
  wrapper.classList.remove('sam-chart-expanded');
  document.documentElement.classList.remove('sam-expand-open');
  if (pushed && !fromHistory && history.state?.samExpand) history.back();
  if (wrapper.isConnected) {
    // Taille d'avant : sans cela, un graphique dont le cadre suit la hauteur du dessin
    // garderait la hauteur de la pleine page.
    const canvas = wrapper.querySelector(':scope > canvas');
    if (canvas && saved.canvas === canvas) {
      canvas.style.width = saved.width;
      canvas.style.height = saved.height;
    }
    refresh(wrapper);
    window.scrollTo(saved.scrollX, saved.scrollY);
    wrapper.$samExpandButton?.focus({ preventScroll: true });
  }
}

function expand(wrapper, root) {
  if (open) close();
  const canvas = wrapper.querySelector(':scope > canvas');
  const saved = { canvas, width: canvas?.style.width || '', height: canvas?.style.height || '', scrollX: window.scrollX, scrollY: window.scrollY };
  const header = document.createElement('div');
  header.className = 'sam-expand-head';
  header.innerHTML = `<button type="button" class="sam-expand-back">${ICON_BACK}<span>Retour</span></button><strong></strong>`;
  header.querySelector('strong').textContent = titleOf(wrapper, root);
  header.querySelector('button').addEventListener('click', () => close());
  wrapper.appendChild(header);
  wrapper.classList.add('sam-chart-expanded');
  document.documentElement.classList.add('sam-expand-open');
  let pushed = false;
  try { history.pushState({ ...(history.state || {}), samExpand: true }, ''); pushed = true; } catch { /* sans historique */ }
  open = { wrapper, header, pushed, saved };
  refresh(wrapper);
  header.querySelector('button').focus({ preventScroll: true });
}

function makeButton(wrapper, root) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sam-csv-button sam-expand-button';
  button.title = 'Agrandir le graphique en pleine page';
  button.setAttribute('aria-label', 'Agrandir le graphique en pleine page');
  button.innerHTML = ICON_EXPAND;
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    expand(wrapper, root);
  });
  return button;
}

function place(wrapper, root) {
  let button = wrapper.$samExpandButton;
  const csv = csvOf(wrapper);
  if (button?.isConnected) {
    // Toujours bien placé : à côté du CSV s'il existe, sinon dans le coin.
    if (csv ? button.previousElementSibling === csv : button.parentElement === wrapper) return;
    button.remove();
  }
  button = button || makeButton(wrapper, root);
  wrapper.$samExpandButton = button;
  if (csv) {
    button.classList.remove('is-corner');
    wrapper.classList.remove('sam-has-expand-corner');
    // Ligne « titre … CSV » répartie sur la largeur : CSV et Agrandir restent collés.
    const parent = csv.parentElement;
    const spread = parent && /space-(between|around|evenly)/.test(getComputedStyle(parent).justifyContent);
    if (spread && !parent.classList.contains('sam-expand-pair')) {
      const pair = document.createElement('span');
      pair.className = 'sam-expand-pair';
      csv.before(pair);
      pair.appendChild(csv);
    }
    csv.after(button);
  } else {
    if (getComputedStyle(wrapper).position === 'static') wrapper.style.position = 'relative';
    button.classList.add('is-corner');
    wrapper.classList.add('sam-has-expand-corner');
    wrapper.appendChild(button);
  }
}

// Pas de bouton pour un graphique masqué (période sans données, onglet fermé…).
function syncVisibility(wrapper) {
  const button = wrapper.$samExpandButton;
  if (!button) return;
  const hide = !wrapper.classList.contains('sam-chart-expanded') && wrapper.getClientRects().length === 0;
  if (button.hidden !== hide) button.hidden = hide;
}

function scan(root) {
  if (open && !open.wrapper.isConnected) close({ fromHistory: !open.pushed });
  root.querySelectorAll('canvas').forEach(canvas => {
    if (canvas.closest('.leaflet-container, [data-no-expand], .sam-expand-head')) return;
    const wrapper = canvas.parentElement;
    if (!wrapper || wrapper === root) return;
    if (!chartOf(canvas)) canvas.classList.add('sam-expand-free');
    place(wrapper, root);
    syncVisibility(wrapper);
  });
}

/** À appeler une fois avec l'élément qui accueille les outils. */
export function installChartExpand(root) {
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; scan(root); });
  };
  // Nos propres ajouts relancent un passage qui ne change plus rien : pas de boucle.
  new MutationObserver(schedule).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
  window.addEventListener('popstate', () => { if (open) close({ fromHistory: true }); });
  window.addEventListener('hashchange', () => { if (open) close({ fromHistory: true }); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && open && !document.querySelector('dialog[open]')) close();
  });
  schedule();
}
