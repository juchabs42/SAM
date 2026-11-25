// Aide : questions fréquentes, contact, pages légales. Page statique, sans données.
const CONTACT = 'jchabat@sudexpe.net';

const q = (title, body, open = false) => `<details class="aid-q"${open ? ' open' : ''}><summary>${title}</summary><div class="aid-a">${body}</div></details>`;

const TEMPLATE = `
<div class="aid-main">
  <section class="aid-card aid-intro">
    <h2>SAM en bref</h2>
    <p>SAM — Sud Agro Météo est le service de SudExpé pour suivre la météo de vos parcelles et piloter l’irrigation. Il a trois rubriques, en haut de l’écran :</p>
    <ul class="aid-list">
      <li><a href="#/donnees"><strong>Données</strong></a> : les mesures des stations du réseau (températures, pluie, humidité, sondes du sol…), heure par heure, et les modèles RIMpro des stations abonnées.</li>
      <li><a href="#/indicateurs"><strong>Outils SAM</strong></a> : indicateurs agroclimatiques, programmation et bilan de l’irrigation, suivis phénologique, tavelure et piégeage de SudExpé.</li>
      <li><a href="#/carte"><strong>Cartographie</strong></a> : la carte des stations ; touchez une station pour ouvrir ses données.</li>
    </ul>
  </section>

  <section class="aid-card">
    <h2>Données des stations</h2>
    ${q('À quelle fréquence les données arrivent-elles ?', '<p>Les stations mesurent en continu et envoient une valeur par heure. SAM les récupère toutes les 30 minutes : la dernière mesure a donc en général moins d’une heure et demie. Exception : une station suivie en alerte gel envoie une mesure toutes les 5 minutes quand il fait 3 °C ou moins, et SAM la relève alors toutes les 5 minutes.</p>')}
    ${q('Pourquoi certaines données d’une station ne s’affichent pas ?', '<p>Deux raisons possibles : la station n’a pas ce capteur (pas de pluviomètre, par exemple), ou ses données d’irrigation sont réservées aux comptes choisis par son propriétaire (les données météo sont partagées avec tout le réseau). Pour obtenir un accès, écrivez à l’équipe SudExpé.</p>')}
    ${q('Comment garder mes stations en haut de la liste ?', '<p>Dans l’onglet Données, touchez l’étoile à côté du nom d’une station : elle rejoint vos favoris, en tête de liste, et s’ouvre par défaut.</p>')}
    ${q('Une station ne transmet plus : que faire ?', `<p>Le point de couleur à côté de son nom indique son état (vert : elle transmet). L’équipe SudExpé est prévenue des stations muettes ; si le problème dure, écrivez à <a href="mailto:${CONTACT}?subject=SAM%20%3A%20station%20muette">${CONTACT}</a>.</p>`)}
  </section>

  <section class="aid-card">
    <h2>Prévisions et outils</h2>
    ${q('D’où viennent les prévisions météo ?', '<p>D’<a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a>, qui rassemble les modèles des services météorologiques, dont ceux de Météo-France (AROME, ARPEGE), au point de grille le plus proche du lieu choisi. Les prévisions sont fiables sur 2 à 3 jours, indicatives au-delà, surtout pour la pluie.</p>')}
    ${q('Comment le Bilan irrigation calcule-t-il les apports ?', '<p>Il suit jour après jour l’eau du sol disponible pour la culture (méthode FAO-56) : la pluie et les irrigations la remplissent, la consommation de la culture la vide. Quand elle descend sous le seuil d’irrigation fixé pour la parcelle, SAM calcule l’apport qui la remonte. Les irrigations que vous saisissez corrigent le calcul.</p>')}
    ${q('Importer mes irrigations depuis Excel', '<p>Bilan irrigation → onglet <strong>Irrigations et pluies</strong> → <strong>Importer un fichier Excel</strong>. Téléchargez le modèle proposé sous « Unité de la colonne Apport » : une colonne Date, une colonne Apport. Remplissez les jours d’irrigation, laissez vides les autres, puis importez le fichier : SAM affiche un aperçu avant d’enregistrer.</p>')}
    ${q('Recevoir une alerte gel', '<p>Dans <a href="#/profil">Mon profil</a> → Alertes gel : choisissez la station et votre seuil (0 °C par défaut), puis « Activer les notifications sur cet appareil ». Vous pouvez suivre plusieurs stations. Deux alertes : dès qu’une mesure de la station passe sous le seuil et, avec la formule Complète, vers 18 h si la prévision de la nuit descend sous le seuil. La station envoie une mesure par heure ; sous 3 °C, elle passe à un envoi toutes les 5 minutes et SAM la relève aussi toutes les 5 minutes : l’alerte part moins de 10 minutes après la mesure. « Envoyer une alerte d’essai » vérifie que tout arrive. Sur iPhone, installez d’abord SAM sur l’écran d’accueil.</p>')}
    ${q('Comparer plusieurs stations (conseillers)', '<p>Avec le rôle Conseiller (ou administrateur), le bandeau des stations commence par « Mes groupes ». « Nouveau groupe » : donnez un nom (Bassin de Mogio, Nîmes…) et cochez de 2 à 8 stations. Touchez le groupe pour voir le tableau des stations et les courbes de température, d’humidité et de pluie, une couleur par station ; touchez une station pour l’ouvrir seule. Les groupes ne sont visibles que par vous.</p>')}
    ${q('Les calculs remplacent-ils un conseil ?', '<p>Non. Mesures, prévisions et calculs sont des aides à la décision : ils peuvent comporter des erreurs ou des interruptions. Les décisions d’irrigation, de traitement ou de protection restent les vôtres, avec votre connaissance du terrain et l’avis de votre conseiller.</p>')}
  </section>

  <section class="aid-card">
    <h2>Mon compte</h2>
    ${q('Que comprend ma formule ?', '<p>Votre formule figure dans <a href="#/profil">Mon profil</a>. <strong>Météo</strong> : données des stations, cartographie et alertes gel sur mesure. <strong>Outils SAM</strong> : prévisions et indicateurs agroclimatiques, programmation et bilan de l’irrigation, suivis phénologie, tavelure et piégeage. <strong>Complète</strong> : les deux. Pour changer de formule, écrivez à l’équipe SudExpé.</p>')}
    ${q('J’ai oublié mon mot de passe', '<p>Sur la page de connexion, touchez « Mot de passe oublié ? » et indiquez votre adresse : un lien arrive par mail pour en choisir un nouveau (pensez aux indésirables). Une fois connecté, vous le changez dans <a href="#/profil">Mon profil</a>.</p>')}
    ${q('Qu’est-ce que la double authentification ?', '<p>Une protection en plus du mot de passe : à chaque connexion, SAM demande un code à 6 chiffres affiché par une application de votre téléphone (Google Authenticator, Microsoft Authenticator…). Elle s’active dans <a href="#/profil">Mon profil</a>. Téléphone perdu ou changé : un administrateur SAM la retire de votre compte, puis vous la réactivez.</p>')}
    ${q('Installer SAM sur mon téléphone', '<p>SAM s’installe comme une application, sans passer par un magasin d’applications. Sur Android, touchez « Installer » en haut de l’écran ou dans le menu ⋮ de Chrome. Sur iPhone, dans Safari : bouton Partager, puis « Sur l’écran d’accueil ». L’application se met à jour toute seule.</p>')}
    ${q('Qui voit mes informations ?', '<p>Votre profil n’est visible que par vous et par les administrateurs SAM de SudExpé ; vos parcelles du Bilan irrigation, par vous seul. Le détail figure dans la <a href="legal/confidentialite.html">politique de confidentialité</a>.</p>')}
  </section>

  <section class="aid-card aid-contact">
    <h2>Contact</h2>
    <p>Une question, un problème, une idée d’amélioration : écrivez à l’équipe SudExpé, <a href="mailto:${CONTACT}?subject=SAM%20%3A%20">${CONTACT}</a>.</p>
    <p class="aid-legal"><a href="legal/mentions-legales.html">Mentions légales</a><a href="legal/confidentialite.html">Confidentialité</a><a href="legal/conditions.html">Conditions d’utilisation</a></p>
    <p class="aid-version" id="aidVersion"></p>
  </section>
</div>`;

export async function mount(root) {
  root.innerHTML = TEMPLATE;
  const version = window.SAM_CONFIG?.version;
  root.querySelector('#aidVersion').textContent = version ? `SAM version ${version}` : '';
  return {};
}
