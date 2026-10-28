# Cerebro

Cerebro est une application web locale qui centralise des sessions interactives de
Claude Code, Codex et Grok. Les sessions sont regroupées par projet, restent
pilotables dans un terminal web et signalent les demandes de confirmation ou la fin
d'un tour. Chaque agent est hébergé dans un processus détaché : les sessions en
cours survivent à l'arrêt, au redémarrage ou au crash du serveur Cerebro.

## Prérequis

- Node.js 22 et npm ;
- au moins un des exécutables `claude`, `codex` ou `grok` dans le `PATH` ;
- Git, uniquement pour afficher l'état Git des projets.

## Installation et lancement

```sh
npm install
npm run build
npm start
```

L'interface est alors disponible sur <http://127.0.0.1:4317>. La commande
`npm run start:prod` regroupe la construction du front et le lancement du serveur.

Pour le développement, lancez le serveur et Vite avec rechargement automatique :

```sh
npm run dev
```

### Qualité du code

Le code est formaté par Prettier et vérifié par ESLint (typescript-eslint et
eslint-plugin-react-hooks, dont `exhaustive-deps`). Avant chaque commit :

```sh
npm run format      # reformate le code (format:check vérifie seulement)
npm run lint        # ESLint, sans avertissement toléré
npm run typecheck   # TypeScript 7
npm test
```

Tout le code passe par Prettier, sans ligne compactée à la main ; une exception
ESLint locale (`eslint-disable-next-line`) indique sa raison. typescript-eslint
ne prend pas encore en charge TypeScript 7, qui n'expose pas d'API JavaScript :
le paquet `typescript` pointe donc sur `@typescript/typescript6` pour le lint,
et `npm run typecheck` lance le `tsc` de TypeScript 7 installé sous l'alias
`typescript7`. Le reformatage global est listé dans `.git-blame-ignore-revs` :
`git config blame.ignoreRevsFile .git-blame-ignore-revs` l'écarte de `git blame`.

Langue : les identifiants (variables, types, routes, champs JSON) sont en
anglais ; les textes vus par l'utilisateur (interface, messages d'erreur,
notifications, prompts confiés aux agents), la documentation et les messages de
commit sont en français. Les commentaires suivent la langue déjà dominante du
fichier, une seule par fichier ; un nouveau fichier les écrit en anglais.

## Statistiques d’utilisation des LLM

L’accueil affiche une barre de répartition des sessions entre Claude, Codex et
Grok, avec des filtres sur 7 jours, 30 jours ou tout l’historique conservé. La
période sélectionne les sessions par leur date de création ; les tokens affichés
sont les cumuls de ces sessions principales, hors sous-agents.

Les compteurs d’entrée et de sortie proviennent des journaux locaux des agents,
rafraîchis toutes les 30 secondes. Les tokens de cache sont inclus dans l’entrée
et détaillés sans être ajoutés une seconde fois au total. Un journal absent donne
« Tokens indisponibles ». Un relevé incomplet est signalé, notamment pour Grok
dont le journal global peut être purgé indépendamment des sessions.

## Configuration

| Variable | Valeur par défaut | Rôle |
|---|---:|---|
| `CEREBRO_HOST` | `127.0.0.1` | Adresse d'écoute du serveur. |
| `CEREBRO_PORT` | `4317` | Port HTTP et WebSocket (entier entre 1 et 65535 ; une valeur invalide arrête le démarrage). |
| `CEREBRO_DATA_DIR` | `~/.cerebro` | Base SQLite, sockets des holders, journaux de terminal et `hooks.jsonl`. |
| `CEREBRO_BIND_TOKEN` | non défini | Protège les API et WebSockets lorsqu'un accès réseau est nécessaire. |
| `CEREBRO_KILL_ON_EXIT` | non défini | Avec la valeur `1`, tue les agents lorsque le serveur s'arrête (ancien comportement). |
| `CEREBRO_GIT_TIMEOUT_READ` | `60` | Secondes avant l'arrêt d'une lecture Git (status, diff, log…), hooks et processus enfants compris. |
| `CEREBRO_GIT_TIMEOUT_WRITE` | `600` | Idem pour les opérations qui écrivent (commit, merge, checkout, update-ref…) et peuvent lancer des hooks. |
| `CEREBRO_GIT_TIMEOUT_NETWORK` | `600` | Idem pour push et fetch. À l'expiration, l'opération échoue avec « Opération Git interrompue après N s ». Pour ces trois variables, une valeur non numérique, nulle ou négative est ignorée (avertissement au démarrage) au profit du défaut. |
| `CEREBRO_SLACK_TOKEN` | non défini | Jeton bot Slack `xoxb-…`. Sans ce jeton, l'intégration Slack est inactive. |
| `CEREBRO_SLACK_USER` | non défini | ID Slack (`U…`) du destinataire des messages privés. |
| `CEREBRO_SLACK_ALERTS` | `all` | Alertes automatiques par défaut : `all`, `waiting` (questions et confirmations seulement) ou `off`. Modifiable ensuite dans l'interface. |
| `CEREBRO_SLACK_DELAY` | `30` | Délai par défaut en secondes avant une alerte automatique. Modifiable ensuite dans l'interface. |
| `CEREBRO_MACHINE_NAME` | nom d'hôte | Nom de la machine dans le sélecteur multi-machines. |
| `CEREBRO_PUBLIC_URL` | `http://${CEREBRO_HOST}:${CEREBRO_PORT}` | Base des liens « Ouvrir dans Cerebro » envoyés sur Slack ; origine acceptée pour les WebSockets et les requêtes de modification. |

Pour une écoute sur le réseau local, définissez un secret robuste en même temps que
`CEREBRO_HOST=0.0.0.0`. Saisissez le secret dans l'écran « Token requis » (ou ouvrez
`http://hote:4317/?token=SECRET`) : Cerebro l'enregistre pour un an dans un cookie
`httpOnly`, `SameSite=Strict` (et `Secure` derrière HTTPS). L'écran passe par
`POST /api/auth`, ce qui fonctionne aussi derrière le serveur de dev Vite. Les clients API
peuvent aussi utiliser `?token=SECRET` ou l'en-tête
`Authorization: Bearer SECRET`. Les hooks d'agents conservent leur jeton propre.

Les WebSockets et les requêtes de modification (`POST`, `PATCH`, `DELETE`…) venant d'un
navigateur sont refusés (403) si leur en-tête `Origin` n'est pas celle de l'interface :
`CEREBRO_PUBLIC_URL`, l'adresse d'écoute et ses alias de bouclage sur `CEREBRO_PORT`, ou le
serveur de dev Vite (`:5173`). Avec `CEREBRO_BIND_TOKEN`, l'hôte demandé (`Host` ou
`X-Forwarded-Host`) est aussi accepté. Une page tierce ouverte dans le navigateur ne peut donc
pas piloter les terminaux, même depuis un autre port de `localhost`. Les clients hors navigateur
(bins, hooks) n'envoient pas d'`Origin` ou s'authentifient par jeton explicite, et ne sont pas
concernés. La passerelle multi-machines valide l'`Origin` localement puis retire `Origin` et
`Referer` des requêtes relayées : une machine distante sans jeton accepte donc les modifications. Sans jeton, renseignez `CEREBRO_PUBLIC_URL` si l'interface
est ouverte sous une autre adresse.

Les PTY restent attachés à des processus `server/holder.ts` indépendants. Au
redémarrage, le serveur retrouve les sockets dans
`$CEREBRO_DATA_DIR/sessions/`, restaure l'écran du terminal et reprend la
détection d'attente. Le journal brut continue d'être écrit pendant toute
l'indisponibilité du serveur.

## Notifications Slack

