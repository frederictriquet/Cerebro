# Cerebro — spécification

Application web locale pour piloter des sessions interactives des CLIs `claude`, `codex` et `grok`,
organisées par projet (un projet = un nom + un répertoire de travail).

Stack imposée (déjà installée dans `node_modules`, **ne rien installer d'autre**) :
- Node 22, TypeScript exécuté directement par Node (type stripping natif) :
  **uniquement de la syntaxe effaçable** (pas d'`enum`, pas de `namespace`, pas de parameter properties),
  imports relatifs avec extension `.ts`, `import type` pour les types (`verbatimModuleSyntax`).
- Serveur : `fastify`, `@fastify/websocket`, `@fastify/static`, `node-pty`, `@xterm/headless`,
  `@xterm/addon-serialize`, `node:sqlite` (`DatabaseSync`).
- Front : Vite + React 18/19 + `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`.
- Vérification : `npx tsc --noEmit -p tsconfig.json` doit passer.

## Arborescence

```
server/config.ts          (existe déjà : HOST, PORT=4317, DATA_DIR=~/.cerebro, LOG_DIR, HOOK_SCRIPT, INTERNAL_URL, ROOT)
server/db.ts              persistance SQLite (DATA_DIR/cerebro.db)
server/agents.ts          construction des lignes de commande par agent
server/sessions.ts        SessionManager : PTY, terminal headless, statut, logs
server/hooks.ts           installation du hook global grok + interprétation des événements de hook
server/index.ts           fastify : API REST, websockets, fichiers statiques web/dist
bin/cerebro-hook.mjs      relais de hook (JS pur, sans dépendance)
web/vite.config.ts        root = web/, build -> web/dist, proxy /api et /ws (ws: true) vers 127.0.0.1:4317
web/index.html
web/src/*.tsx|ts|css      UI React
```

## Modèle de données

```ts
type Agent = 'claude' | 'codex' | 'grok';
type Mode = 'default' | 'acceptEdits' | 'plan' | 'bypass';
type Status = 'starting' | 'running' | 'waiting' | 'idle' | 'exited';
//  running : l'agent travaille
//  waiting : l'agent attend une réponse de l'utilisateur (permission, question)  -> ALERTE
//  idle    : le tour est terminé, l'agent attend un nouveau prompt              -> ALERTE
//  exited  : le processus est terminé

interface Project { id: string; name: string; path: string; createdAt: number }

interface Session {
  id: string;               // uuid
  projectId: string;
  agent: Agent;
  mode: Mode;
  prompt: string;           // prompt initial (peut être vide)
  title: string;            // = 60 premiers caractères du prompt, ou "<agent> session"
  status: Status;
  attention: boolean;       // true quand passe à waiting/idle via un signal fiable ; remis à false quand l'utilisateur ouvre la session
  attentionReason: string | null;  // ex. "Permission demandée : Bash", "Question", "Tour terminé"
  agentSessionId: string | null;   // id côté agent, pour reprendre (resume)
  exitCode: number | null;
  createdAt: number;
  updatedAt: number;
}
```

Tables SQLite `projects` et `sessions` (colonnes snake_case, conversion vers camelCase dans db.ts).
Au démarrage du serveur, toute session non `exited` passe à `exited` (les PTY sont morts avec le serveur).

## API REST (JSON, préfixe /api)

| Méthode | Route | Corps / réponse |
|---|---|---|
| GET | /api/projects | `Project[]` |
| POST | /api/projects | `{name, path}` → `Project`. `path` : `~` expansé, doit être un répertoire existant (sinon 400 `{error}`) |
| PUT | /api/projects/order | `{ids: string[]}` → `Project[]` dans l’ordre demandé ; tous les projets doivent figurer une fois. Ordre persistant, diffusé par `{type:'projects'}` ; 409 si la liste a changé |
| DELETE | /api/projects/:id | tue les sessions vivantes du projet, supprime projet + sessions |
| GET | /api/sessions | `Session[]` (toutes, triées createdAt desc : la plus récente en premier) |
| POST | /api/projects/:id/sessions | `{agent?, mode?, model?, effort?, prompt?}` → `Session` (lance le PTY) ; les champs omis héritent de `Project.sessionDefaults`, `null` remet modèle/effort au défaut de la CLI |
| POST | /api/sessions/:id/kill | envoie SIGTERM (puis SIGKILL après 3 s) |
| POST | /api/sessions/:id/resume | relance une session `exited` qui a un `agentSessionId` → `Session` |
| POST | /api/sessions/:id/seen | `attention=false` |
| DELETE | /api/sessions/:id | tue si vivante, supprime l'enregistrement et le log |
| GET | /api/agents | `{agent, available: boolean}[]` (via `which`) |
| POST | /api/hook/:id | réservé aux hooks : en-tête `x-cerebro-token` doit égaler le token de la session ; corps `{agent, event, payload}` |

## WebSockets

`/ws/events` — serveur → client, messages JSON :
- `{type:'snapshot', projects: Project[], sessions: Session[]}` à la connexion
- `{type:'session', session: Session}` à chaque création / changement
- `{type:'session-deleted', id}` ; `{type:'projects', projects: Project[]}` quand la liste change
- `{type:'alert', session: Session}` quand une session passe à `waiting` ou `idle` avec `attention=true` (signal fiable) → le front affiche une notification navigateur

`/ws/term/:id` — terminal d'une session :
- serveur → client : `{type:'snapshot', data}` (écran sérialisé du terminal headless via SerializeAddon, scrollback inclus ; pour une session `exited` sans terminal vivant : les ~2 Mo de fin du fichier log brut), puis `{type:'output', data}` en flux, `{type:'exit', exitCode}`
- client → serveur : `{type:'input', data}` (frappes clavier brutes, xterm `onData`), `{type:'resize', cols, rows}`
- Le PTY prend la taille du dernier `resize` reçu (redimensionner aussi le terminal headless).

## Lancement des agents (server/agents.ts)

Le PTY : `node-pty.spawn(cmd, args, {name:'xterm-256color', cols:120, rows:32, cwd: sessionWorkspace.path ?? project.path, env})`.
Pour les nouvelles sessions Git avec historique, `sessionWorkspace` est un worktree
isolé persistant. Git peuple les fichiers suivis ; Cerebro restaure l'index capturé,
reporte les fichiers modifiés ou non suivis et rend les dépendances ignorées disponibles
par des liens partagés. Les sessions historiques ou sans historique gardent leur chemin
initial et une provenance inconnue. Les actions Git présentent une sélection vérifiable ;
voir les contrats détaillés du README.
`env` = `process.env` **sans** les variables `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SSE_PORT`
(éviter la détection de session imbriquée), plus `TERM=xterm-256color`, `COLORTERM=truecolor`,
`CEREBRO_SESSION_ID`, `CEREBRO_TOKEN` (aléatoire, par session, gardé en mémoire), `CEREBRO_URL=INTERNAL_URL`.
Le prompt est passé comme dernier argument positionnel s'il est non vide.

Hook relay : `HOOK = ['node', HOOK_SCRIPT]`.

**claude** : `claude --session-id <uuid> --settings <json> [mode] [prompt]` ; resume : `claude --resume <agentSessionId> --settings <json> [mode]`.
`agentSessionId` = l'uuid généré. Settings JSON :
```json
{"hooks":{
  "Notification":[{"hooks":[{"type":"command","command":"node '<HOOK_SCRIPT>' claude Notification"}]}],
  "Stop":[{"hooks":[{"type":"command","command":"node '<HOOK_SCRIPT>' claude Stop"}]}],
  "UserPromptSubmit":[{"hooks":[{"type":"command","command":"node '<HOOK_SCRIPT>' claude UserPromptSubmit"}]}],
  "PostToolUse":[{"hooks":[{"type":"command","command":"node '<HOOK_SCRIPT>' claude PostToolUse"}]}],
  "PreToolUse":[{"matcher":"AskUserQuestion","hooks":[{"type":"command","command":"node '<HOOK_SCRIPT>' claude PreToolUse"}]}]
}}
```
Modes : default → rien ; acceptEdits → `--permission-mode acceptEdits` ; plan → `--permission-mode plan` ; bypass → `--dangerously-skip-permissions`.

**grok** : `grok --session-id <uuid> [mode] [prompt]` ; resume : `grok --resume <agentSessionId> [mode]`.
Modes via `--permission-mode` : default → rien ; acceptEdits → `acceptEdits` ; plan → `plan` ; bypass → `bypassPermissions`.
Les hooks grok ne peuvent pas être passés en ligne de commande : au démarrage, le serveur écrit (idempotent)
`~/.grok/hooks/cerebro.json`, même format que les hooks Claude ci-dessus, événements
`Notification`, `Stop`, `UserPromptSubmit`, `PostToolUse`, `PreToolUse` (matcher regex `(?i)ask.*user|^AskUserQuestion$`), `SessionStart`,
chaque commande étant : `[ -z "$CEREBRO_SESSION_ID" ] || node '<HOOK_SCRIPT>' grok <Event>`
(no-op hors Cerebro).

**codex** : `codex -c 'notify=["node","<HOOK_SCRIPT>","codex","notify"]' -c tui.notifications=true -c 'tui.notification_method="osc9"' [mode] [prompt]` ;
resume : `codex resume <agentSessionId> <mêmes -c> [mode]`.
Modes : default → rien ; acceptEdits → `-a never -s workspace-write` ; plan → `-s read-only` ; bypass → `--dangerously-bypass-approvals-and-sandbox`.
`agentSessionId` est inconnu au départ : il est capturé depuis le payload notify (`thread-id`, ou `thread_id`/`session_id`).

## Relais de hook (bin/cerebro-hook.mjs)

`node cerebro-hook.mjs <agent> <event> [jsonArg]`. Sort immédiatement en code 0 si `CEREBRO_SESSION_ID` ou `CEREBRO_URL` absents.
Payload : pour codex, le JSON est le **dernier argument argv** ; pour claude/grok, le JSON est lu sur **stdin** (lire jusqu'à EOF, tolérer vide / invalide → `{}`).
POST `${CEREBRO_URL}/api/hook/${CEREBRO_SESSION_ID}` avec `x-cerebro-token: $CEREBRO_TOKEN`, corps `{agent, event, payload}`,
timeout 2 s, toute erreur ignorée. **N'écrit rien sur stdout/stderr**, sort toujours avec le code 0.

## Machine à états (server/hooks.ts + sessions.ts)

Signaux fiables (→ `attention=true` + diffusion `alert` sur les transitions vers waiting/idle) :
- `Notification` : `payload.notification_type` (ou `type`) = `permission_prompt` ou `elicitation_dialog` → `waiting`, raison = `payload.message` ; `idle_prompt` → `idle` ; autre/absent : si le message contient « permission » → waiting sinon idle.
- `PreToolUse` dont `tool_name` correspond à `/ask.*user/i` → `waiting`, raison « Question ».
- `Stop` → `idle`, raison « Tour terminé ».
- codex `notify` avec `type === 'agent-turn-complete'` → `idle` (+ capture de l'id de thread).
- **OSC 9** dans la sortie PTY (`\x1b]9;<msg>(\x07|\x1b\\)`, et aussi `\x1b]777;notify;<titre>;<msg>`) : si `msg` correspond à `/approv|permission|confirm/i` → `waiting`, sinon → `idle`. Attention : la séquence peut être coupée entre deux chunks (garder un petit tampon de fin).
- `SessionStart` (grok) : capture `payload.session_id` dans agentSessionId s'il est présent.
- Ne pas déclencher une nouvelle alerte si le statut et la raison n'ont pas changé.

Retour à `running` (sans alerte, `attention` inchangé) :
- `UserPromptSubmit`, `PostToolUse` ;
- une entrée utilisateur contenant `\r` alors que le statut est `waiting` ou `idle`.

Heuristique de secours : si le statut est `running` et qu'il n'y a pas de sortie PTY depuis 20 s → `idle`,
raison « Inactif (heuristique) », **sans** `attention` ni `alert`.

Codex n'envoie les notifications OSC 9 que si le terminal n'a pas le focus : si l'application a activé le
mode focus (DECSET 1004, `\x1b[?1004h` observé dans la sortie), écrire `\x1b[O` dans le PTY 1,5 s après le démarrage
et chaque fois que le dernier client `/ws/term/:id` se déconnecte. Le front xterm.js envoie lui-même les focus in/out.

À la sortie du PTY : `exited`, `exitCode`, `attention=false`, message `{type:'exit'}` aux clients terminal.

## Logs

Chaque octet de sortie PTY est ajouté à `LOG_DIR/<sessionId>.log` (stream en append). Le terminal headless
(`@xterm/headless`, `allowProposedApi: true`, scrollback 5000) reçoit la même sortie ; il est supprimé quand la session sort.

## Sécurité

Écoute sur `HOST` (127.0.0.1 par défaut). Le token de session protège `/api/hook/:id`.

## UI web

Thème sombre, sobre, dense. Routage par hash : `#/` accueil, `#/p/<projectId>`, `#/s/<sessionId>`.
- **Onglets de projets** : réordonnables à la souris par glisser-déposer, avec un repère avant/après l’onglet survolé. L’ordre est conservé côté serveur et partagé par les vues et les navigateurs connectés à cette machine ; les nouveaux projets sont ajoutés à la fin. Accueil et « + » restent fixes.
- **Barre latérale** : en haut, la section « À traiter » qui liste les sessions `attention=true` (pastille orange pour waiting, bleue pour idle) ;
  puis les projets, chacun dépliable avec ses sessions (pastille de statut : running = vert animé, waiting = orange, idle = bleu, exited = gris) ;
  bouton « + Projet » (formulaire : nom, chemin absolu).
- **Vue projet** : nom + chemin, formulaire « Nouvelle session » (agent : liste des agents disponibles, mode : default / acceptEdits / plan / bypass avec un avertissement rouge pour bypass, prompt multi-ligne, Ctrl+Entrée (ou Cmd+Entrée sur Mac) pour lancer ; agent, modèle, effort, mode et prompt sont mémorisés automatiquement par projet côté serveur via `PATCH /api/projects/:id` `{sessionDefaults: {...}}`, même avant lancement, puis repris par tous les formulaires et les nouvelles sessions Slack ; les champs omis héritent des choix enregistrés, un prompt explicite reste prioritaire ; les brouillons non lancés et leurs images restent conservés dans le navigateur et sont effacés au lancement, le prompt lancé reste prérempli comme défaut), puis la liste des sessions du projet (titre, agent, statut, date relative, actions).
- **Vue session** : en-tête (titre, agent, mode, statut, raison d'attention) + boutons Arrêter / Reprendre (si exited et agentSessionId) / Supprimer ;
  terminal xterm.js plein espace (FitAddon + ResizeObserver, WebLinksAddon, police monospace 13 px), connecté à `/ws/term/:id`,
  qui reçoit le focus à l'ouverture. Ouvrir la session appelle `POST /api/sessions/:id/seen`. Échap seul dans le terminal
  est intercepté par Cerebro et ramène à la vue du projet de la session (accueil si projet inconnu) ; Maj+Échap et le
  bouton rapide `Échap` envoient la touche à la session.
- **Alertes** : connexion permanente à `/ws/events` (reconnexion automatique). Demander la permission
  Notification au premier clic utilisateur. Sur `alert` : `new Notification('Cerebro — <agent> attend', {body: raison + titre, tag: session.id})`,
  dont le clic fait `window.focus()` et navigue vers `#/s/<id>` ; ne pas notifier si cette session est déjà ouverte et la fenêtre visible.
  Le titre de l'onglet affiche le nombre de sessions en attente : `(2) Cerebro`. Petit bip (WebAudio) optionnel avec bouton muet dans la barre latérale (préférence en localStorage, accès protégé par try/catch).

---

# Lot 2 (ajouts après tests de bout en bout)

Déjà fait (ne pas casser) : détection à l'écran des dialogues (`inspectScreen` dans sessions.ts : dialogues de
confiance, menus numérotés, y/n → `waiting` avec la question comme raison), dédoublonnage des alertes, filtrage des
fils codex auxiliaires (title generation), journal des hooks `DATA_DIR/hooks.jsonl`,
`GET /api/sessions/:id/screen` → `{lines: string[]}` (dernières lignes texte de l'écran vivant, `[]` si la session est terminée).

## Serveur (codex)

- `PATCH /api/sessions/:id` `{title}` → `Session` (renommer ; titre non vide, 120 car. max).
- `PATCH /api/projects/:id` `{name?, path?}` → `Project` (même validation que la création) ; diffuse `{type:'projects'}`.
- `POST /api/sessions/:id/input` `{data}` → 204 : écrit dans le PTY comme une frappe (même logique que le ws, y compris
  le retour à `running` sur `\r`) ; 409 si la session n'est pas vivante. Sert aux boutons de réponse rapide.
- `GET /api/projects/:id/git` → `{branch: string|null, dirty: number, ahead: number|null}` via `git -C <path>`
  (`branch --show-current`, `status --porcelain` compte les lignes) ; `{branch:null, dirty:0, ahead:null}` si ce n'est pas un dépôt.
- Option `CEREBRO_BIND_TOKEN` : si définie, toutes les routes `/api/*` (sauf `/api/hook/*`) et `/ws/*` exigent
  `?token=<valeur>` ou l'en-tête `authorization: Bearer <valeur>` ; un cookie `cerebro_token` (httpOnly, SameSite=Strict)
  est posé quand le token arrive en query sur la page `/`, pour que l'UI fonctionne ensuite sans rien changer côté front.
  Utile si on écoute sur le réseau local (`CEREBRO_HOST=0.0.0.0`).
- Arrêt propre sur SIGINT/SIGTERM : tuer les PTY, fermer la base, puis sortir.
- `README.md` (en français) : présentation, prérequis, installation (`npm install`, `npm run build`, `npm start`),
  développement (`npm run dev`), variables d'environnement, fonctionnement de la détection d'attente par agent
  (hooks Claude via --settings, hook global `~/.grok/hooks/cerebro.json`, notify + OSC 9 codex, détection écran,
  heuristique 20 s), modes de permission par agent (tableau), limites connues, dépannage (`hooks.jsonl`).
- `scripts/cerebro.service` : unité systemd **utilisateur** d'exemple (`ExecStart=/usr/bin/env node server/index.ts`,
  `WorkingDirectory` à adapter, `Restart=on-failure`) + section README pour l'installer (`systemctl --user`).
- Script npm `"start:prod": "npm run build && node server/index.ts"`.

## Front (grok)

- Vue session : **barre de réponse rapide** sous le terminal (utile sur mobile) : boutons `Entrée`, `Échap`, `↑`, `↓`,
  `1`, `2`, `3`, `y`, `n`, `Ctrl+C` (envoie `\x03`, avec confirmation) + un champ texte « Envoyer un message » qui envoie
  le texte puis `\r` (deux envois séparés de 150 ms, sinon certaines TUI ignorent l'Entrée collée au texte). Utilise le ws
  du terminal ouvert (pas besoin de l'API input).
- Titre de session renommable (double-clic ou icône crayon → champ, Entrée valide, Échap annule) via `PATCH`.
- Vue projet : afficher la branche git et le nombre de fichiers modifiés (`GET /api/projects/:id/git`, rafraîchi toutes
  les 10 s tant que la vue est ouverte) ; bouton éditer le projet (nom, chemin) via `PATCH`.
- Section « À traiter » de la barre latérale et liste des sessions de la vue projet : sous chaque session en attente,
  afficher en petit la raison ; au survol / bouton « aperçu », montrer les ~8 dernières lignes de
  `GET /api/sessions/:id/screen` dans un popover monospace (aperçu sans ouvrir la session). Sur la vue projet, chaque
  session en attente a des boutons rapides `Entrée` / `Échap` / `Ouvrir` (via `POST /api/sessions/:id/input`).
- Libellés des modes : `default` = « Défaut (config de l'agent) », `acceptEdits` = « Accepter les éditions »,
  `plan` = « Plan / lecture seule », `bypass` = « Bypass (aucune confirmation) ».
- Page d'accueil `#/` : tableau de bord — compteurs (en cours / en attente / inactives), liste des sessions vivantes de
  tous les projets dans l'ordre de création (la plus récente en premier), et bouton créer un projet si aucun.
- Barre latérale redimensionnable (glisser sa bordure droite, double-clic pour revenir à 272 px, flèches au clavier ; 200 à 560 px) et masquable (bouton `«` / `»` ; une fine colonne reste pour la rouvrir). Largeur et masquage mémorisés en localStorage.
- Responsive : en dessous de 800 px, la barre latérale devient un tiroir (bouton menu) et le terminal prend toute la largeur.
- Si une requête reçoit 401, afficher un écran « Token requis » avec un champ qui recharge `/?token=…`.

---

# Lot 3 : sessions persistantes (survivent à l'arrêt/redémarrage du serveur)

Objectif : arrêter, redémarrer ou faire crasher le serveur ne doit **plus** tuer les agents. Seuls « Arrêter »,
« Supprimer » (session ou projet) ou la fin naturelle de l'agent terminent une session.

## Processus « holder » (server/holder.ts)

Un processus Node **détaché par session** possède le PTY. Lancé par le serveur via
`spawn(process.execPath, [join(ROOT,'server','holder.ts'), configPath], { detached: true, stdio: 'ignore' }).unref()`
(stdio ignoré ; les erreurs du holder vont dans `DATA_DIR/sessions/<id>.holder.log`).

Fichiers par session dans `DATA_DIR/sessions/` (répertoire créé en 0700) :
- `<id>.config.json` (0600) : `{cmd, args, cwd, env, cols, rows}` écrit par le serveur, lu **puis supprimé** par le holder
  (le token de hook ne doit pas traîner sur le disque ni apparaître dans `ps`).
- `<id>.sock` : socket Unix d'écoute du holder (supprimer un socket orphelin avant `listen`).
- `<id>.exit.json` : `{exitCode, signal, at}` écrit par le holder quand l'agent se termine.
- Le log brut reste `LOG_DIR/<id>.log`, **écrit par le holder** (ainsi rien n'est perdu pendant que le serveur est arrêté).

Le holder :
- lance l'agent avec node-pty, maintient un terminal `@xterm/headless` (scrollback 5000) + `SerializeAddon` ;
- accepte **un** client à la fois sur le socket (un nouveau client remplace l'ancien) ; protocole = JSON délimité par `\n` :
  - holder → client : à la connexion `{type:'hello', pid, cols, rows}` puis `{type:'snapshot', data}` (sérialisation),
    ensuite `{type:'output', data}` en flux et `{type:'exit', exitCode, signal}` ;
  - client → holder : `{type:'input', data}`, `{type:'resize', cols, rows}` (PTY + headless), `{type:'kill', signal}`
    (SIGTERM puis SIGKILL 3 s plus tard si toujours vivant) ;
- à la sortie de l'agent : écrit `<id>.exit.json`, envoie `exit` au client s'il y en a un, attend jusqu'à 5 s qu'il se
  déconnecte, puis supprime le socket et se termine. Si aucun client n'est connecté, il se termine aussi (le fichier exit suffit).
- ignore SIGHUP/SIGINT (il ne doit pas mourir avec le terminal ou le groupe de processus du serveur — `detached: true` crée
  une nouvelle session, vérifier que Ctrl+C sur `npm run dev` ne le tue pas).

## Serveur (sessions.ts)

- `launch` : écrit le fichier config, démarre le holder, puis se connecte au socket (réessais toutes les 100 ms, 10 s max ;
  échec → session `exited`, exitCode 1, erreur loggée). Le `Runtime` ne contient plus d'`IPty` mais une connexion au holder ;
  le serveur garde son **propre** terminal headless (nécessaire pour `inspectScreen` / `screenText` / snapshot ws) :
  à chaque `snapshot` reçu du holder, il recrée ce terminal et y écrit le snapshot, puis applique les `output`.
  OSC 9, focus 1004, minuteurs d'inactivité/écran : inchangés, alimentés par les `output` du holder.
- Le token de hook devient persistant : nouvelle colonne `hook_token` dans `sessions` (migration `ALTER TABLE` si absente),
  jamais exposée dans l'API ni dans les messages ws.
- **Démarrage du serveur** : remplacer « tout passer à exited » par une réconciliation : pour chaque session non `exited`,
  se connecter à `<id>.sock` ; si OK → réattacher (statut `running`, puis la détection d'écran/hook reprend ; programmer
  aussitôt une `inspectScreen`) ; sinon si `<id>.exit.json` existe → `exited` avec ce code ; sinon → `exited` (exitCode null).
  Nettoyer les fichiers sock/exit des sessions terminées.
- Si la connexion au holder se coupe sans message `exit` (holder tué) : vérifier `exit.json`, sinon tenter une reconnexion
  (3 essais espacés de 1 s), sinon `exited`.
- `kill` → message `kill` au holder. `shutdown()` (SIGINT/SIGTERM du serveur) : **ne tue plus les agents**, ferme seulement
  les connexions et la base.
- Supprimer une session/projet : kill puis suppression des fichiers `sessions/<id>.*` et du log.
- Option `CEREBRO_KILL_ON_EXIT=1` pour retrouver l'ancien comportement (tuer les agents à l'arrêt du serveur).

## README

Mettre à jour : les sessions survivent au redémarrage du serveur ; comment lister/tuer les holders orphelins à la main
(`pgrep -af server/holder.ts`) ; `CEREBRO_KILL_ON_EXIT`.

## Vérification attendue

`npx tsc --noEmit -p tsconfig.json`. Le bac à sable codex interdit les sockets réseau ; les sockets Unix dans un dossier
du workspace peuvent fonctionner : tester si possible avec `CEREBRO_DATA_DIR=./.data/test` et un agent factice
(ex. `bash`), sinon le signaler.

## Opérations déterministes et ordonnancement

- `POST /api/projects/:id/git/push`, `GET .../push` : push direct suivi par remote.
- `POST .../git/prepare-commit`, `POST .../git/commit` : sélection et plan de commits structurés, index préservé et refus des états obsolètes.
- `POST .../git/prepare-review`, `POST .../git/review` : périmètre calculé/capturé en code, raisonnement confié à l'agent.
- `/api/sessions/:id/provenance`, `/api/sessions/:id/git/*` : espace persisté et sélection explicite, y compris pour les sessions arrêtées.
- `/api/sessions/:id/findings`, `.../:report/import` : rapports structurés et import idempotent en epic/tâches ; publication agent via `cerebro-findings`.
- `Task.execution` vaut `{type:"llm"}` par défaut (migration et compatibilité distante), ou `{type:"command",commandId,completion}`. Les commandes configurées dans `/api/projects/:id/commands` créent des opérations `/api/tasks/:id/runs`, sans Session factice.
- `POST /api/epics/:id/start` renvoie désormais une exécution d'epic, pas une Session. `/api/epics/:id/runs` et `/api/epic-runs/:id/{stop,resume}` suivent l'étape persistée. Seule la tâche courante est started ; --done demeure compatible, idle/exited ne valent jamais done.
- Les sessions créées automatiquement par une epic reçoivent les instructions de leur tâche sans modifier les réglages ni le prompt mémorisés du formulaire « Nouvelle session » du projet.
- Les commandes Slack transmettent leur texte à la session sans modifier le prompt mémorisé du formulaire « Nouvelle session ». Un changement explicite d'agent reste mémorisé pour le projet.
- En mode `isolated`, la première étape LLM d'un epic crée une copie ; les étapes suivantes travaillent dans cette même copie et sur sa branche (une seule entrée dans « Copies de travail », une seule intégration). Le travail non commité des étapes précédentes compte comme changements initiaux de l'étape qui rejoint la copie. Retirer la copie la retire pour toutes ses étapes.
- `? etat ...` et les formulations factuelles bornées du README consultent le même état local/distant sans inférence. Les questions libres gardent leur recours au LLM.
- `/api/operations` et `POST /api/operations/:id/seen` suivent les résultats factuels et annulent les alertes consultées. Notifications, durées, préférences et déduplication sont gérées en code.

## Inventaire indépendant des worktrees

- Registres persistants `worktree_inventory` et `worktree_operations`, sans cascade de suppression des sessions/projets. Backfill des anciennes données `session_workspaces` ; conservation des derniers noms à la suppression.
- `GET /api/worktrees`, `GET /api/projects/:id/worktrees`, `GET /api/worktrees/:id` : découverte Git, fichiers modifiés/ignorés, commits absents de la cible, session associée ou absente, protections et dernière opération.
- `PATCH /api/worktrees/:id/target` `{branch:"refs/heads/..."}` : choix explicite d'une branche ouverte dans un autre worktree.
- `POST /api/worktrees/:id/prepare-{merge,remove}` : état revérifié et jeton temporaire de confirmation. `POST .../{merge,remove}` `{token}` : opération suivie, jeton à usage unique et refus si l'état a changé.
- Merge Git standard avec hooks, cible propre, aucune session en cours de travail. La conversation et sa branche persistent après merge ; les changements postérieurs redeviennent à intégrer. Les conflits restent à résoudre, sans reset automatique.
- Suppression distincte du worktree uniquement propre, sans fichiers ignorés à conserver, intégré et inutilisé. Une entrée ignorée sans rien à perdre ne bloque pas : lien vers le même chemin du projet source, ou fichier identique au même chemin du projet source (ex. `.claude/settings.local.json` écrit par l'agent) ; dossier régénérable (dépendances `node_modules`, `.venv`, `venv`, `vendor` ; sorties de build et caches `dist`, `build`, `.vite`, `.next`, `coverage`, `__pycache__`, `.cache`) ; un dossier seulement si tout son contenu l'est. Ces entrées (`WorktreeView.disposableIgnored`) sont revérifiées puis supprimées juste avant `git worktree remove` ; la cible d'un lien n'est jamais touchée. Aucun `--force`, aucune suppression de branche ; reprise de conversation refusée après retrait de son worktree.
- `/api/worktrees/:id/git/{prepare-commit,commit,push}` : préparation/exécution de plans explicites et suivi du push pour les worktrees dont la conversation n'existe plus. Aucun agent requis.
- Inventaire visible dans le projet et sur l'accueil de la machine sélectionnée ; protections revérifiées côté serveur, indépendamment de l'état affiché par le navigateur.

## Commit / push en un clic

- `Project.commitSettings` : `{agent,model,effort,strategy:"single"|"atomic"}`, persistant et indépendant de `sessionDefaults`. Réglable par `PATCH /api/projects/:id` : les boutons d'action de l'en-tête (« Un seul commit » et « Un commit par intention ») transmettent la stratégie pour cette opération sans modifier la préférence persistée ; l'agent, le modèle et l'effort restent dans « Réglages Git ». Migration initialisée une seule fois depuis les préférences de sessions existantes.
- `POST /api/{projects,sessions,worktrees}/:id/git/auto-commit` `{requestId,push,strategy?}` : stratégie optionnelle `single` ou `atomic` (sinon préférence du projet), exécution suivie, collecte déterministe, proposition de messages/regroupements par l'agent configuré, validation du plan, exécuteur Git puis push direct. Aucun JSON ou prompt à manipuler dans le parcours courant.
- `GET /api/git/auto-commits/:id` : phases, fichiers, exclusions, hashes/titres, résultats par remote et erreurs. `POST .../:id/cancel` arrête uniquement la préparation avant mutation Git.
- Tables `automatic_commits` et `automatic_commit_requests` : idempotence des reprises et doubles clics, y compris après redémarrage ; une opération inachevée est interrompue et jamais rejouée automatiquement.
- Les adaptateurs Claude, Codex et Grok utilisent le modèle/effort du projet, un contexte de diffs collecté en code et une sortie structurée. Pas de Session interactive factice ni de délégation des commandes Git. Les fichiers bloqués ou incertains sont exclus avant inférence et les états obsolètes sont refusés avant commit.
- `GET /api/sessions/:id/git/context` consulte uniquement les métadonnées persistées : dossier partagé, copie isolée ou copie retirée. Une ancienne conversation affiche explicitement « Commit / push du projet » avant de lancer l'action sur le dossier partagé ; aucune attribution implicite au contenu de cette session.
- `WorktreeView.changesSinceCreation` compare les fichiers locaux modifiés à leur empreinte initiale : nombre et liste des changements postérieurs, nombre des changements hérités et des fichiers qui requièrent un examen. `null` si la comparaison n'est pas prouvable. Ce compteur n'attribue pas un auteur. Les contrôles Git continuent d'utiliser l'état complet du worktree.
- Un fichier « à examiner » (changement initial, attribution incertaine, avertissement du scanner) entre dans un commit automatique quand l'utilisateur l'a coché comme examiné dans les diffs de la copie : `POST .../git/auto-commit` accepte `reviewed: {snapshotId, paths}`, et le fichier n'est inclus que si son diff est identique à celui de ce snapshot (sinon il est écarté avec la raison). Un secret détecté reste toujours exclu.
- `POST /api/worktrees/:id/discard-inherited` abandonne le contenu de départ d'une copie isolée : chaque fichier dont l'empreinte est encore celle de la création de la copie est remis à l'état de `HEAD` (ou supprimé s'il n'y existe pas), sans toucher au dossier du projet. L'empreinte est revérifiée juste avant chaque fichier ; un fichier modifié depuis est conservé. Refusé si une session, une commande ou une opération Git utilise la copie. Débloque l'intégration d'une copie dont seuls les fichiers hérités restent non commités. Un commit automatique qui ne trouve que ce contenu hérité l'indique explicitement (« Rien de nouveau à commiter »).
- L'interface présente les copies des conversations séparément du dossier principal et des copies non associées ; les fichiers ignorés et le retrait figurent dans les détails. Les diffs se consultent sans agent via la collecte existante.

## Choix du dossier de travail

- `Project.workspaceMode` vaut `isolated` (défaut et migration) ou `shared`, configurable à la création et par `PATCH /api/projects/:id`, ainsi que dans Réglages Git.
- En mode `shared`, une nouvelle session travaille dans le chemin du projet enregistré et sur sa branche courante. Pas de création, checkout ou suppression de branche, de worktree ni de copie des fichiers. Un ancien `contextPath` d'epic ne redirige pas une nouvelle session de ce mode vers un worktree.
- `Workspace.mode=shared` persiste ce choix par session. Reprise et suppression de conversation conservent le dossier et la branche de travail. Une modification de la préférence du projet ne déplace aucune session existante.
- Provenance partagée sans attribution individuelle ; les boutons Commit / push et Code review visent explicitement le périmètre du projet. Les anciens worktrees restent visibles même si le projet passe en mode partagé.

## Council

Fichiers : `server/headless.ts` (lanceur headless générique, aussi utilisé par `commit-proposal.ts`), `server/council.ts` (types, validation, prompts, anonymisation, agrégation, export ; fonctions pures), `server/council-runner.ts` (`CouncilRuns` : exécution par phases), `server/council-routes.ts`, `server/persona-routes.ts`, `server/slack.ts` (commandes) ; `web/src/CouncilLaunch.tsx`, `CouncilRunView.tsx`, `CouncilSettingsDialog.tsx`, `PersonasDialog.tsx`, `council.css`. Tests : `tests/council.test.mjs`, `tests/council-api.test.mjs`, `tests/council-slack.test.mjs`.

### Types (`server/council.ts`, miroir dans `web/src/types.ts`)

```ts
interface Persona { id: string; name: string; description: string; prompt: string; builtin: boolean; createdAt: number; updatedAt: number }
type PersonaInput = Pick<Persona, 'name' | 'description' | 'prompt'>;
interface Llm { agent: Agent; model: string | null; effort: Effort | null }   // null : défaut de la CLI
interface Participant extends Llm { personaId: string }
interface Advisor extends Participant, PersonaInput {}                       // copie figée dans le run
interface CouncilSettings {
  assignments: Record<string, Llm>;   // personaId -> agent/modèle/effort par défaut
  defaultPersonaIds: string[];        // participants cochés au lancement (2 à 8, sans doublon)
  chairman: Llm;
  readProject: boolean;               // valeur par défaut de « lire le projet »
}
type CouncilStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
type CouncilPhase = 'answering' | 'reviewing' | 'synthesizing' | 'finished';
interface CouncilAnswer { advisorId: string; text: string | null; error: string | null; startedAt: number; finishedAt: number | null }
interface CouncilReview { advisorId: string; ranking: { letter: string; reason: string }[]; blindSpot: string | null; missed: string | null;
  error: string | null; startedAt: number; finishedAt: number | null }
interface CouncilSynthesis { agreements: string; disagreements: string; blindSpots: string; recommendation: string; firstAction: string }
interface CouncilRun {
  id: string; projectId: string | null; origin: 'web' | 'slack'; question: string; context: string;
  readProject: boolean;               // toujours false hors projet
  settings: CouncilSettings; advisors: Advisor[];   // copies figées au lancement
  status: CouncilStatus; phase: CouncilPhase;
  letters: Record<string, string>;    // advisorId (= personaId) -> 'A', 'B'… tirées au hasard par run
  answers: CouncilAnswer[]; reviews: CouncilReview[]; synthesis: CouncilSynthesis | null;
  error: string | null; startedAt: number; finishedAt: number | null;
}
```

Limites : 2 à 8 conseillers (`MIN_ADVISORS`/`MAX_ADVISORS`), au moins 2 personas au catalogue, nom ≤ 80, description ≤ 300, prompt ≤ 4 000 caractères (valeurs trimées), question ≤ 10 000, contexte ≤ 100 000. `Project.councilSettings: CouncilSettings | null` (null : réglages globaux).

### Persistance (`server/db.ts`)

- `personas (id TEXT PRIMARY KEY, name, description DEFAULT '', prompt, builtin INTEGER DEFAULT 0, created_at, updated_at)`, triée par `created_at, rowid`. Les cinq personas de `DEFAULT_PERSONAS` (`contrarian`, `first-principles`, `expansionist`, `outsider`, `executor`, `builtin=1`) sont insérées une seule fois par base, marqueur `settings.personas_seeded` : une persona fournie supprimée n'est jamais réinsérée.
- `settings (key TEXT PRIMARY KEY, data TEXT)` : réglages de la machine en JSON ; clé `council` pour les réglages globaux.
- `projects.council_settings` (TEXT JSON nullable, ajoutée par migration) : surcharge du projet.
- `council_runs (id TEXT PRIMARY KEY, project_id TEXT, data TEXT)` : `CouncilRun` complet en JSON, réécrit à chaque avancée ; liste triée par `startedAt` décroissant. Supprimer un projet supprime ses runs. L'upsert ignore toute sauvegarde visant un projet disparu, y compris une fin d'appel tardive.
- Supprimer une persona la retire, dans une transaction, de `assignments` et `defaultPersonaIds` des réglages globaux et de chaque surcharge, en complétant les participants par défaut avec les premières personas du catalogue jusqu'à 2 ; les runs gardent leurs copies.
- Migration : des réglages au format antérieur `advisors[]` (personas embarquées) sont convertis au démarrage ; chaque texte absent du catalogue y devient une persona non fournie.

### Réglages effectifs

`settingsFor(project)` = `project.councilSettings`, sinon `settings.council`, sinon défauts calculés : toutes les personas (8 au plus) cochées, réparties en tourniquet sur les agents disponibles, chairman `claude` (ou le premier agent disponible si `claude` ne l'est pas), `readProject: true`. Les réglages sont validés contre le catalogue et les agents connus (`AGENTS`, pas seulement disponibles) ; modèle et effort par `parseTuning`.

### Routes

| Méthode | Route | Corps / réponse |
|---|---|---|
| GET | /api/personas | `Persona[]` |
| POST | /api/personas | `{name, description?, prompt}` → 201 `Persona` (`builtin:false`) ; 400 si invalide |
| PATCH | /api/personas/:id | champs partiels de `PersonaInput` → `Persona` ; 400, 404 |
| DELETE | /api/personas/:id | 204 ; 404 ; 409 si le catalogue tomberait sous 2 personas |
| GET | /api/council/settings | réglages globaux effectifs (enregistrés ou calculés) |
| PUT | /api/council/settings | `CouncilSettings` → réglages validés et enregistrés ; 400 si invalide |
| GET | /api/council/settings/effective?projectId= | réglages appliqués au lancement : surcharge du projet, sinon globaux ; `projectId` absent ou `none` : globaux ; 404 projet inconnu |
| PATCH | /api/projects/:id | `{councilSettings: CouncilSettings \| null}` : surcharge validée, `null` revient aux réglages globaux |
| POST | /api/councils | `{requestId, projectId?, question, context?, readProject?, participants?}` → 202 `CouncilRun` |
| GET | /api/councils?projectId= | `CouncilRun[]` récents d'abord ; sans `projectId` : tous ; `none` : hors projet |
| GET | /api/councils/:id | `CouncilRun` ; 404 |
| POST | /api/councils/:id/cancel | `CouncilRun` ; 404 inconnu, 409 déjà terminé |
| DELETE | /api/councils/:id | 204 ; 404 ; 409 si en cours |
| GET | /api/councils/:id/export | `text/markdown`, pièce jointe `council-<8 premiers caractères de l'id>.md` |

`POST /api/councils` : `requestId` (UUID) devient l'id du run et rend le lancement idempotent (même projet et même question : run existant renvoyé ; sinon 409). `participants` : `[{personaId, agent?, model?, effort?}]`, absent = `defaultPersonaIds` des réglages effectifs ; un participant sans agent reprend l'assignation de sa persona, à défaut l'agent du chairman. `readProject` absent = valeur des réglages effectifs ; ignoré (false) hors projet. Erreurs : 400 validation, 404 projet inconnu, 409 serveur en cours d'arrêt.

### Exécution (`CouncilRuns`)

Chaque appel passe par `runHeadless({agent, model, effort, prompt, schema, cwd?, access, timeoutMs, signal})` : sortie JSON structurée (`--json-schema` pour Claude et Grok, `--output-schema` pour Codex) puis revalidée par `validateSchema`. `access:'none'` : aucun outil, `cwd` = dossier temporaire vide supprimé après l'appel. `access:'read-only'` : `cwd` = chemin du projet ; Claude `--tools Read,Glob,Grep --max-turns 30`, Codex `--sandbox read-only` sans `--disable shell_tool`, Grok `--tools Read,Glob,Grep --allow Read --allow Glob --allow Grep --max-turns 30`. Toujours : pas de MCP (Claude `--strict-mcp-config` ; Codex `--ignore-user-config --ignore-rules`, ce qui écarte aussi l'approbation des projets et donc leur `.codex/config.toml`, en ne reprenant du `config.toml` utilisateur que les clés de premier niveau `model`, `model_reasoning_effort`, `openai_base_url`, `cli_auth_credentials_store`, `forced_login_method`, `forced_chatgpt_workspace_id` ; l'authentification reste lue dans `CODEX_HOME`), `dontAsk` (Claude, Grok) ou `approval_policy="never"` (Codex), pas de recherche web, toutes les variables `CEREBRO_*` (dont `CEREBRO_SLACK_*` et `CEREBRO_BIND_TOKEN`) et `CLAUDECODE` retirées avant chaque spawn ; environnement et identifiants d'authentification des CLI conservés. L'environnement du serveur reste intact. Régression par exécutables factices et sentinelles : `tests/headless-env.test.mjs`, pour les trois agents et les deux modes d'accès ; avec les vraies CLI (opt-in `CEREBRO_TEST_CLAUDE=1`, `CEREBRO_TEST_CODEX=1`) : `tests/headless-claude.test.mjs` (hooks) et `tests/headless-codex.test.mjs` (aucun MCP démarré depuis un projet approuvé). Les prompts encadrent question, contexte et réponses citées dans des balises et les déclarent données, jamais instructions.

Les appels Claude, dans les deux modes d'accès, passent `--setting-sources user --settings '{"disableAllHooks":true}'` : réglages projet et locaux exclus (hooks, commandes, variables d'environnement), hooks désactivés, réglages utilisateur conservés pour l'authentification. La liste d'outils seule ne limite pas les commandes des hooks. Vérification avec la vraie CLI et une API locale factice : `CEREBRO_TEST_CLAUDE=1 node --disable-warning=ExperimentalWarning --test tests/headless-claude.test.mjs` (hooks `SessionStart` et `UserPromptSubmit` utilisateur/projet/local, contrôle positif puis appels isolés, authentification utilisateur conservée).

1. `answering` : tous les conseillers en parallèle (`ANSWER_SCHEMA {answer}`, 10 min), `access:'read-only'` si `projectId !== null && readProject`, sinon `none`. Un échec est noté dans `answers[i].error` et toléré. Moins de 2 réponses : `failed`.
2. `reviewing` : chaque conseiller ayant répondu, en parallèle (`REVIEW_SCHEMA {ranking, blindSpot, missed}`, 5 min, `none`), reçoit les autres réponses dans un ordre mélangé, sous leur lettre. Le classement doit contenir chaque lettre attendue exactement une fois (lettres normalisées en majuscules) ; sinon la relecture est en erreur et ignorée par l'agrégation. Un échec de relecture est toléré, même s'il n'en reste aucune.
3. `synthesizing` : chairman (`SYNTHESIS_SCHEMA`, 5 champs non vides, 10 min, `none`) avec identités révélées, rangs moyens (`aggregateRanks` : moyenne des positions sur les relectures valides, réponses jamais classées en dernier) et relectures valides. Un échec donne `failed` avec `error` « Synthèse impossible : … », réponses et relectures conservées.

Fin : `phase='finished'`, `finishedAt` renseigné. Annulation (`cancel`) : `cancelled`. Arrêt du serveur (`shutdown`) : appels interrompus, `interrupted`. Au démarrage, un run resté `running` passe `interrupted` (étapes inachevées en erreur) et n'est jamais rejoué. Chaque avancée est persistée ; le client suit le run par sondage de `GET /api/councils/:id`.

Suppression d'un projet : après vérification des protections de session, `SessionManager.withProjectDeletion` est relié à `CouncilRuns.withProjectDeletion`. Les nouveaux councils du projet sont refusés (409), ses councils actifs sont annulés et attendus jusqu'à la fin de leurs appels avant l'arrêt des sessions et l'effacement des données. Le verrou est relâché même si la suppression échoue. Un lancement en attente de ses réglages revérifie le projet et le verrou avant de s'enregistrer ; après suppression il est refusé (404). Les councils hors projet ou d'autres projets continuent.

### Résultats, Slack et interface

- À la fin d'un run : `OperationResult` `{id:'council:<runId>', projectId (null hors projet), sessionId:null, kind:'council', ok: status==='succeeded', summary: recommandation ou « statut : erreur »}`. `OperationResult.projectId` devient nullable : un résultat web hors projet est notifié une seule fois par la machine qui l'exécute et le conserve, avec un lien `#/c/<id>`, même si une autre machine traite les commandes générales. L'élection du répondeur général déduplique seulement les commandes entrantes. `OperationResults.send` confirme l'envoi effectif avant que `deliver` renseigne `notifiedAt` ; un envoi ignoré ou échoué reste en attente. Un run `origin:'slack'` est marqué vu immédiatement : sa réponse arrive dans le fil.
- Slack : `parseCouncilCommand` reconnaît `council: question` et `projet/council: question` (insensible à la casse, le mot-clé prime sur un projet nommé « council »). Résolution du projet identique à `projet: instruction` (machines partagées, conflits). Run lancé avec les réglages effectifs, sans contexte ; sablier sur le message, puis recommandation, première action, accords, désaccords et lien du rapport dans le fil (`councilSlackText`), ou l'erreur.
- UI : route `#/c/<id>` (`CouncilRunView`) ; lancement depuis le bouton **Council** de l'en-tête projet (modale) et la carte **Council** de l'accueil (`CouncilLaunch`, réglages, personas, runs précédents). Suites : tâche de backlog préremplie (`POST /api/projects/:id/tasks`), brouillon du formulaire « Nouvelle session » du projet, export Markdown.
- Les appels headless ne sont pas comptés dans les statistiques d'usage.
