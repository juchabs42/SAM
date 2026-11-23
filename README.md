# SAM — Sud Agro Météo

Application unique qui regroupe les données des stations du réseau et les six outils SAM.
**La connexion est obligatoire** : les comptes sont créés par SudExpé (Administration → Comptes).
L'application s'ouvre sur l'onglet Données. Guide de reprise complet : « Guide Full admin — SAM »
(document Claude de Julien Chabat).

| Outil | Données | Accès (compte connecté) |
|---|---|---|
| Données (stations du réseau) | Supabase (collecte Comsag) + RIMpro | lecture ; « Fiche station » : full admin |
| Cartographie (stations du réseau) | Supabase + fonds IGN Géoplateforme | lecture ; un clic ouvre les données de la station |
| Indicateurs agroclimatiques | Open-Meteo | lecture |
| Programmation irrigation | Open-Meteo | lecture |
| Bilan irrigation | Open-Meteo + stations SAM + parcelles | tous les comptes ; parcelles du compte (privées) |
| Suivi phénologique | Supabase + Open-Meteo | lecture, saisie admin et full admin |
| Tavelure | Supabase | lecture, saisie admin et full admin |
| Piégeage | Supabase | lecture, saisie admin et full admin |
| Administration (comptes, demandes d'accès, stations, capteurs) | Supabase + fonction `sam-admin` | full admin uniquement |
| Aide (questions fréquentes, contact) | — | tous les comptes |

**Rôles**

| Rôle | Pour qui | Droits |
|---|---|---|
| Normal | producteurs, techniciens | consultation de tous les outils, ses propres parcelles |
| Admin | collègues SudExpé | en plus : saisie Phénologie, Tavelure, Piégeage — rien d'autre |
| Full admin | responsable du programme | tout : comptes, rôles, stations, capteurs, fiches stations, synchronisation |

**Accès aux données des stations** (Administration → Stations → Modifier) : « Visible par tous
les comptes » coché, tout le monde voit tout. Décoché, on règle séparément les données météo
(température, humidité, pluie, humectation, RIMpro) et les données irrigation (tensiomètres,
sondes capacitives, dendromètres) : tous les comptes, ou seulement les comptes cochés. Le filtrage
est fait par la base (vue `station_mesures_visibles`) ; admins et full admins voient tout. La
famille de chaque capteur se règle dans Administration → Capteurs (colonne « Famille »).

**Capteurs affichés, station par station** (Administration → Capteurs → « Noms des capteurs ») :
choisir la station, puis cocher ou décocher la case « Affiché » de chaque capteur (enregistré dès
le clic). Un capteur décoché (exemple : pas de pluviomètre à Carthagène P5) disparaît pour tous
les comptes : graphiques, encarts, résumé journalier et exports de l’onglet Données, infobulles de
la carte, et Bilan irrigation (qui garde alors la pluie d’Open-Meteo). Les mesures ne sont pas
effacées : elles restent consultables dans Administration → Capteurs. Nécessite
`supabase/capteurs_masques.sql`.

**Demandes d'accès** : la page de connexion propose « Demander un accès » (formulaire public :
coordonnées, structure, profil, message, accord RGPD). Les demandes arrivent dans Administration →
Comptes → « Demandes d’accès » : « Inviter » ouvre l'invitation pré-remplie et marque la demande
traitée ; « Archiver » la range. Une pastille jaune sur l'onglet Administration compte les demandes
en attente et les stations à surveiller (posées, actives, sans mesure depuis plus de 3 h ou en
erreur). Nécessite `supabase/demandes_acces.sql` (dépôt contrôlé : adresse valide, champ piège,
une demande par adresse et par jour, 20 par heure au plus).

