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

## Configuration

| Variable | Valeur par défaut | Rôle |
|---|---:|---|
| `CEREBRO_HOST` | `127.0.0.1` | Adresse d'écoute du serveur. |
| `CEREBRO_PORT` | `4317` | Port HTTP et WebSocket. |
| `CEREBRO_DATA_DIR` | `~/.cerebro` | Base SQLite, sockets des holders, journaux de terminal et `hooks.jsonl`. |
| `CEREBRO_BIND_TOKEN` | non défini | Protège les API et WebSockets lorsqu'un accès réseau est nécessaire. |
| `CEREBRO_KILL_ON_EXIT` | non défini | Avec la valeur `1`, tue les agents lorsque le serveur s'arrête (ancien comportement). |
| `CEREBRO_SLACK_TOKEN` | non défini | Jeton bot Slack `xoxb-…`. Sans ce jeton, l'intégration Slack est inactive. |
| `CEREBRO_SLACK_USER` | non défini | ID Slack (`U…`) du destinataire des messages privés. |
| `CEREBRO_SLACK_ALERTS` | `all` | Alertes automatiques par défaut : `all`, `waiting` (questions et confirmations seulement) ou `off`. Modifiable ensuite dans l'interface. |
| `CEREBRO_SLACK_DELAY` | `30` | Délai par défaut en secondes avant une alerte automatique. Modifiable ensuite dans l'interface. |
| `CEREBRO_MACHINE_NAME` | nom d'hôte | Nom de la machine dans le sélecteur multi-machines. |
| `CEREBRO_PUBLIC_URL` | `http://${CEREBRO_HOST}:${CEREBRO_PORT}` | Base des liens « Ouvrir dans Cerebro » envoyés sur Slack. |

Pour une écoute sur le réseau local, définissez un secret robuste en même temps que
`CEREBRO_HOST=0.0.0.0`. Saisissez le secret dans l'écran « Token requis » (ou ouvrez
`http://hote:4317/?token=SECRET`) : Cerebro l'enregistre pour un an dans un cookie
`httpOnly`, `SameSite=Strict` (et `Secure` derrière HTTPS). L'écran passe par
`POST /api/auth`, ce qui fonctionne aussi derrière le serveur de dev Vite. Les clients API
peuvent aussi utiliser `?token=SECRET` ou l'en-tête
`Authorization: Bearer SECRET`. Les hooks d'agents conservent leur jeton propre.

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

Écrivez `? question` pour interroger Cerebro en langage libre, par exemple
`? où en sont les tâches du projet ACME ?`. Claude (CLI `claude` locale, via le SDK)
répond dans le fil à partir de l'état des projets, sessions, epics et tâches de la
machine et des machines déclarées dans `remotes.json` ; il peut aussi lire (sans
rien modifier) les fichiers des projets locaux. Un sablier marque la question
pendant la recherche.

Si plusieurs machines lisent le même message privé, une seule traite les
commandes sans projet : `help`, `list`, `? question`, messages non reconnus et
projets introuvables. Par défaut, Cerebro la choisit automatiquement parmi les
machines actives. Pour imposer la machine, cochez « Commandes générales » dans
le panneau Slack de la barre latérale de cette machine. Le choix est partagé
avec les autres machines ; pour le changer, cochez la case sur une autre machine.
`list` montre aussi les projets présents seulement sur les autres machines.

Cerebro envoie alors un message privé après le délai configuré lorsqu'une
session demande une confirmation ou termine son tour. L'alerte est annulée si
la session est vue, repart ou se termine entre-temps. Un agent peut aussi
prévenir explicitement l'utilisateur :

