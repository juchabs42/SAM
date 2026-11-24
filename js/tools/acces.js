// Accès terminé : formule Découverte arrivée à sa date de fin. Seules pages ouvertes : celle-ci,
// Mon profil et l'Aide, jusqu'à ce qu'un administrateur prolonge l'accès ou choisisse une formule.
const CONTACT = 'jchabat@sudexpe.net';

export async function mount(root, ctx) {
  const fin = ctx.accesJusqu ? new Date(`${ctx.accesJusqu}T12:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const sujet = encodeURIComponent('SAM : poursuivre mon abonnement');
  root.innerHTML = `
    <section class="acc-carte">
      <h2>Votre période d’accès est terminée</h2>
      <p>${fin ? `Votre accès à SAM a pris fin le ${fin}.` : 'Votre accès à SAM a pris fin.'} Vos réglages et vos parcelles sont conservés : ils seront de nouveau là dès la reprise de votre abonnement.</p>
      <p>Pour continuer, choisissez une formule (tarifs annuels hors taxes) et écrivez à l’équipe SudExpé :</p>
      <ul class="acc-formules">
        <li><strong>Météo</strong> : données des stations du réseau <span>80 € HT</span></li>
        <li><strong>Outils SAM</strong> : prévisions, indicateurs, bilan irrigation, suivis <span>80 € HT</span></li>
        <li><strong>Complète</strong> : météo + outils <span>150 € HT</span></li>
      </ul>
      <p class="acc-note">Adhérent d’une organisation de producteurs abonnée à SAM : votre accès passe par votre OP, demandez-lui de nous transmettre votre adresse.</p>
      <a class="sam-button sam-button-primary acc-contact" href="mailto:${CONTACT}?subject=${sujet}">Écrire à ${CONTACT}</a>
    </section>`;
  return {};
}
