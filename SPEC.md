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
| DELETE | /api/projects/:id | tue les sessions vivantes du projet, supprime projet + sessions |
| GET | /api/sessions | `Session[]` (toutes, triées updatedAt desc) |
| POST | /api/projects/:id/sessions | `{agent, mode, prompt}` → `Session` (lance le PTY) |
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

Le PTY : `node-pty.spawn(cmd, args, {name:'xterm-256color', cols:120, rows:32, cwd: project.path, env})`.
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
- **Barre latérale** : en haut, la section « À traiter » qui liste les sessions `attention=true` (pastille orange pour waiting, bleue pour idle) ;
  puis les projets, chacun dépliable avec ses sessions (pastille de statut : running = vert animé, waiting = orange, idle = bleu, exited = gris) ;
  bouton « + Projet » (formulaire : nom, chemin absolu).
- **Vue projet** : nom + chemin, formulaire « Nouvelle session » (agent : liste des agents disponibles, mode : default / acceptEdits / plan / bypass avec un avertissement rouge pour bypass, prompt multi-ligne, Ctrl+Entrée pour lancer → navigue vers la session), puis la liste des sessions du projet (titre, agent, statut, date relative, actions).
- **Vue session** : en-tête (titre, agent, mode, statut, raison d'attention) + boutons Arrêter / Reprendre (si exited et agentSessionId) / Supprimer ;
  terminal xterm.js plein espace (FitAddon + ResizeObserver, WebLinksAddon, police monospace 13 px), connecté à `/ws/term/:id`,
  qui reçoit le focus à l'ouverture. Ouvrir la session appelle `POST /api/sessions/:id/seen`.
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
  tous les projets triées par attention puis date, et bouton créer un projet si aucun.
- Responsive : en dessous de 800 px, la barre latérale devient un tiroir (bouton menu) et le terminal prend toute la largeur.
- Si une requête reçoit 401, afficher un écran « Token requis » avec un champ qui recharge `/?token=…`.