```sh
cerebro-notify "Traitement terminé, le rapport est prêt."
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
  numérotés et confirmations `y/n` que les hooks ne remontent pas.
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
ou un redémarrage. Le choix « défaut » remet le modèle ou l'effort à celui de la
configuration de la CLI.

Les nouvelles sessions lancées depuis le web, le backlog ou Slack reprennent ces
réglages. Un prompt fourni explicitement (instruction Slack, tâche du backlog,
sélection du terminal) remplace le prompt mémorisé. Changer d'agent remet le
modèle et l'effort au défaut de cet agent ; un agent choisi explicitement depuis
Slack devient aussi le choix par défaut du projet. Reprendre une ancienne session
conserve ses propres réglages.

## Captures d'écran

Collez une image (Ctrl+V) dans le terminal ou dans le champ de message, ou
joignez-la avec le bouton image. Elle est enregistrée dans
`$CEREBRO_DATA_DIR/attachments/<session>/` et son chemin absolu est inséré dans
le prompt : Claude, Codex et Grok lisent l'image depuis ce chemin. Les images
sont supprimées avec la session (PNG, JPEG, GIF, WebP, 20 Mo maximum).

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
- **À la main** : champ d'ajout en bas du backlog.

« Traiter » ouvre le formulaire de nouvelle session pré-rempli avec le texte de
la tâche. La tâche passe alors « En cours » et affiche un lien vers sa session.
Marquez-la « Terminée » une fois le travail validé ; les tâches terminées sont
masquées par défaut.

### Epics

Un epic regroupe des tâches liées à un même sujet : elles s'affichent dans un
bloc commun, numérotées dans l'ordre de leurs dépendances, avec l'avancement.
« Traiter l'epic » confie toutes ses tâches ouvertes à une seule session : le
prompt les liste dans cet ordre, avec la description de l'epic, et demande à
l'agent d'exécuter `cerebro-backlog --done <id>` après chacune, ce qui la
marque terminée dans le backlog. Le lancement est refusé si une tâche de l'epic
attend une tâche hors de l'epic non terminée, ou si une session active traite
déjà l'une de ses tâches.

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
| `default` | Configuration de Claude | Configuration de Codex | Configuration de Grok |
| `acceptEdits` | `--permission-mode acceptEdits` | `-a never -s workspace-write` | `--permission-mode acceptEdits` |
| `plan` | `--permission-mode plan` | `-s read-only` | `--permission-mode plan` |
| `bypass` | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--permission-mode bypassPermissions` |

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
Les routes d'agents `/api/hook`, `/api/notify` et `/api/backlog` ne sont jamais relayées. Un jeton refusé ou une
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

**Versions.** `GET /api/version` renvoie la version de l'application (`package.json`,
complétée du commit git court ; `CEREBRO_COMMIT` la remplace hors dépôt git) et la version
du protocole entre instances (`PROTOCOL_VERSION` dans `server/version.ts`, à incrémenter à
chaque changement incompatible de l'échange ou des routes relayées). Les deux sont transmises
dans `/api/peer/sync`. Même protocole = compatible. Le bas de la barre latérale affiche la
version locale, et chaque pastille de machine distante un indicateur : rien (même version),
`≈` (autre version, protocole compatible), `⚠` (incompatible) ou `v?` (version inconnue :
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

## Limites connues

- Les TUI évoluent : la détection visuelle peut manquer un nouveau dialogue ou
  prendre un texte ressemblant à une question pour une confirmation.
- Un holder tué brutalement ne peut pas préserver son PTY ; la session est marquée
  terminée après les tentatives de reconnexion. La reprise dépend alors de
  l'identifiant de session fourni par l'agent.
- Les notifications OSC de Codex dépendent aussi de sa gestion du focus terminal.
- Cerebro est conçu pour un utilisateur de confiance. Un jeton protège l'accès
  réseau, mais ne remplace pas TLS ni un reverse proxy correctement configuré.

## Dépannage

Vérifiez d'abord que l'exécutable de l'agent est présent avec `which claude`,
`which codex` ou `which grok`. Les sorties brutes des terminaux se trouvent dans
`$CEREBRO_DATA_DIR/logs/` (par défaut `~/.cerebro/logs/`). Le journal
`$CEREBRO_DATA_DIR/hooks.jsonl` contient chaque événement reçu avec son agent, son
type et sa charge utile ; c'est la source principale pour diagnostiquer une attente
non détectée. Avec systemd, consultez aussi les logs avec :

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
