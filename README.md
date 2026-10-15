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
| `CEREBRO_PUBLIC_URL` | `http://${CEREBRO_HOST}:${CEREBRO_PORT}` | Base des liens « Ouvrir dans Cerebro » envoyés sur Slack. |

Pour une écoute sur le réseau local, définissez un secret robuste en même temps que
`CEREBRO_HOST=0.0.0.0`. Ouvrez d'abord `http://hote:4317/?token=SECRET` : Cerebro
enregistre le secret dans un cookie `httpOnly` et `SameSite=Strict`. Les clients API
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
active du projet, ou en créer une en mode auto s'il n'y en a pas. Ajoutez `+`
(`projet+: instruction`) pour forcer une nouvelle session, et `/claude`,
`/codex` ou `/grok` pour choisir l'agent (`projet/codex+: instruction`). La
lecture de ces commandes nécessite le scope Bot Token `im:history`. Envoyez `help` (ou
`aide`, `?`) pour obtenir la syntaxe, la liste des projets avec leur session
active et la façon de répondre dans un fil.

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
`~/.cerebro/env`, format `CLE=valeur`, à protéger avec `chmod 600`), chargé au démarrage. Les consignes `cerebro-notify` sont données
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

Les alertes fiables sont dédoublonnées. Une saisie validée par Entrée remet une
session en cours, sans effacer une alerte tant que la session n'a pas été ouverte.

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

  Sur l'entrée standard, les tâches sont séparées par une ligne `---`.
- **À la main** : champ d'ajout en bas du backlog.

« Traiter » ouvre le formulaire de nouvelle session pré-rempli avec le texte de
la tâche. La tâche passe alors « En cours » et affiche un lien vers sa session.
Marquez-la « Terminée » une fois le travail validé ; les tâches terminées sont
masquées par défaut.

## Modes de permission

| Mode | Claude | Codex | Grok |
|---|---|---|---|
| `default` | Configuration de Claude | Configuration de Codex | Configuration de Grok |
| `acceptEdits` | `--permission-mode acceptEdits` | `-a never -s workspace-write` | `--permission-mode acceptEdits` |
| `plan` | `--permission-mode plan` | `-s read-only` | `--permission-mode plan` |
| `bypass` | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--permission-mode bypassPermissions` |

Le mode `bypass` désactive des protections importantes de l'agent. Il ne doit être
utilisé que dans un environnement maîtrisé.

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
