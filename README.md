# SAM Outils — Sud Agro Météo (prototype)

Application unique qui regroupe les six outils SAM et les données des stations du réseau.
**La connexion est obligatoire** : les comptes sont créés dans Supabase par SudExpé.

| Outil | Données | Accès (compte connecté) |
|---|---|---|
| Données (stations du réseau) | Supabase (collecte Comsag) + RIMpro | lecture ; fiche station et synchronisation : full admin |
| Cartographie (stations du réseau) | Supabase + fonds IGN Géoplateforme | lecture ; un clic ouvre les données de la station |
| Indicateurs agroclimatiques | Open-Meteo | lecture |
| Programmation irrigation | Open-Meteo | lecture |
| Bilan irrigation | Open-Meteo + stations SAM + parcelles | tous les comptes ; parcelles du compte (privées) |
| Suivi phénologique | Supabase + Open-Meteo | lecture, saisie admin et full admin |
| Tavelure | Supabase | lecture, saisie admin et full admin |
| Piégeage | Supabase | lecture, saisie admin et full admin |
| Administration (comptes, stations, capteurs) | Supabase + fonction `sam-admin` | full admin uniquement |

**Rôles**

| Rôle | Pour qui | Droits |
|---|---|---|
| Normal | producteurs, techniciens | consultation de tous les outils, ses propres parcelles |
| Admin | collègues SudExpé | en plus : saisie Phénologie, Tavelure, Piégeage — rien d'autre |
| Full admin | responsable du programme | tout : comptes, rôles, stations, capteurs, fiches stations, synchronisation |

Tous les graphiques ont un bouton « Agrandir » en haut à droite (à côté du CSV quand celui-ci est dans l’en-tête du graphique) qui les affiche en pleine page.

Site statique (HTML, CSS, JavaScript sans compilation), publié par Cloudflare
(`https://sam.juju-chabat42.workers.dev`, redéployé à chaque poussée sur `main`) et par GitHub Pages
(`https://juchabs42.github.io/SAM-Outils/`).

## Mise en route Supabase (une seule fois)

1. **SQL Editor** : coller et exécuter `supabase/schema.sql`, `supabase/stations.sql`
   puis `supabase/connexion_comptes.sql` (lecture réservée aux comptes, profils, RIMpro),
   puis `supabase/pilotage.sql` (parcelles du Bilan irrigation ; tant qu'il n'est pas exécuté,
   l'outil garde les parcelles sur l'appareil et l'indique à l'écran),
   puis `supabase/roles.sql` (trois rôles : normal, admin, full admin).
2. **Authentication → Sign In / Providers** : désactiver *Allow new users to sign up*.
3. **Authentication → URL Configuration** : *Site URL* = adresse principale du site
   (aujourd'hui `https://sam.juju-chabat42.workers.dev`, plus tard le nom de domaine définitif).
   Ajouter dans *Redirect URLs* chaque adresse où le site est publié, suivie de `/**`
   (ex. `https://sam.juju-chabat42.workers.dev/**`) : c'est là que mènent les liens
   d'invitation et de « mot de passe oublié ».
4. **Authentication → Users → Add user** : *Send invitation* (la personne choisit son
   mot de passe) ou *Create new user* avec *Auto Confirm User* coché.
5. Rôles : depuis l'onglet Administration → Comptes → *Gérer* (ou à la main, voir la fin de
   `supabase/roles.sql`). Table `sam_admins` : absent = normal, `niveau = 'admin'` = admin,
   `niveau = 'full'` = full admin.

6. **Onglet Administration → Comptes** (inviter, changer le rôle, suspendre,
   supprimer depuis le site) : déployer une fois la fonction `supabase/functions/sam-admin/index.ts`
   — *Edge Functions → Deploy a new function → Via Editor*, nom `sam-admin`, coller le fichier,
   *Deploy*, puis désactiver *Verify JWT* dans ses réglages (la fonction vérifie elle-même
   que l'appelant est « full admin » dans `sam_admins`). La clé d'administration lui est fournie
   par Supabase. Après une modification du fichier, recoller le code et refaire *Deploy*.
7. **Mails (invitations, mot de passe oublié)** : le service d'envoi par défaut de Supabase
   n'écrit qu'aux membres de l'équipe du projet, avec un très petit nombre de mails par heure.
   Pour inviter des producteurs :
   - *Authentication → Emails → SMTP Settings* : activer *Enable custom SMTP* et saisir
     l'adresse d'envoi `sudagrometeo@gmail.com`, le nom (« SAM Outils »), serveur `smtp.gmail.com`,
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
js/tools/*.js         un module par outil
js/fao56/             moteur du Bilan irrigation (méthode FAO-56, 2025) : ET₀, coefficients, bilan, apports
js/fao56/data/        tables FAO-56 2025 (cultures, sols, systèmes d'irrigation, paillages) avec leurs sources
tests/fao56/          tests du moteur sur les exemples chiffrés de FAO-56 (node --test "tests/fao56/*.test.mjs")
supabase/*.sql        tables, droits et règles d'accès, collecte des stations, imports
supabase/functions/   fonction « sam-admin » (gestion des comptes depuis l'onglet Administration)
supabase/roles.sql    rôles normal / admin / full admin
supabase/emails/      modèles des mails d'invitation et de mot de passe (en français)
_headers              en-têtes de sécurité (hébergement Cloudflare)
service-worker.js     fonctionnement hors connexion
```

## Mise à jour

Les fichiers sont servis tels quels : une modification poussée sur `main` est en ligne
après le redéploiement Cloudflare et GitHub Pages (1 à 2 minutes). Le service worker recharge
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

Ouvert à tous les comptes. Il remplace définitivement l'ancien « Bilan hydrique » (supprimé du
site ; les anciens liens `#/bilan` mènent au Bilan irrigation). Les parcelles de l'ancien outil
restent en base (`bilan_parcels`) et se reprennent depuis le nouveau (bouton « Reprendre mes
parcelles de l'ancien Bilan hydrique »). Sans `supabase/pilotage.sql`, les parcelles restent
sur l'appareil.

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
  Date et Apport).
- **Catalogue** : 76 espèces, 184 conduites (arboriculture, vigne, maraîchage, grandes cultures,
  prairies), généré depuis le PDF FAO ; à ne pas modifier à la main (`js/fao56/data/cultures-2025.js`).
- **Valeurs par défaut hors méthode FAO**, signalées dans l'outil : profondeur d'enracinement des
  ligneux (0,8 m), efficience du réseau, dates de saison proposées, volume de sol humecté.