**Double authentification** : chaque compte peut l'activer dans Mon profil (code à 6 chiffres
de Google Authenticator, Microsoft Authenticator…), recommandée pour les full admins (rappel dans
l'Administration). Une fois activée, le code est demandé à chaque connexion et, sans lui, la base
refuse les droits admin et full admin (`supabase/double_authentification.sql`, mêmes définitions
dans `schema.sql` et `roles.sql`). Téléphone perdu : Administration → Comptes → Fiche utilisateur
→ « Retirer la double authentification » (ou Supabase → Authentication → Users → le compte).

**Alertes gel** (Mon profil → Alertes gel) : par station, un seuil ; alerte du soir (prévision
Open-Meteo de la nuit, tâche `sam-alertes-prevision` à 17 h UTC) et alerte sur mesure (vérifiée
1 minute après chaque intégration Comsag, tâche `sam-alertes-mesures`, une fois par 12 h au plus).
Envoi par la fonction Supabase `sam-alertes` : notification (Web Push, clés créées et gardées dans
`sam_private.reglages`) et mail via Brevo (secret `BREVO_CLE` de la fonction ; adresse d'envoi
`mail_expediteur` dans `sam_private.reglages`, à valider dans Brevo). `supabase/alertes_gel.sql`.

**Pages légales** : `legal/mentions-legales.html`, `legal/confidentialite.html`,
`legal/conditions.html` (pages statiques, lisibles sans connexion), liées depuis la page de
connexion, le pied de page et l'Aide.

**Fiche station** : la même fenêtre (`js/core/station-dialog.js`) s’ouvre depuis Administration →
Stations (« Modifier », « + Nouvelle station ») et depuis Données (« Fiche station », full admin) :
identité, position sur la carte, RIMpro, collecte, accès météo / irrigation compte par compte.

**Collecte Comsag** : automatique toutes les 30 minutes (chaque station envoie une mesure par
heure). Synchronisation manuelle : Administration → Stations → « Synchroniser toutes les stations ».
Comsag renvoie parfois la même mesure avec un horodatage décalé d’une seconde : la collecte la
reconnaît (même station, moins de 60 s d’écart, aucune valeur contradictoire) et la fusionne avec
celle déjà enregistrée, sinon la pluie de l’heure serait comptée deux fois. Les copies enregistrées
avant cette correction ont été fusionnées le 22/11/2026 par `supabase/doublons_mesures.sql`
(239 lignes, sauvegardées dans `sam_private.station_mesures_doublons`).

**Données** : la pluviométrie n’est affichée que dans l’onglet Météo (graphique « Pluviométrie »,
encart « Pluviométrie 24 h », colonne du résumé journalier) ; l’onglet Irrigation ne montre que les
tensiomètres, sondes et dendromètres. Le bouton « Voir les prévisions » (à côté du nom de la station) ouvre l’onglet
Prévisions météo des Indicateurs, avec pour lieu la position exacte de la station (nommée d’après
sa commune). L’onglet Maladies / ravageurs affiche les modèles RIMpro de la station : tavelure du
pommier et du poirier, oïdium du pommier, feu bactérien, chancre européen, Marssonina,
stemphyliose, moniliose, cylindrosporiose du cerisier, carpocapse, puceron cendré, psylle du
poirier, et pour la vigne mildiou/oïdium/black-rot et eudémis (pages `rimpro.eu`, en français).

**Suivi phénologique** : seules les parcelles des variétés cultivées chez les producteurs sont
gardées. Les parcelles des blocs G et H (toutes années : 117 parcelles, 2 140 observations) ont été
retirées le 23/11/2026, après sauvegarde dans `sam_private.pheno_parcels_retirees` et
`sam_private.pheno_observations_retirees` (restauration possible par une requête SQL).

Tous les graphiques ont un bouton « Agrandir » en haut à droite (à côté du CSV quand celui-ci est dans l’en-tête du graphique) qui les affiche en pleine page.

Site statique (HTML, CSS, JavaScript sans compilation), publié par Cloudflare
(`https://sam.juju-chabat42.workers.dev`, redéployé à chaque poussée sur `main`). Seuls les
fichiers du site sont publiés : `.assetsignore` exclut `supabase/`, `tests/` et ce README.
`_headers` fixe les en-têtes de sécurité (dont la politique de contenu CSP : liste des services
externes autorisés, à compléter si un outil appelle un nouveau service) et la durée de cache.

## Mise en route Supabase (une seule fois)

1. **SQL Editor** : coller et exécuter `supabase/schema.sql`, `supabase/stations.sql`
   puis `supabase/connexion_comptes.sql` (lecture réservée aux comptes, profils, RIMpro),
   puis `supabase/pilotage.sql` (parcelles du Bilan irrigation ; tant qu'il n'est pas exécuté,
   l'outil garde les parcelles sur l'appareil et l'indique à l'écran),
   puis `supabase/roles.sql` (trois rôles : normal, admin, full admin),
   puis `supabase/acces_stations.sql` (qui voit les données météo / irrigation de chaque station),
   puis `supabase/capteurs_masques.sql` (capteurs affichés ou masqués, station par station),
   puis `supabase/activite_comptes.sql` (dernière activité réelle de chaque compte, affichée
   dans Administration → Comptes),
   puis `supabase/double_authentification.sql`, `supabase/demandes_acces.sql` et
   `supabase/maintenance.sql` (purge nocturne du journal des tâches automatiques).
2. **Authentication → Sign In / Providers** : désactiver *Allow new users to sign up*.
3. **Authentication → URL Configuration** : *Site URL* = adresse principale du site
   (aujourd'hui `https://sam.juju-chabat42.workers.dev`, plus tard le nom de domaine définitif).
   Ajouter dans *Redirect URLs* chaque adresse où le site est publié, suivie de `/**`
   (ex. `https://sam.juju-chabat42.workers.dev/**`) : c'est là que mènent les liens
   d'invitation et de « mot de passe oublié ».
4. **Authentication → Users → Add user** : *Send invitation* (la personne choisit son
   mot de passe) ou *Create new user* avec *Auto Confirm User* coché.
5. Rôles : depuis l'onglet Administration → Comptes → *Fiche utilisateur* (ou à la main, voir la fin de
   `supabase/roles.sql`). Table `sam_admins` : absent = normal, `niveau = 'admin'` = admin,
   `niveau = 'full'` = full admin.

6. **Onglet Administration → Comptes** (inviter ; fiche de chaque personne : informations
   renseignées, dernière activité, rôle, suspension, suppression) : déployer une fois la fonction `supabase/functions/sam-admin/index.ts`
   — *Edge Functions → Deploy a new function → Via Editor*, nom `sam-admin`, coller le fichier,
   *Deploy*, puis désactiver *Verify JWT* dans ses réglages (la fonction vérifie elle-même
   que l'appelant est « full admin » dans `sam_admins`). La clé d'administration lui est fournie
   par Supabase. Après une modification du fichier, recoller le code et refaire *Deploy*.
   La colonne « Dernière activité » s'appuie sur `supabase/activite_comptes.sql` : sans lui,
   elle montre la dernière saisie du mot de passe, qui ne bouge pas tant que la session
   reste ouverte (elle se prolonge seule).
7. **Mails (invitations, mot de passe oublié)** : le service d'envoi par défaut de Supabase
   n'écrit qu'aux membres de l'équipe du projet, avec un très petit nombre de mails par heure.
   Pour inviter des producteurs :
   - *Authentication → Emails → SMTP Settings* : activer *Enable custom SMTP* et saisir
     l'adresse d'envoi `sudagrometeo@gmail.com`, le nom (« SAM »), serveur `smtp.gmail.com`,
     port `465`, identifiant `sudagrometeo@gmail.com`, mot de passe = **mot de passe d'application**
     Google (compte Google → Sécurité → Validation en deux étapes activée → Mots de passe
     des applications), jamais le mot de passe habituel du compte ;
   - *Authentication → Rate Limits* : relever le nombre de mails par heure (ex. 30) ;
   - *Authentication → Emails → Templates* : coller le contenu de
     `supabase/emails/invitation.html` dans *Invite user* et de
     `supabase/emails/mot-de-passe.html` dans *Reset password* (sujets indiqués en tête
     de chaque fichier).

La clé utilisée dans `config.js` est la clé *publishable* : elle est faite pour être publique.
Ne jamais y mettre la clé *secret* / *service_role*.

## Organisation

```
index.html            cadre (écran de connexion, bandeau des stations, barre du haut, cartes outils, filtres)
config.js             URL et clé publique Supabase
css/app.css           styles du cadre
css/tools/*.css       styles de chaque outil (limités à leur conteneur)
js/core/*.js          connexion, profil, stations, lieux, période, navigation
js/tools/*.js         un module par outil (aide.js : page Aide)
legal/                pages légales (mentions, confidentialité, conditions d'utilisation)
404.html              page « introuvable »
js/fao56/             moteur du Bilan irrigation (méthode FAO-56, 2025) : ET₀, coefficients, bilan, apports
js/fao56/data/        tables FAO-56 2025 (cultures, sols, systèmes d'irrigation, paillages) avec leurs sources
tests/fao56/          tests du moteur sur les exemples chiffrés de FAO-56 (node --test "tests/fao56/*.test.mjs")
supabase/*.sql        tables, droits et règles d'accès, collecte des stations, imports
supabase/functions/   fonction « sam-admin » (gestion des comptes depuis l'onglet Administration)
supabase/roles.sql    rôles normal / admin / full admin
supabase/acces_stations.sql  accès aux données météo / irrigation, station par station
supabase/capteurs_masques.sql  capteurs masqués station par station (pluviomètre absent…)
supabase/doublons_mesures.sql  fusion des mesures Comsag reçues en double (exécuté le 22/11/2026)
supabase/double_authentification.sql  code à 6 chiffres exigé pour les droits admin des comptes qui l'activent
supabase/demandes_acces.sql  formulaire « Demander un accès » (table + fonction publique contrôlée)
supabase/maintenance.sql  purge du journal cron (14 jours), chemins de recherche des fonctions
supabase/alertes_gel.sql  alertes gel : tables, règles, listes pour la fonction, tâches automatiques
supabase/functions/sam-alertes/index.ts  envoi des alertes gel (notifications, mails Brevo)
supabase/activite_comptes.sql  dernière activité réelle des comptes (sessions qui se prolongent seules)
supabase/suppression_bilan_hydrique.sql  suppression des données de l'ancien Bilan hydrique
supabase/emails/      modèles des mails d'invitation et de mot de passe (en français)
_headers              en-têtes de sécurité, politique CSP, durée de cache (Cloudflare)
.assetsignore         fichiers du dépôt non publiés (SQL, tests, README)
wrangler.jsonc        réglage Cloudflare : Worker « sam », dossier publié, page 404
service-worker.js     fonctionnement hors connexion
```

## Mise à jour

Les fichiers sont servis tels quels : une modification poussée sur `main` est en ligne
après le redéploiement Cloudflare (1 à 2 minutes). Penser à changer le numéro de version
(`APP_VERSION` dans `js/core/shell.js`, `?v=` dans `index.html`, `CACHE` dans `service-worker.js`). Le service worker recharge
automatiquement la dernière version quand l'appareil est connecté.

## Nom de domaine

SudExpé est titulaire de `sudagrometeo.fr` (le `.com` n'est pas à SudExpé). Pour garder le site
actuel du domaine, publier les outils sur un sous-domaine, par exemple `outils.sudagrometeo.fr` :

- **Avec le Worker actuel** : le domaine doit être géré par Cloudflare (ajouter `sudagrometeo.fr`
  au compte Cloudflare, vérifier que les enregistrements DNS importés sont complets, en
  particulier la messagerie MX/SPF, puis remplacer les serveurs de noms chez le bureau
  d'enregistrement). Ensuite : *Workers & Pages → sam → Settings → Domains & Routes →
  Add → Custom Domain* → `outils.sudagrometeo.fr`.
- **Sans déplacer le DNS** : créer un projet Cloudflare *Pages* relié au même dépôt, lui
  ajouter le domaine personnalisé `outils.sudagrometeo.fr`, puis créer chez le gestionnaire
  DNS actuel un enregistrement CNAME `outils` → `<projet>.pages.dev`.

Une fois le domaine actif : le mettre en *Site URL* et dans les *Redirect URLs* de Supabase.

## Bilan irrigation (méthode FAO-56, édition 2025)

Ouvert à tous les comptes. Il remplace définitivement l'ancien « Bilan hydrique », supprimé du
site (les anciens liens `#/bilan` mènent au Bilan irrigation) et de la base : exécuter une fois
`supabase/suppression_bilan_hydrique.sql` (efface les tables `bilan_*`, irréversible). Sans
`supabase/pilotage.sql`, les parcelles du Bilan irrigation restent sur l'appareil.

- **Vocabulaire** : l'outil présente des estimations calculées (« apport calculé », « seuil
  d'irrigation atteint »), sans aucune recommandation, et rappelle que la décision d'irriguer
  revient à l'exploitant. Termes en langage courant ; réglages techniques repliés.
- **Méthode** : FAO (2025), *Crop evapotranspiration*, Irrigation and Drainage Paper 56 Rev.1,
  https://doi.org/10.4060/cd6621en. ET₀ Penman-Monteith recalculée à partir des données horaires
  Open-Meteo (réanalyse ERA5 jusqu'à J−8, prévision ensuite) ; une station SAM associée à la
  parcelle remplace températures, humidité et pluie. Bilan : coefficients de transpiration et
  évaporation du sol séparés, ajustement au climat, coefficient d'après la couverture mesurée,
  réserve utile et stress, paillages ; méthode simplifiée (Kc unique) en option.
- **Apports calculés** d'aujourd'hui à J+7 (mm, m³/ha, durée de poste), pendant la saison de
  culture uniquement. Irrigations saisies à la main ou importées d'un fichier Excel (colonnes
  Date et Apport). Pluie prévue comptée telle qu'annoncée ; l'onglet Bilan signale les pluies
  annoncées à plus de 2 jours (prévision incertaine). Seuil standard (RFU ajustée à la chaleur,
  ou fixe au choix), confort ou personnalisé, avec les valeurs en mm affichées sous le choix.
- **Lecture du bilan** : coefficient du jour décomposé (transpiration + évaporation du sol, avec
  la cause), transpiration et évaporation du sol séparées dans le tableau jour par jour, alerte
  quand les dates de saison s'écartent beaucoup des dates proposées, questions fréquentes dans
  l'onglet Aide.
- **Couverture mesurée** (facultatif) : ombre au sol vers midi (utilisée telle quelle) ou
  dimensions du feuillage vu du dessus (ombre de midi déduite de la forme, Encadré 9.2), avec
  calcul du pourcentage à partir des mesures.
- **Formulaire Parcelle** : aides repliées derrière un bouton « ? » ; lieu choisi par recherche
  (commune ou village) ou par la position de l'appareil, sans saisie de coordonnées ; dates
  intermédiaires de la saison recalées dans les proportions du calendrier de l'espèce quand on
  change la première ou la dernière (sauf si elles ont été corrigées). Les réglages qu'on ne
  mesure pas sur le terrain sont appliqués automatiquement : humidités et évaporation du sol
  selon le type de sol (Ze = 0,10 m, tableau 7.5), part du sol mouillée en surface selon le
  système, densité du feuillage (ML) et régulation des stomates (Fr), enracinement au semis et
  coefficient hors saison selon l'espèce. L'ajustement au climat est décoché par défaut avec des
  coefficients personnalisés (déjà calés sur le climat local).
- **Catalogue** : 76 espèces, 184 conduites (arboriculture, vigne, maraîchage, grandes cultures,
  prairies), généré depuis le PDF FAO ; à ne pas modifier à la main (`js/fao56/data/cultures-2025.js`).
- **Valeurs par défaut hors méthode FAO**, signalées dans l'outil : profondeur d'enracinement des
  ligneux (0,8 m), efficience du réseau, dates de saison proposées, volume de sol humecté
  (proposé selon le système : goutte-à-goutte 40 %, micro-aspersion 65 %, aspersion 100 % ;
  appliqué aux nouvelles parcelles et au changement de système, jamais aux parcelles existantes).
