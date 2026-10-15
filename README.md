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