Créez une app depuis [api.slack.com/apps](https://api.slack.com/apps), ajoutez
les scopes Bot Token `chat:write`, `im:write`, `im:history` et
`reactions:write`, puis installez l'app dans l'espace de travail. Copiez son
jeton bot dans `CEREBRO_SLACK_TOKEN`. Dans Slack, ouvrez votre profil, puis
utilisez ⋮ → « Copier l'ID de membre » pour renseigner
`CEREBRO_SLACK_USER`. Les deux variables sont nécessaires pour activer
l'intégration.

Dans le message privé, écrivez `projet: instruction` pour reprendre la session
active du projet, ou en créer une avec les réglages mémorisés du projet s'il n'y en a pas. Ajoutez `+`
(`projet+: instruction`) pour forcer une nouvelle session, et `/claude`,
`/codex` ou `/grok` pour choisir l'agent (`projet/codex+: instruction`). La
lecture de ces commandes nécessite le scope Bot Token `im:history`. Envoyez `help` (ou
`aide`, `?`) pour obtenir la syntaxe, la liste des projets avec leur session
active et la façon de répondre dans un fil. `list` (ou `liste`, `projets`) affiche seulement
la liste des projets avec leur session active.

`council: question` réunit le [council](#council) hors projet, sans accès aux
fichiers ; `projet/council: question` le réunit sur un projet, avec les réglages
effectifs de ce projet (participants par défaut et lecture du dépôt comprise). Le
mot-clé `council` prime sur un projet qui porterait ce nom. Un sablier marque le
message pendant les quelques minutes d'exécution, puis la recommandation, la
première action, les accords et les désaccords sont publiés dans le fil avec le
lien du rapport, sans notification séparée.

Écrivez `? question` pour interroger Cerebro en langage libre, par exemple
`? où en sont les tâches du projet ACME ?`. Claude (CLI `claude` locale, via le SDK)
répond dans le fil à partir de l'état des projets, sessions, epics et tâches de la
machine et des machines déclarées dans `remotes.json` ; il peut aussi lire (sans
rien modifier) les fichiers des projets locaux. Un sablier marque la question
pendant la recherche.

Les consultations factuelles suivantes sont traitées directement, sans agent :

```text
? etat sessions statut=waiting
? etat taches projet="ACME" statut=restantes compter
? etat epics machine="portable"
? etat avancement projet="ACME" epic="Livraison"
? etat blocages projet="ACME" epic="identifiant"
? etat activites projet="ACME"
? etat machines
```

Les noms de projets, de machines et d'epics doivent être exacts ; les projets et
les epics acceptent aussi leur identifiant. Les filtres `projet=`, `machine=`,
`statut=` et `epic=` se combinent, avec des guillemets pour les espaces. `compter`
se place à la fin. Statuts de session : `starting`, `running`, `waiting`, `idle`,
`exited` ; statuts de tâche : `todo`, `started`, `done`, `restantes`. Les dépendances
bloquantes incluent celles hors de l'epic choisi. Les activités sont les dernières
modifications enregistrées des objets, pas un journal complet des actions.
`done` décrit une déclaration de clôture, sans attester la validation effective.
Les machines inaccessibles sont signalées et les totaux sont alors incomplets.
Les formulations « combien de tâches restent ? », « combien de tâches restantes ? »,
« combien de tâches reste-t-il ? », « liste des sessions en attente »,
« quelles sessions sont en attente ? » et « sessions en attente » sont aussi
reconnues exactement. Les autres questions conservent le traitement Claude décrit
ci-dessus ; une commande `etat` invalide affiche l'aide sans appeler de modèle.

Si plusieurs machines lisent le même message privé, une seule traite les
commandes sans projet : `help`, `list`, `? question`, `council: question`,
messages non reconnus et projets introuvables. Par défaut, Cerebro la choisit automatiquement parmi les
machines actives. Pour imposer la machine, cochez « Commandes générales » dans
le panneau Slack de la barre latérale de cette machine. Le choix est partagé
avec les autres machines ; pour le changer, cochez la case sur une autre machine.
`list` montre aussi les projets présents seulement sur les autres machines.

Cerebro envoie alors un message privé après le délai configuré lorsqu'une
session demande une confirmation ou termine son tour. L'alerte est annulée si
la session est vue, repart ou se termine entre-temps. Un agent peut aussi
ajouter du contexte ou poser une question bloquante :

```sh
cerebro-notify "Le rapport nécessite une décision sur les données manquantes."
cerebro-notify --ask "Quel environnement dois-je déployer ?"
```

La commande est automatiquement disponible dans le `PATH` des sessions
Cerebro ; sans argument, elle lit le texte sur l'entrée standard. Répondez dans
le fil du message Slack pour transmettre la réponse au terminal. Les réponses
`1`, `y` ou `n` sélectionnent directement une option lorsqu'une confirmation
est affichée ; `entrée`/`enter` et `échap`/`esc` envoient respectivement les
touches Entrée et Échap. Les fils restent actifs pendant 24 heures ou jusqu'à
la fin de la session.

Quand Claude pose des questions à choix (outil AskUserQuestion, avec un ou
plusieurs onglets), l'alerte Slack les reprend en entier : chaque question,
ses options numérotées avec leur description et leur aperçu. Répondez dans le
fil par une réponse par question, dans l'ordre (`2`, `1 3`, `1,3` pour un
choix multiple), ou en texte libre. Cerebro ferme alors le dialogue (Échap) et
envoie la réponse, avec le libellé des options choisies, comme message suivant.

Le bouton « Slack » en haut de la barre latérale ouvre les réglages : activer
séparément les alertes de confirmation, les alertes de fin de tour et les
messages des agents (`cerebro-notify`), et régler le délai avant alerte. Ils
sont enregistrés dans `$CEREBRO_DATA_DIR/slack.json` et priment sur
`CEREBRO_SLACK_ALERTS` et `CEREBRO_SLACK_DELAY`, qui ne servent plus que de
valeurs initiales. Si les messages des agents sont désactivés, `cerebro-notify`
échoue avec un message explicite.

Les variables peuvent aussi être placées dans `$CEREBRO_DATA_DIR/env` (par défaut
`~/.cerebro/env`, format `CLE=valeur`, à protéger avec `chmod 600`), chargé au démarrage par le serveur et par Vite en mode dev. Les consignes `cerebro-notify` sont données
aux agents au lancement ou à la reprise d'une session ; le jeton Slack n'est jamais
transmis à leur environnement. Dans le bac à sable `workspace-write` de Codex, le
réseau (y compris local) est coupé : Codex doit demander l'autorisation d'exécuter
`cerebro-notify` hors du bac à sable.

## Détection de l'attente

Cerebro combine plusieurs signaux, car les trois agents ne publient pas les mêmes
événements :

- Claude reçoit des hooks temporaires via son option `--settings` (notifications,
  questions, reprise du travail et fin de tour).
- Grok utilise le hook global idempotent `~/.grok/hooks/cerebro.json`. Celui-ci ne
  fait rien pour les sessions lancées hors de Cerebro.
- Codex utilise son callback `notify` et les notifications terminal OSC 9. Les fils
  auxiliaires, notamment ceux de génération de titre, sont filtrés.
- L'écran du terminal est inspecté pour repérer les dialogues de confiance, menus
  numérotés et confirmations `y/n` que les hooks ne remontent pas. Pour Claude et
  Codex, seules les dernières lignes sous la zone de saisie comptent : un texte du
  transcript (sortie de `cat`, diff, prompt réaffiché) ne passe pas pour un dialogue.
- Après 20 secondes sans sortie, une session encore marquée active devient inactive
  par heuristique. Ce signal de secours ne déclenche pas d'alerte.
- Une session inactive ou terminée depuis plus d'une heure passe « en sommeil ».
  Le bouton « Purger les sessions en sommeil » d'un projet ne supprime que celles-ci.

Les alertes fiables sont dédoublonnées. Une saisie validée par Entrée remet une
session en cours, sans effacer une alerte tant que la session n'a pas été ouverte.

## Réglages des nouvelles sessions

Chaque projet mémorise côté serveur les derniers agent, modèle, effort, mode et
prompt choisis dans le formulaire. Les choix sont enregistrés automatiquement,
même avant de lancer une session, et restent disponibles après un rechargement
ou un redémarrage. Il n'y a pas de choix « défaut » : le modèle et l'effort affichés
sont toujours explicites. Sans réglage enregistré, Cerebro lance le modèle par défaut
de l'agent (celui de sa CLI) et l'effort `high` s'il est proposé, sinon le premier
niveau proposé.

Les nouvelles sessions lancées depuis le web, le backlog ou Slack reprennent ces
réglages. Un prompt fourni explicitement (instruction Slack, tâche du backlog,
sélection du terminal) remplace le prompt mémorisé. Changer d'agent remet le
modèle et l'effort au défaut de cet agent ; un agent choisi explicitement depuis
Slack devient aussi le choix par défaut du projet. Le texte d'une commande Slack
reste propre à la session et ne remplit pas le formulaire « Nouvelle session » :
son prompt vide ou son brouillon sont préservés. Reprendre une ancienne session
conserve ses propres réglages.

## Captures d'écran

Collez une image (Ctrl+V) dans le terminal ou dans le champ de message, ou
joignez-la avec le bouton image. Elle est enregistrée dans
`$CEREBRO_DATA_DIR/attachments/<session>/` et son chemin absolu est inséré dans
le prompt : Claude, Codex et Grok lisent l'image depuis ce chemin. Les images
sont supprimées avec la session (PNG, JPEG, GIF, WebP, 20 Mo maximum).

Lors de la création d’une tâche du backlog, Ctrl+V dans la description joint
également une image, avec une miniature et un bouton de retrait. L’ajout attend
la fin de l’envoi. Ces images sont conservées dans
`$CEREBRO_DATA_DIR/attachments/project-<id>/` ; leur chemin est enregistré dans
la tâche et transmis à l’agent lors de son traitement.

## Sous-tâches d'une session

Chaque conversation dispose d'un suivi persistant de ses sous-objectifs, accessible
depuis la pastille **Sous-tâches** dans son en-tête. Le panneau affiche la liste
complète, les statuts et les notes, et permet de créer, modifier ou supprimer un
élément. Il se rafraîchit toutes les trois secondes. Ce suivi est indépendant du
backlog du projet : il ne lance aucune session et ne clôture aucune tâche du backlog.

Les agents reçoivent la consigne de l'alimenter pour les travaux comportant
plusieurs étapes, de l'actualiser pendant le travail et de le relire après une
reprise ou une compaction et avant leur bilan :

```sh
cerebro-tasks list
cerebro-tasks add "Vérifier les cas limites" --note "Entrée vide et doublons"
cerebro-tasks update <id> --status in_progress
cerebro-tasks update <id> --status done --note "Tests des entrées vides et doublons passés"
cerebro-tasks get <id>
cerebro-tasks list --json
cerebro-tasks delete <id>
```

Statuts : `todo`, `in_progress`, `blocked`, `done`, `cancelled`. Les éléments
terminés restent visibles ; un objectif abandonné peut être marqué `cancelled`
avec sa raison. La suppression sert notamment aux doublons ou erreurs de saisie.
Les données survivent à l'arrêt, la reprise et au redémarrage du serveur, et sont
supprimées avec la session. Aucune fin de tour ni sortie de processus ne change
automatiquement leur statut. Le suivi reflète les mises à jour explicites de
l'agent ou de l'utilisateur.

API agent (en-tête `x-cerebro-token: $CEREBRO_TOKEN`) :
`GET /api/session-tasks/:sessionId`, `POST` sur ce même chemin,
`GET`, `PATCH` et `DELETE /api/session-tasks/:sessionId/:taskId`.
Le jeton ne donne accès qu'au suivi de sa propre session. `POST` reçoit
`{title, status?, note?}` ; `PATCH` reçoit les champs à modifier parmi `title`,
`status`, `note`. Un titre contient 1 à 500 caractères et une note au plus
10 000 caractères. Une note vide l'efface. Les réponses JSON incluent `id`,
`sessionId`, `title`, `status`, `note`, `createdAt`, `updatedAt`.
Les routes de l'interface `/api/sessions/:sessionId/tasks[/:taskId]` utilisent
l'authentification habituelle de Cerebro.

Une session déjà active ne reçoit pas les nouvelles instructions automatiquement.
Après chargement de cette version du serveur, envoyez-lui par exemple :
« Utilise désormais `cerebro-tasks` : lis son aide et la liste existante,
reconstitue les sous-objectifs recensés dans notre échange avec leur statut réel,
puis tiens ce suivi à jour. Conserve aussi les éléments terminés et explicite les
incertitudes ou blocages. » Les variables d'environnement nécessaires sont déjà
présentes dans les sessions Cerebro.

## Backlog

Chaque projet a un backlog de tâches, affiché sur sa page, à confier une par une
à de nouvelles sessions. Typiquement : lancer une code review dans une session,
mettre ses findings dans le backlog, puis les traiter séparément.

- **Depuis le terminal** : sélectionnez du texte dans une session ; une barre
  propose « Nouvelle session » (prompt pré-rempli, agent et mode au choix) et
  « Ajouter au backlog » (texte modifiable avant l'ajout).
- **Depuis l'agent** : demandez-lui de « mettre les findings dans le backlog ».
  Il utilise `cerebro-backlog`, disponible dans le `PATH` des sessions comme
  `cerebro-notify` :

  ```sh
  cerebro-backlog "Une tâche"
  printf 'Tâche 1\ndétails\n---\nTâche 2\n' | cerebro-backlog
  ```

  Sur l'entrée standard, les tâches sont séparées par une ligne `---`. Une
  tâche peut commencer par `after: 1 <id>` pour dépendre d'une tâche
  précédente du même envoi (numéro) ou d'une tâche existante (identifiant).
  La commande affiche les identifiants créés ; `--list`, `--depends` et
  `--delete` (tâches créées par la session) agissent avec le seul jeton de
  session. `cerebro-backlog --help` détaille l'usage.
- **À la main** : en haut du backlog, l'onglet « Avec agent » crée une tâche
  confiée à un agent. L'onglet « Commande » crée une tâche qui lance une
  commande enregistrée pour le projet.

« Traiter » ouvre le formulaire de nouvelle session pré-rempli avec le texte de
la tâche. La tâche passe alors « En cours » et affiche un lien vers sa session.
Marquez-la « Terminée » une fois le travail validé ; les tâches terminées sont
masquées par défaut.

### Epics

Un epic regroupe des tâches liées à un même sujet : elles s'affichent dans un
bloc commun, numérotées dans l'ordre de leurs dépendances, avec l'avancement.
« Traiter l'epic » démarre l'ordonnanceur serveur : il lance une seule étape à la
fois, via son exécuteur LLM ou sa commande configurée. Chaque tâche attend son
critère de clôture explicite avant la suivante. Le lancement est refusé si un
prérequis hors epic n'est pas terminé ou si une exécution traite déjà ses tâches.
Le panneau de suivi permet d'arrêter ou de reprendre l'enchaînement ; une fin de
tour LLM ne marque jamais une tâche terminée.

**Review du travail d'un epic.** Deux boutons de l'en-tête d'un epic :

- **Review de l'epic**, disponible quand l'exécution est terminée, arrêtée ou en
  échec (jamais pendant qu'elle tourne) : lance une session de review qui
  **rejoint le worktree partagé des étapes** et relit tout ce qu'elles ont
  modifié depuis le commit de base (commits, modifications non commitées et
  fichiers non suivis). Le prompt contient la base, les commits et la liste des
  fichiers ; l'agent lit le diff lui-même avec `git diff <base>`, sans rien
  modifier. En mode « Dossier du projet », le périmètre part du HEAD relevé au
  lancement de l'epic et peut inclure des changements d'autres conversations.
  Seule la dernière exécution de l'epic est relue.
- **Ajouter une étape de review** : ajoute à l'epic une dernière tâche
  « Code review du travail de l'epic » qui dépend de toutes les autres. Elle
  s'exécute comme une étape normale, dans le même worktree, et le serveur lui
  ajoute le périmètre au lancement. Ajoutée pendant une exécution, elle bloque
  l'epic jusqu'à « Reprendre » (recalcul), comme toute modification de sa
  composition. Un epic n'en reçoit qu'une à la fois.

Dans les deux cas, l'agent publie ses findings via `cerebro-findings`. Le panneau
des findings propose par défaut **À la suite de l’epic** : les constats
sélectionnés deviennent de nouvelles tâches du même epic, qui attendent les
étapes déjà présentes. Le choix **Nouvel epic** reste disponible avant le
premier import du rapport.

Après une exécution terminée, **Poursuivre l’epic dans son worktree** traite les
nouvelles tâches dans la copie et sur la branche existantes, avec le travail
déjà réalisé. Si l'exécution est encore ouverte, utilisez **Reprendre et
recalculer** ; les corrections attendent notamment la clôture de l'étape de
review. Un worktree retiré ou introuvable empêche la poursuite. Un epic commencé
dans le dossier du projet continue dans ce dossier. Ce choix est conservé même
si le réglage du projet change ensuite, pour le traitement global, les reviews
et le bouton **Traiter** de chaque tâche. Le formulaire rappelle le dossier
d'origine utilisé.

Dans la liste des sessions, les sessions d'un même epic sont regroupées sous son
en-tête. **Supprimer les sessions** (avec délai d'annulation) y supprime toutes
les sessions non protégées du groupe, en arrêtant celles encore ouvertes ; il est
refusé tant que l'epic s'exécute. Leurs copies de travail sans rien à conserver
sont ensuite nettoyées automatiquement.

Un epic se crée avant ou après ses tâches, depuis l'interface (« Nouvel epic »,
puis le sélecteur « Epic » d'une tâche ou du champ d'ajout) ou par l'agent :

```sh
cerebro-backlog --epic-create "Titre" --description "Contexte"   # epic vide
printf 'Tâche 1\n---\nafter: 1\nTâche 2\n' | cerebro-backlog --new-epic "Titre"
cerebro-backlog --epic <epic-id> "Tâche"       # ajout dans un epic existant
cerebro-backlog --epic-add <epic-id> <id>...   # rattacher des tâches existantes
```

Sur l'entrée standard, une ligne d'en-tête `epic: <epic-id>` (ou `epic: none`)
fixe l'epic d'une tâche. `--epics`, `--epic-remove`, `--epic-edit` et
`--epic-delete` complètent la gestion ; supprimer un epic garde ses tâches.

## Modes de permission

| Mode | Claude | Codex | Grok |
|---|---|---|---|
| `auto` | `--permission-mode auto` | `-a on-request -s workspace-write` | `--permission-mode auto` |
| `acceptEdits` | `--permission-mode acceptEdits` | `-a never -s workspace-write` | `--permission-mode acceptEdits` |
| `plan` | `--permission-mode plan` | `-s read-only` | `--permission-mode plan` |
| `bypass` | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--permission-mode bypassPermissions` |

Le mode `default` (configuration de l'agent) n'est plus proposé : une valeur enregistrée
avec ce mode se lit et se lance comme `auto`.

Le mode `bypass` désactive des protections importantes de l'agent. Il ne doit être
utilisé que dans un environnement maîtrisé.

## Plusieurs machines

Un Cerebro peut piloter les sessions d'autres instances, par exemple celle d'un MacBook
resté à la maison. Le serveur local sert de passerelle : il relaie `/m/<id>/api/*` et
`/m/<id>/ws/*` vers l'instance distante en ajoutant le jeton de celle-ci, qui ne quitte
jamais le serveur. Chaque machine garde ses agents, sa base et son intégration Slack.

**Réseau : Tailscale.** Installez [Tailscale](https://tailscale.com) sur chaque machine
avec le même compte, activez MagicDNS, puis sur chaque machine :

```sh
# ~/.cerebro/env (chmod 600) : CEREBRO_BIND_TOKEN=<secret robuste>
tailscale serve --bg 4317
```

Cerebro reste à l'écoute sur `127.0.0.1`, et Tailscale l'expose en HTTPS sur
`https://<machine>.<tailnet>.ts.net`, uniquement pour vos appareils. L'URL est la même
sur le réseau local et à l'extérieur, aucun port n'est ouvert sur la box, et un
téléphone avec Tailscale y accède aussi. Renseignez cette URL dans `CEREBRO_PUBLIC_URL`
pour que les liens Slack fonctionnent partout.

**Déclarer les machines distantes** dans `$CEREBRO_DATA_DIR/remotes.json` (`chmod 600`,
relu à chaque requête, sans redémarrage) :

```json
[
  { "id": "mac", "name": "MacBook", "url": "https://macbook.tailnet.ts.net", "token": "<CEREBRO_BIND_TOKEN du Mac>" }
]
```

L'`id` (`a-z`, `0-9`, `-`) apparaît dans l'URL (`#/m/mac/…`). Des pastilles en haut de
la barre latérale basculent l'interface d'une machine à l'autre. Elles indiquent si
chaque machine est en ligne et combien de sessions attendent une réponse. Les alertes
des machines non affichées déclenchent aussi la notification du navigateur et le bip.
Seules les routes de l'interface sont relayées, d'après une liste blanche (`server/remotes.ts`) : les routes
d'agents (`/api/hook`, `/api/notify`, `/api/backlog`, `/api/session-tasks`), `/api/auth` et `/api/peer/sync`
restent locales, et un chemin contenant un séparateur encodé ou un segment `..` est refusé. Un jeton refusé ou une
machine injoignable renvoie une erreur 502 explicite.

**Slack partagé entre machines.** Si plusieurs machines utilisent le même bot Slack, elles
lisent la même conversation. Pour qu'une commande `projet: …` ne soit pas exécutée deux
fois, les instances échangent toutes les 15 s la liste de leurs projets via
`POST /api/peer/sync`. Il suffit qu'une seule des deux déclare l'autre dans `remotes.json`.
Un projet est commun quand il porte le même nom et le même `origin` git (`git@host:a/b.git`
et `https://host/a/b` sont équivalents) :

- une seule machine traite ses commandes Slack. Quand le projet apparaît sur une deuxième
  machine, la machine dont le projet est le plus récent (créé ou renommé en dernier) prend
  la main automatiquement. Un avertissement s'affiche des deux côtés, et un message Slack
  est envoyé ;
- le switch « Slack » de la vue projet permet de prendre la main à tout moment depuis
  l'autre machine. On ne peut pas rendre la main : il faut la prendre ailleurs. La machine
  qui perd la main ignore les commandes de ce projet et abandonne leurs fils. Elle continue
  d'envoyer ses alertes de session et de suivre leurs fils ;
- si un projet du même nom pointe vers un autre dépôt, ses commandes Slack sont bloquées
  sur les deux machines jusqu'à ce que l'un des projets soit renommé. Une seule machine le
  signale dans le fil.

L'état est conservé dans `$CEREBRO_DATA_DIR/peers.json`, et l'identifiant de l'instance
dans `instance-id`. Le nom affiché pour chaque machine vient de `CEREBRO_MACHINE_NAME`
(par défaut le nom d'hôte). `help` et `list` restent traités par toutes les machines.

**Versions.** Cerebro suit [SemVer](https://semver.org) : la version de `package.json`
(validée au démarrage) s'incrémente en MAJEURE pour tout changement incompatible du contrat
entre instances (échange `/api/peer/sync`, routes relayées par `/m/<id>/…`, formats lus par
l'UI d'une autre machine), en MINEURE pour une fonctionnalité et en CORRECTIVE pour un correctif.
`GET /api/version` la renvoie avec le commit git court (`CEREBRO_COMMIT` le remplace hors dépôt
git), affiché en métadonnée de build (`1.0.0+54dea61`). Elle est transmise dans `/api/peer/sync`.
Même version majeure = compatible (en `0.y.z`, même `0.y`). Le bas de la barre latérale affiche la
version locale, et chaque pastille de machine distante un indicateur : rien (même version),
`≈` (autre version, même majeure), `⚠` (incompatible) ou `v?` (version inconnue :
instance antérieure ou injoignable). Une machine incompatible refuse l'échange (409) : la
coordination Slack avec elle est suspendue, et un bandeau rouge s'affiche quand on la consulte.

**macOS.** [`scripts/cerebro.plist`](scripts/cerebro.plist) est un agent launchd. Adaptez
`WorkingDirectory`, copiez-le dans `~/Library/LaunchAgents/`, puis lancez
`launchctl load ~/Library/LaunchAgents/cerebro.plist`. Il démarre Cerebro sous
`caffeinate -s`, qui empêche la veille sur secteur. Un MacBook capot fermé sans écran
externe se met tout de même en veille et devient injoignable.

## Service systemd utilisateur

Le fichier [`scripts/cerebro.service`](scripts/cerebro.service) est un exemple
d'unité utilisateur. Adaptez impérativement `WorkingDirectory`, puis installez-le :

```sh
mkdir -p ~/.config/systemd/user
cp scripts/cerebro.service ~/.config/systemd/user/cerebro.service
systemctl --user daemon-reload
systemctl --user enable --now cerebro.service
systemctl --user status cerebro.service
```

Après une modification du code, reconstruisez le front avec `npm run build`, puis
utilisez `systemctl --user restart cerebro.service`. Pour conserver les services
utilisateur sans session ouverte, l'administrateur peut activer le linger avec
`loginctl enable-linger "$USER"`.

## Désinstallation

Hors de son dossier de données et de l'éventuelle unité systemd, Cerebro n'écrit
que le hook Grok `~/.grok/hooks/cerebro.json`, réécrit à chaque démarrage du serveur et jamais
retiré automatiquement. Arrêtez d'abord Cerebro (et le service systemd s'il est
installé), puis supprimez ce hook et, si vous ne conservez rien, les données :

```sh
systemctl --user disable --now cerebro.service   # si le service est installé
rm -f ~/.config/systemd/user/cerebro.service
rm -f ~/.grok/hooks/cerebro.json
rm -rf ~/.cerebro                                # $CEREBRO_DATA_DIR : données, logs, worktrees (irréversible)
```

Après suppression des worktrees, `git worktree prune` nettoie leurs références
dans chaque dépôt concerné.

## Limites connues

- Les TUI évoluent : la détection visuelle peut manquer un nouveau dialogue ou
  prendre un texte ressemblant à une question pour une confirmation.
- Un holder tué brutalement ne peut pas préserver son PTY ; la session est marquée
  terminée après les tentatives de reconnexion. La reprise dépend alors de
  l'identifiant de session fourni par l'agent.
- Les notifications OSC de Codex dépendent aussi de sa gestion du focus terminal.
- Cerebro est conçu pour un utilisateur de confiance. Un jeton protège l'accès
  réseau, mais ne remplace pas TLS ni un reverse proxy correctement configuré.
- Les agents tournent sous le même utilisateur que le serveur. Cerebro retire les
  variables `CEREBRO_*` de leur environnement et de celui du holder, mais un agent
  peut lire `$CEREBRO_DATA_DIR/env` ou tout autre fichier de l'utilisateur : seule
  une isolation par utilisateur ou par bac à sable protège réellement ces secrets.

## Dépannage

Vérifiez d'abord que l'exécutable de l'agent est présent avec `which claude`,
`which codex` ou `which grok`. Les sorties brutes des terminaux se trouvent dans
`$CEREBRO_DATA_DIR/logs/` (par défaut `~/.cerebro/logs/`). Le journal
`$CEREBRO_DATA_DIR/hooks.jsonl` contient chaque événement reçu avec son agent, son
type et sa charge utile ; c'est la source principale pour diagnostiquer une attente
non détectée. Il tourne par taille : au-delà de 20 Mo, il est renommé en
`hooks.jsonl.1` (les archives précédentes glissent vers `.2` puis `.3`) et la plus
ancienne est supprimée, soit au plus 80 Mo au total. Avec systemd, consultez aussi les logs avec :

```sh
journalctl --user -u cerebro.service -f
```

Les erreurs propres aux holders se trouvent dans
`$CEREBRO_DATA_DIR/sessions/<id>.holder.log`. Pour repérer des holders devenus
orphelins d'une base supprimée ou déplacée :

```sh
pgrep -af server/holder.ts
```

Après avoir vérifié les identifiants affichés, envoyez `SIGTERM` uniquement aux
PID concernés avec `kill <pid>`. Pour revenir globalement au comportement où
l'arrêt de Cerebro termine toutes les sessions, définissez
`CEREBRO_KILL_ON_EXIT=1` dans l'environnement du serveur.

## Commits automatiques

Un clic sur **Commit / push** collecte les changements, prépare les messages,
crée les commits et les pousse. La fenêtre affiche l'avancement puis les titres,
hashes, exclusions et résultats par remote ; aucun formulaire ou JSON à remplir.
Le bouton **Créer le commit** d'une copie de travail crée les commits sans push.

Les conversations historiques utilisent le dossier partagé du projet. Leur bouton
porte donc le nom **Commit / push du projet**, accompagné de la mention « Dossier
partagé avec les autres conversations » : le clic vise explicitement tous les
changements du projet. Pour une conversation isolée, l'action reste limitée à sa
copie. Le périmètre est annoncé avant lancement et rappelé dans le suivi.

Dans l'en-tête du projet, les boutons **Un seul commit** et **Un commit par intention**
lancent directement la création des commits selon le découpage choisi, sans push.
Le bouton **Push** permet ensuite de les envoyer. Ce choix vaut pour l'opération lancée.
**Réglages LLM** mémorise l'agent, le modèle et l'effort. Ces réglages sont
indépendants de ceux des sessions et du choix du dossier de travail. La migration
initialise les réglages de commits avec l'agent, le modèle et l'effort déjà
enregistrés pour le projet, puis les conserve séparément. Un changement d'agent remet le modèle et l'effort au défaut
pour ne pas transmettre ceux de l'ancien agent. La même fenêtre règle aussi l'agent,
le modèle, l'effort et le mode de la session lancée par **Résoudre avec l'IA**
(par défaut Claude en mode auto).

Le serveur collecte HEAD, les diffs, l'index préexistant et les derniers messages.
Les fichiers suspects, générés, binaires, contenant un secret reconnu ou dont
l'attribution à une session est incertaine sont écartés de l'automatisme et
signalés. Ils ne sont pas envoyés au modèle. Le scanner ne prétend pas détecter
tous les secrets. L'API de commit propre à une session historique refuse de deviner
son périmètre ; la fenêtre permet alors de choisir explicitement l'action sur le
projet entier, sans quitter la conversation.

Un faux positif du scanner (jeton factice dans un test, clé d'exemple) peut être
inclus par une dérogation explicite. Dans les diffs d'une copie de travail, un
fichier « secret détecté » liste les motifs reconnus (ligne, type, extrait masqué)
et propose une case distincte, décochée par défaut et confirmée par une boîte de
dialogue : « Ce n'est pas un secret réel (donnée de test, exemple) : inclure malgré
la détection ». La dérogation vaut pour ce fichier, pour le diff exact affiché et
pour les commits lancés depuis cet affichage : si le fichier change ou si l'examen
expire (une heure), il est de nouveau exclu. Un fichier qui porte aussi un autre avertissement (`.env`,
`credentials`, `id_rsa`…) exige en plus la case « Examiné ». Une fois incluse, la
dérogation transmet ce diff au modèle qui rédige le message et le commit part avec le
push suivant ; elle est rappelée dans la fenêtre du commit et dans le journal des
opérations. Le scanner ne prétend toujours pas détecter tous les secrets : sans
dérogation, rien ne change.

Seule la rédaction et le regroupement des messages demandent une inférence.
L'agent reçoit les diffs éligibles et les conventions du log, sans accès en écriture
au projet. La réponse structurée est vérifiée : chaque fichier doit apparaître
exactement une fois, et aucun fichier inconnu n'est accepté. Cerebro construit et
exécute le plan en code. Sur un dépôt propre, le push est direct, sans inférence.
La préparation est annulable et limitée à deux minutes. Fermer la fenêtre ne
relance ni n'arrête l'opération ; les doubles clics rejoignent l'exécution existante.
Les résultats et identifiants de lancement sont persistés. Après redémarrage,
une opération inachevée est indiquée comme interrompue, sans rejeu automatique.

L'API de plans explicites reste disponible (`prepare-commit`, `commit`) pour
un plan fourni sans inférence : `snapshotId`, `commits:[{message,selection}]`,
`acknowledged`, `overrides` (facultatif, `[{path,snapshotId}]` : dérogation au
scanner de secrets, valable seulement si ce snapshot a montré exactement le diff
actuel du fichier) et `push`. Une sélection vaut `{path,all:true}` ou
`{path,hunks:[identifiants]}`. Un plan expire après une heure ou un redémarrage ;
tout changement de HEAD, de l'index ou du worktree impose une nouvelle collecte.
Une seconde exécution est refusée.

L'exécuteur prépare les arbres dans des index temporaires, vérifie avant mutation
que les changements préexistants dans l'index peuvent être préservés et prend un
verrou sur l'index réel. Un conflit avec un hunk déjà indexé arrête le plan avant le
premier commit. Les hooks et la configuration Git (dont la signature) s'appliquent.
Chaque commit est vérifié (arbre, parent, hash et titre) ; un hook en échec ou une
modification concurrente interrompt l'exécution. Les commits déjà réussis restent
présents et sont affichés ; il n'y a aucun rollback automatique des hooks ou commits.
Les hooks qui modifient eux-mêmes le contenu du commit nécessitent une vérification
manuelle lorsqu'ils changent la sélection prévue. `push:true` utilise le push
serveur et affiche ses résultats par remote, y compris avec des exclusions laissées
dans le worktree. Le push seul, sur un dépôt propre, ne lance aucune session.

## Choisir le dossier de travail par projet

Dans l'en-tête du projet, le réglage **Travail des conversations** permet à chaque projet de choisir entre :

- **Copie isolée par conversation** (défaut) : un worktree et une branche par nouvelle conversation, puis intégration du travail au projet.
- **Dossier du projet** : les nouvelles conversations utilisent le chemin du projet et la branche qui y est déjà sélectionnée, sans créer de worktree, de branche ou de copie des fichiers. Ce mode convient aux tests liés à un chemin précis et au développement séquentiel sur une branche de longue durée.

En mode **Dossier du projet**, Cerebro ne change pas la branche et ne la supprime
pas quand une conversation est supprimée. Plusieurs conversations peuvent
reprendre le même travail dans ce dossier. Commit / push et code review portent
explicitement sur le projet entier ; les changements ne sont pas attribués
individuellement aux conversations.

Le choix est persistant et indépendant des réglages LLM. Il s'applique aux
nouveaux contextes de travail : conversations indépendantes et première étape
d'un nouvel epic. Dès qu'un epic a commencé, son dossier est conservé pour
toutes ses étapes et corrections, même lancées individuellement, ainsi que ses
reviews. Une commande qui commence un epic établit son contexte dans le dossier
du projet. Une conversation existante conserve aussi son dossier lors
d'une reprise, même si le réglage du projet a changé depuis. Les copies isolées
déjà présentes restent accessibles dans l'inventaire. Les anciens projets
conservent l'isolation à la migration tant que ce choix n'est pas modifié.

Si un ancien epic a utilisé plusieurs dossiers, sa reprise reste bloquée jusqu’au
choix explicite d’un dossier dans sa fiche. Cerebro présente les branches, les
fichiers modifiés et les sessions de chaque copie. Le choix conserve ce dossier
pour les prochaines étapes ; il ne fusionne aucun fichier, ne valide aucune tâche
et ne relance pas l’epic. Vérifiez les copies, choisissez le dossier, puis utilisez
« Reprendre et recalculer ». Une étape interrompue dans une autre copie est
relancée dans le dossier choisi.

## Provenance des sessions

En mode isolé, une nouvelle session sur un dépôt Git avec un commit démarre dans un worktree
et une branche `cerebro/session-<id>` dédiés, sous le dossier de données Cerebro.
Git crée et peuple ce worktree. Cerebro y restaure ensuite l'index capturé et ne
reporte que les fichiers modifiés ou non suivis du projet source ; il ne recopie
plus l'ensemble des fichiers déjà restaurés par Git. Les fichiers ignorés
ordinaires utiles à la configuration locale restent disponibles ; les autres
répertoires ignorés (sorties générées, caches) sont omis. Les gros répertoires de dépendances
`node_modules`, `.venv`, `venv` et `vendor` sont liés au répertoire source au lieu
d'être copiés et ne participent ni aux empreintes ni à l'inventaire des changements.
Ils sont donc partagés et non isolés en écriture : une installation ou une mise à
jour de dépendances depuis la session modifie aussi ceux du projet source.
Le graphe de connaissances du code `graphify-out/` (Graphify), s'il existe à la
racine du projet, est au contraire copié, sans son marqueur `.graphify_root` qui
désigne le projet source : la session interroge le graphe et le met à jour dans
sa copie (`graphify update .`) sans toucher à celui du projet.
Aucun changement du worktree ou de l'index source n'est appliqué. Une modification
du projet pendant la préparation annule le lancement. Les sous-modules, conflits
d'index et fichiers spéciaux ne sont pas isolés : le lancement est refusé
explicitement, sans démarrer l'agent. Le dossier de données doit être hors du dépôt.

La provenance est enregistrée en base avant le lancement du terminal : chemin,
branche, HEAD de base, empreintes initiales et fichiers initialement modifiés.
La reprise retrouve cet espace après redémarrage. Dans l'en-tête de la session, une
pastille indique l'espace utilisé (`copie isolée`, `dossier partagé` ou
`provenance inconnue`) ; un clic ouvre le détail : chemin, changements et commits
du premier parent de sa branche. Les fichiers déjà modifiés au départ nécessitent une sélection manuelle ;
ils ne sont jamais attribués automatiquement. Un changement de branche ou une base
réécrite rend le périmètre incertain ; les merges sont également signalés incertains.

L'isolation sépare les éditions de deux sessions, même sur le même fichier, et
les éditions humaines faites dans le projet source. Elle établit un **périmètre
d'espace de travail**, pas l'identité de l'auteur. Un humain ou un outil qui édite
directement cet espace fait partie de ce périmètre et ses changements doivent être
vérifiés explicitement. Les liens symboliques restent des liens ; leurs cibles
externes et les chemins absolus utilisés par un agent ne sont pas isolés. Ce
mécanisme n'est pas un sandbox. Les changements de la session n'apparaissent pas
automatiquement dans le projet source : leur intégration par merge/cherry-pick
reste une décision explicite. Les worktrees et branches sont conservés même après
suppression de la session pour ne jamais supprimer du travail non intégré.

Les sessions historiques continuent dans leur répertoire d'origine, ainsi que les
projets sans Git ou sans commit initial. Leur provenance reste **inconnue** :
Cerebro ne reconstruit pas un propriétaire à partir du diff global. Les opérations
sur ces sessions exigent une sélection explicite.

Les actions Git d'une session utilisent cette provenance. Le commit automatique
écarte les fichiers initiaux ou incertains ; l'API de plans explicites exige une
sélection manuelle avec confirmation dans `acknowledged` pour les inclure.
Les sessions historiques suivent la même règle pour tous leurs changements.
Les commits passent par l'exécuteur serveur, même
si la session est arrêtée. La review démarre une session de raisonnement avec les
diffs sélectionnés et les hashes des commits attribués retenus ; elle ne demande
plus à l'agent de reconstruire le périmètre. Une sélection obsolète est refusée.

Le périmètre des reviews de dépôt est également préparé par le serveur :
changements non commités (index, worktree et fichiers non suivis), sinon commits
en avance sur l'upstream capturé, sinon dernier commit sans upstream. Un dépôt
vide ou aligné sans changement affiche un périmètre vide et ne lance pas d'agent.
Les références, chemins, commits et diffs sont affichés avant lancement. HEAD,
branche, index, worktree et upstream sont revérifiés avant le démarrage du terminal.
Les trois agents reçoivent le même contexte ; une commande personnalisée comme
`/code-review` peut être saisie dans les instructions, avec ce périmètre ajouté
par le serveur. La collecte ne lance aucun modèle. Le raisonnement sur les bugs et
la lecture du code environnant restent confiés à l'agent.

## Findings structurés

Pendant une review, l'agent peut envoyer sur l'entrée standard de
`cerebro-findings` un JSON `{title, findings:[{id,title,severity,file,line,problem,
scenario,expectedFix,dependsOn:[],taskDependencies:[]}]}`. `severity` vaut
`critical`, `high`, `medium` ou `low` ; `dependsOn` référence des findings du même
rapport et `taskDependencies` des tâches existantes du projet. Le rapport peut
également être collé dans le panneau des findings d'une session, ouvert par la
bandeau **N finding(s) de review disponible(s)** au-dessus du terminal, via
**Examiner les findings**. Ce bandeau apparaît dès le premier rapport reçu.
Chaque finding présente sa gravité, son emplacement, le problème, le scénario
et le correctif attendu dans une carte distincte.

Dans les listes de sessions, un lien orange **N findings de review à traiter**
ouvre directement ce panneau. Le total figure aussi dans l'en-tête de l'epic,
même replié, et la review reste dans **À traiter**, y compris après l'arrêt de
sa session. La simple consultation ne supprime pas ce signal : chaque import
réduit le compteur et tous les indicateurs de findings disparaissent quand
tous les rapports de la session sont exploités. Les reviews concernées sont
exclues de la purge des sessions en sommeil tant qu'il reste des findings.
La publication d'un nouveau rapport déclenche également une notification de
bureau selon vos préférences ; un rapport renvoyé à l'identique ne la répète pas.

Sélectionnez les findings, choisissez leur destination, puis cliquez **Ajouter
la sélection à cet epic** ou **Enregistrer la sélection dans un nouvel epic**.
Le sélecteur de destination et le bouton d'import sont regroupés au pied du
rapport, côte à côte sur grand écran et l'un sous l'autre sur petit écran.
Pour une session liée à un epic, la destination proposée est la suite de cet
epic ; sinon, un nouvel epic est créé. La destination est conservée après le
premier import, y compris pour les sélections partielles suivantes.
Les tâches créées incluent le contexte autonome et la session source ; les
prérequis doivent aussi être sélectionnés ou déjà importés. Le rapport est limité
à 100 findings et 1 Mio. Les contenus incomplets/invalides restent dans le flux
habituel de discussion, sans import automatique. Un même rapport et les mêmes
findings ne créent aucune tâche en double, y compris après redémarrage. Cet import
ne lance ni agent ni nouveau tour de raisonnement.

## Tâches de commande sans agent

L'onglet **Commande** du backlog crée une tâche sans agent. Configurez
explicitement un JSON `{name, executable, args:[], cwd:".", timeoutSeconds:300}`,
puis sélectionnez cette commande pour créer une tâche. Sans commande
enregistrée, le formulaire JSON est ouvert. `cwd` est relatif et doit
rester dans le projet, y compris après résolution des liens symboliques. Les
arguments sont transmis tels quels ; aucun texte de tâche n'est converti en shell.
L'API accepte `execution:{type:"command",commandId,completion:"manual"}` ; les
anciennes tâches et les machines anciennes gardent `execution:{type:"llm"}`.

Le lancement crée une opération avec logs (dernier Mio), répertoire effectif,
durée et code de sortie. Le bouton d'arrêt et la limite de durée arrêtent le
groupe de processus. Un double lancement ou une dépendance inachevée est refusé.
Une commande réussie laisse la tâche **à valider** ; la clôture reste explicite.
Les opérations en cours lors d'un redémarrage sont marquées interrompues (résultat
inconnu), jamais relancées automatiquement. Sur Linux, le groupe encore identifié
par son identifiant d'opération est arrêté. Aucune session d'agent n'est créée.

## Ordonnancement des epics

Le serveur persiste chaque exécution d'epic et calcule l'ordre des dépendances.
Seule l'étape courante passe **en cours** ; les suivantes restent **à faire**.
Un agent reçoit une seule tâche et conserve `cerebro-backlog --done <id>` pour sa
clôture déclarée. Il peut signaler explicitement `--fail`, `--block` ou
`--await-validation <id> "raison"`. Une fin de tour, une session idle ou une sortie
ne clôt jamais une tâche. Un `--done` reçu pendant un tour attend aussi la fin du
tour avant l'enchaînement, pour éviter de lancer une vérification sur des éditions
encore en cours.

Une commande utilise par défaut `completion:"manual"` : son succès attend la
validation de la tâche. Dans un epic, `completion:"exit-zero"` est un critère
explicite d'avancement dès un code nul ; le résultat indique ce critère plutôt
qu'une validation métier. L'interface permet ce choix à la création. Après une
étape LLM réussie, les étapes suivantes héritent de son espace isolé (copié pour
une autre session LLM, utilisé directement pour une commande), afin de retrouver
les changements précédents sans les intégrer silencieusement au dépôt source.

Un échec arrête l'enchaînement, y compris vers les branches indépendantes. Les
questions et validations restent visibles. Le panneau d'ordonnancement propose
arrêt et reprise avec recalcul explicite. Une mutation du contenu, des dépendances
ou de la composition de l'epic bloque la progression jusqu'à ce recalcul. Les
prérequis hors epic doivent être terminés. Les lancements concurrents et les
lancements individuels de tâches réservées sont refusés. Après redémarrage, le
serveur retrouve l'étape enregistrée ; un résultat de commande inconnu devient un
échec interrompu et un tour LLM inachevé attend son résultat explicite. Aucun
lancement dont l'issue est incertaine n'est rejoué automatiquement.

## Notifications factuelles

Les résultats structurés des pushes, commits, commandes, exécutions d'epic et
councils produisent leurs notifications en code, avec durée et statut effectif.
Un council lancé depuis le web hors projet est notifié par la machine qui l'exécute,
même si une autre machine traite les commandes générales Slack. Un council lancé
depuis Slack répond dans son fil, sans notification séparée. Un résultat est marqué
notifié uniquement après confirmation de l'envoi par Slack ; un envoi en erreur
(429, réseau, délai dépassé) est retenté après 30 s, 2 min puis 10 min tant que le
résultat n'est ni vu ni notifié et date de moins de 24 h, puis au prochain
redémarrage dans cette même fenêtre. Le succès
d'une commande ou la fin d'un tour n'attestent pas la validation du travail.
Les préférences existantes s'appliquent : résultats réussis via **idle**, échecs ou
blocages via **waiting**, délai configurable et choix de la machine répondante.
Les résultats vus dans leur panneau avant l'envoi annulent l'alerte ; leur
identifiant et leur notification sont persistés pour éviter les doubles envois.
Un résultat provenant d'une session rejoint son fil existant, sans remplacer une
question restée sans réponse.

Les alertes de fin de tour incluent la durée enregistrée. Un résultat déjà relayé
sur Slack ou un message personnalisé de l'agent supprime l'alerte factuelle
redondante. Une nouvelle question reste notifiable. Les consignes des agents
réservent désormais `cerebro-notify` au contexte supplémentaire et aux questions
bloquantes, dont la formulation reste du ressort de l'agent. Aucun modèle n'est
appelé pour produire ces notifications.

Le protocole entre machines passe à **2**, car le lancement d'epic renvoie une
exécution serveur au lieu d'une session unique. Mettez à jour les instances
ensemble avant de reprendre les opérations entre machines ; les anciennes données
et sessions sont migrées/conservées, mais une instance au protocole 1 n'est pas
relayée comme si elle supportait l'ordonnanceur.

## Inventaire et cycle de vie des worktrees

Le panneau **Copies de travail** figure dans chaque projet et sur l'accueil de la machine
sélectionnée. Il recense les worktrees Git, y compris les worktrees externes
(affichés en lecture seule), les conversations supprimées et les projets retirés.
Le registre conserve le chemin, le dépôt, le nom du projet, la conversation et la
branche cible indépendamment des enregistrements de session et de projet. Les
anciennes données de provenance sont reprises dans cet inventaire.

Les copies des conversations sont présentées par leur titre ou, si ce titre a
disparu, leur date de création. Les fichiers sont comparés aux empreintes du
contenu copié au départ : une copie de départ inchangée n'est pas présentée comme
du nouveau travail à intégrer. Ce compteur décrit des changements depuis la
création, sans en déduire l'auteur. Un fichier déjà modifié au départ qui a encore
changé est signalé comme nécessitant un examen.

Chaque copie suit un parcours en quatre étapes, affiché avec « Étapes ». La
prochaine action est aussi proposée directement sur la ligne de la copie.

1. **Enregistrer le travail dans la copie.** Une copie reçoit, à sa création, les
   fichiers alors non commités du dossier du projet : c'est le *contenu de départ*,
   qui n'est pas le travail de la conversation. Le panneau le montre par groupe
   (fichiers inchangés depuis la création, fichiers modifiés depuis) et indique où
   ce contenu se trouve encore : déjà commité dans la cible, toujours dans le dossier
   du projet, conservé par Cerebro à la création, ou seulement dans la copie.
   **Retirer le contenu de départ** affiche d'abord, fichier par fichier, ce qui sera
   fait : remise à l'état de la copie, ou conservation du seul travail fait depuis la
   création (avec son diff). Si la cible a avancé sans conflit, la copie reçoit
   d'abord ses commits, pour que ce travail s'applique à la version à jour. Les
   fichiers qui ne peuvent pas être séparés restent à examiner dans les diffs, ou
   peuvent être confiés à **Résoudre avec l'IA** : une session, lancée dans la copie
   avec les réglages de résolution du projet (**Réglages LLM**), reçoit pour chacun
   où lire son contenu de départ et le constat de Cerebro, et réécrit le fichier pour
   ne garder que la version de la copie plus le travail de la conversation. Elle ne
   touche pas aux autres fichiers et ne commite rien : relisez ses changements, puis
   rouvrez **Retirer le contenu de départ**. Un fichier dont le contenu de départ a
   disparu de ses changements non commités (retiré par la conversation ou par cette
   session) y est reconnu automatiquement ; les autres se valident en cochant leur
   diff une fois vérifié. Ces fichiers sont alors rattachés tels quels au travail
   de la conversation.
   **Créer le commit** enregistre ensuite le travail de la conversation.
2. **Régler les conflits avec la cible.** Cerebro prévoit les fichiers que
   l'intégration laisserait en conflit. **Mettre à jour avec master** merge la cible
   dans la copie : les conflits se résolvent dans la copie (soi-même, en le
   demandant à la conversation ou avec **Résoudre avec l'IA**), puis **Terminer la
   mise à jour** crée le commit de merge. Ces commits passent par les hooks et la
   configuration Git comme les autres ; un hook qui refuse laisse la mise à jour en
   cours dans la copie, à terminer une fois la cause corrigée. **Annuler la mise à
   jour** remet la copie dans son état précédent.
   **Résoudre avec l'IA** lance une session dans la copie, avec les réglages de
   résolution du projet (**Réglages LLM**), sans ouvrir son terminal. Elle reçoit les
   fichiers en conflit (ce que chaque côté en a fait et les commits qui les ont
   touchés), les commits de la copie et ceux de la cible depuis leur base commune,
   et l'intention du travail : la demande initiale de la conversation d'origine et,
   si cette conversation traitait une tâche d'epic, le texte de cette tâche. Elle
   réécrit les fichiers pour garder les deux intentions et retire les marqueurs ;
   face à un choix qui vous revient, elle pose la question plutôt que de deviner.
   Elle ne fait jamais de `git add`, de commit ni d'abandon du merge, et ne modifie
   pas le dossier du projet. Pendant la mise à jour, chaque fichier est marqué
   « résolu » ou « marqueurs restants » (un fichier déjà indexé avec des marqueurs
   compte aussi), et la session liée est affichée avec son état : au travail, en
   attente d'une réponse, ou ayant fini son tour avec ou sans marqueurs restants.
   Une seule session de résolution vit par mise à jour ; une fois sortie, une autre
   peut prendre le relais. **Terminer la mise à jour** reste votre geste : relisez
   ses changements, puis terminez dès que la session a fini son tour et qu'aucun
   marqueur ne subsiste. Terminer ou annuler la mise à jour détache la session, qui
   reste une conversation ordinaire.
3. **Intégrer** : le bouton reste visible, désactivé tant qu'un blocage subsiste, et
   la liste des blocages dit quoi faire. Tant que Cerebro prévoit des conflits avec
   la cible, l'intégration est bloquée : mettez d'abord la copie à jour (étape 2),
   pour que les conflits se règlent dans la copie et jamais dans le dossier du
   projet. Une prévision encore en cours de calcul ne bloque pas.
4. **Publier** : l'intégration reste locale ; **Push** dans l'en-tête du projet
   envoie le travail vers les remotes.

Le dossier principal et les copies sans métadonnées figurent dans une section
repliée distincte. Le dossier principal n'a pas à être intégré dans lui-même. Les
fichiers ignorés (dépendances, configuration, etc.) apparaissent dans les détails
du retrait, sans gonfler les compteurs du travail à intégrer. « Examiner » permet
de lire les diffs sans lancer d'agent.

Le nombre de commits à intégrer est calculé par rapport à la **branche cible
explicite**. Cette cible est mémorisée ; un changement de branche dans le projet
ne la remplace pas silencieusement. Les références sont relues à chaque
actualisation et avant une action. Un état indisponible est indiqué comme inconnu
et bloque les mutations.

**Intégrer dans master** (ou la branche cible choisie) prépare une confirmation avec les références source/cible et le chemin
exact du worktree cible. La cible doit être une branche ouverte dans un autre
worktree, son index et ses fichiers doivent être propres, les agents qui
l'utilisent doivent avoir fini leur tour et aucun conflit ne doit être prévu. Aucun commit implicite, push, squash,
reset ou contournement de hook n'est effectué. Les hooks et la configuration Git
s'appliquent. Les entrées d'une conversation inactive sont mises en attente
pendant le merge puis transmises après son résultat. En cas de conflit ou d'échec
de hook, les deux branches restent conservées et les fichiers éventuels du merge
restent à résoudre dans le chemin cible indiqué ; Cerebro ne les réinitialise pas.
Le résultat et les références demandées sont persistés, sans rejeu automatique
après une interruption du serveur.

Le merge conserve le worktree et la conversation. Celle-ci reprend au même
endroit sur sa branche. Après de nouvelles éditions, le compteur de fichiers
modifiés remonte ; après un nouveau commit, le compteur de commits à intégrer
remonte. Plusieurs merges successifs sont possibles. Il n'existe aucun indicateur
permanent « déjà mergé » qui autoriserait ensuite un nettoyage aveugle. Un squash
ou cherry-pick manuel ne vaut pas une preuve d'intégration par ascendance : le
compteur de commits peut rester non nul et la suppression reste bloquée.

**Supprimer une conversation** ou **retirer un projet** ne retire aucun worktree.
Le travail reste consultable sur l'accueil, sous son dernier nom de projet et de
conversation. Les worktrees sans conversation permettent encore de préparer et
d'exécuter des plans de commits Git explicites, puis de merger dans la cible.

**Retirer la copie** est une action distincte, proposée directement sur la ligne
d'une copie dont le travail est intégré. Elle exige un espace propre,
une intégration vérifiée des commits, aucune session encore ouverte, aucune
commande/aucun epic actif qui utilise ce répertoire. Les entrées ignorées par Git
sans rien à perdre sont supprimées avec la copie :

- un lien vers le même chemin du projet source, ou un fichier identique à ce
  chemin dans le projet (par exemple `.claude/settings.local.json`) ;
- un dossier situé **à la racine** de la copie et nommé `node_modules`, `.venv`,
  `venv`, `vendor`, `dist`, `build`, `.vite`, `.next`, `coverage`, `__pycache__`,
  `.cache` ou `graphify-out` : une installation, une compilation ou Graphify le recrée ;
- un chemin déclaré régénérable par le projet (champ « Chemins régénérables des
  copies de travail » du formulaire **Éditer**, un chemin relatif par ligne, par
  exemple `web/dist`) ;
- un dossier dont tout le contenu relève des cas précédents.

Un dossier des noms ci-dessus placé plus bas, comme `data/build/` ou
`packages/app/dist/`, n'est pas présumé régénérable : il faut le déclarer.
Tout autre fichier ignoré bloque le nettoyage automatique. Le retrait manuel le
liste dans sa confirmation : il n'est supprimé qu'une fois la case « Supprimer
définitivement ces fichiers ignorés » cochée, et chaque entrée peut y être déclarée
régénérable pour les copies suivantes. Déclarer un chemin relance le nettoyage
automatique des copies du projet. Cerebro n'efface jamais un fichier ignoré
non déclaré sans cette confirmation ; un fichier ignoré apparu depuis la
préparation annule le retrait.
Les worktrees principal, externes, verrouillés ou dont l'identité a
changé restent protégés. Une confirmation devient invalide si Git a changé entre
sa préparation et son exécution. La suppression passe par Git sans `--force` et
conserve la branche, les commits et la conversation. La conversation reste lisible,
mais sa reprise est refusée lorsque son worktree a été supprimé.

## Council

Le council soumet une question ou une décision à plusieurs conseillers LLM, puis
fait synthétiser leurs avis. Chaque conseiller associe une **persona** (un angle de
réflexion) à un **agent** (`claude`, `codex` ou `grok`), avec son modèle et son
effort : le même angle peut être joué par des modèles différents, et un même modèle
peut tenir plusieurs angles. Un council réunit de 2 à 8 conseillers et se déroule en
trois phases, sans session interactive :

1. **Réponses** : chaque conseiller répond indépendamment et en parallèle, en
   assumant son angle (150 à 300 mots demandés).
2. **Relecture croisée anonymisée** : chaque conseiller ayant répondu relit les
   réponses des autres, désignées par une lettre tirée au hasard pour chaque
   council (ni l'ordre de lancement ni la persona ne se devinent), jamais la
   sienne. Il les classe toutes de la meilleure à la moins bonne avec une raison
   courte, signale l'angle mort le plus important et ce que toutes ont manqué.
   Les rangs sont agrégés en rang moyen.
3. **Synthèse du chairman** : un agent désigné reçoit les réponses avec leurs
   auteurs révélés, les relectures et le classement agrégé, qu'il traite comme un
   signal et non comme un vote. Il rédige les points d'accord, les désaccords, les
   angles morts, sa recommandation et la première action à mener.

Un council de N conseillers coûte **2N + 1 appels LLM** (N réponses, au plus N
relectures, une synthèse) ; le formulaire affiche ce nombre avant le lancement.
Chaque appel est borné : 10 minutes pour une réponse, 5 pour une relecture, 10 pour
la synthèse. Les réponses, relectures et la synthèse sont conservées avec le run.

### Personas

Les personas forment un catalogue propre à la machine : nom, description brève
(300 caractères au plus) et prompt (4 000 caractères au plus). Cinq personas sont
fournies à la première ouverture de la base : **Contrarien** (cherche la faille
fatale), **Premiers principes** (repart du vrai problème), **Expansionniste**
(potentiel inexploité, effet de levier), **Outsider** (regard naïf d'un nouveau
venu) et **Exécutant** (plan concret, premier résultat vérifiable). Elles portent
le badge « fournie » mais se modifient et se suppriment comme les autres ; une
persona fournie supprimée n'est jamais réinsérée.

**Gérer les personas** (dans les réglages du council) ou **Nouvelle persona** (dans le
formulaire de lancement) ouvre le catalogue : créer, modifier, supprimer. Le
catalogue garde au moins deux personas. Supprimer une persona la retire des
réglages globaux et des réglages des projets ; les rapports existants conservent
la copie de la persona figée au lancement.

### Réglages globaux et surcharge par projet

Les **Réglages** du council indiquent, pour chaque persona, l'agent, le modèle et
l'effort qui la jouent par défaut, les personas cochées par défaut au lancement
(de 2 à 8), le chairman et la valeur par défaut de « Lire le projet ». Ouverts
depuis l'accueil, ils s'appliquent à toute la machine : councils hors projet,
commandes Slack et projets sans réglages propres. Ouverts depuis un projet, ils
créent une surcharge propre à ce projet ; **Revenir aux réglages globaux** la
supprime. Tant qu'aucun réglage n'est enregistré, toutes les personas sont cochées,
réparties en tourniquet sur les agents disponibles, avec `claude` comme chairman
et la lecture du projet activée.

### Lancer un council

- **Depuis un projet** : bouton **Council** de l'en-tête du projet.
- **Depuis l'accueil** : carte **Council**, pour une question hors projet.
- **Depuis Slack** : `council: question` (hors projet) ou
  `projet/council: question` (voir ci-dessous).

Le formulaire demande la question, un contexte facultatif (contraintes, options
envisagées…) et les participants : les personas cochées par défaut sont
proposées, et l'agent, le modèle et l'effort de chacune peuvent être changés pour
ce lancement seulement, sans modifier les réglages. **Convoquer** lance le council
et ouvre son rapport ; la liste des councils précédents du projet (ou de l'accueil)
figure sous le formulaire, avec suppression des runs terminés.

Une image collée (Ctrl+V) ou déposée dans la question ou le contexte est envoyée
aussitôt et désignée dans le texte par `[Image #n]` ; une miniature retirable
apparaît sous les champs, et effacer le jeton retire l'image. Au plus dix images
(PNG, JPEG, GIF, WebP, 20 Mo chacune), conservées dans
`$CEREBRO_DATA_DIR/attachments/project-<id>/` (projet) ou `attachments/council/`
(hors projet) et supprimées avec le council. Elles sont jointes au message de
chaque appel, réponses, relectures et synthèse comprises, sans outil : Claude les
reçoit dans son message (entrée `stream-json`), Codex par `--image`. Grok ne
prend pas en charge les images : le lancement est refusé tant qu'un participant
coché ou le chairman l'utilise. Le rapport affiche les images jointes et l'export
Markdown les liste ; la suite **Ouvrir une session** les reprend dans le prompt.

Depuis un projet, la case **Laisser les conseillers lire le projet** (valeur par
défaut issue des réglages) donne aux conseillers, pendant la phase de réponse
seulement, un accès en lecture seule au dossier du projet ; ils sont invités à
citer les fichiers sur lesquels ils s'appuient. Les relectures et la synthèse
portent uniquement sur les réponses. Hors projet, et pour les relectures et la
synthèse, aucun outil ni fichier n'est accessible : l'agent travaille dans un
dossier temporaire vide. Les options passées aux CLI :

| Agent | Sans outils | Lecture seule du dépôt |
|---|---|---|
| `claude` | `--print --tools ""` | `--print --tools Read,Glob,Grep --max-turns 30` |
| `codex` | `exec --sandbox read-only --disable shell_tool` | `exec --sandbox read-only` (shell conservé pour `cat`/`rg`, écriture interdite par le bac à sable) |
| `grok` | `--tools "" --deny '*' --max-turns 2` | `--tools Read,Glob,Grep --allow Read --allow Glob --allow Grep --max-turns 30` |

Dans tous les cas : sortie JSON validée par un schéma, aucun serveur MCP
(`--strict-mcp-config` pour Claude ; pour Codex, `--ignore-user-config --ignore-rules` :
ni serveurs MCP, ni plugins, ni règles, ni approbation des projets, donc jamais le
`.codex/config.toml` d'un projet ; seuls le modèle, l'effort par défaut et les réglages
d'authentification de `~/.codex/config.toml` sont repris), pas de recherche web ni de sous-agents pour Codex et Grok,
`--permission-mode dontAsk` pour Claude et Grok, `approval_policy="never"` pour
Codex. Les variables `CEREBRO_*` ne sont pas transmises. Le contenu des fichiers,
du contexte et des réponses citées est présenté aux agents comme une donnée, jamais
comme une instruction.

### Rapport et suites

Le rapport s'ouvre sur `#/c/<id>`. Pendant l'exécution, il montre la phase en cours
et l'état de chaque conseiller ; **Annuler** arrête le council et **Continuer en
arrière-plan** quitte la page sans l'interrompre. Le résultat est ensuite notifié
comme les autres opérations (voir [Notifications factuelles](#notifications-factuelles)),
avec un lien vers le rapport. Le rapport présente la synthèse, l'avis de chaque
conseiller (lettre, persona, agent), les relectures croisées et le classement
agrégé.

Le panneau **Suites** propose, quand une synthèse existe :

- **Ajouter au backlog** : une tâche préremplie avec la recommandation, la
  première action et le lien du rapport, modifiable avant ajout ;
- **Ouvrir une session** : la synthèse devient le prompt du formulaire « Nouvelle
  session » du projet (à la suite d'un éventuel brouillon), où l'agent se choisit
  avant de lancer ;
- **Exporter en Markdown** (toujours disponible) : question, contexte, synthèse,
  avis, relectures et classement agrégé dans un fichier `council-<id>.md`.

Pour un council hors projet, les deux premières suites demandent le projet cible.

### Échecs et limites

- Un conseiller en échec (délai, sortie invalide) n'arrête pas le council ; il en
  faut au moins deux réponses pour la relecture croisée, sinon le council échoue.
  Une relecture invalide (lettre manquante, en double ou inconnue) est écartée du
  classement. Un échec de la synthèse fait échouer le council, en conservant les
  réponses et relectures obtenues.
- Les tokens consommés par les appels headless du council n'apparaissent pas dans
  les [statistiques d'usage](#statistiques-dutilisation-des-llm).
- Un council en cours lors d'un arrêt ou d'un redémarrage du serveur est marqué
  interrompu, avec les avis déjà obtenus ; il n'est jamais rejoué automatiquement.
- Supprimer un projet supprime ses councils.
