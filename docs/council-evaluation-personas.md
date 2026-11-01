# Évaluation des nouvelles personas à budget constant

Étape de l'epic « Council : exploiter l'analyse « quelles personas ajouter » » (council
du 2026-10-22). Le relevé des angles morts ([`council-angles-morts.md`](council-angles-morts.md))
n'a pas permis de conclure. Cette étape rejoue donc des décisions dont l'issue est
connue, en remplaçant un siège du conseil par défaut par une nouvelle persona.

**Statut : protocole validé (option C, sans Grok) et exécuté le 2026-10-30 : 15 runs,
165 appels. La recommandation (section 4) attend la validation de l'utilisateur ;
`defaultPersonaIds` n'est pas modifié.**

## 1. Protocole

### Cas rejoués

Ce sont les trois décisions proposées à la section 5 du relevé. Aucun council enregistré
n'a d'issue connue : chaque cas demande d'abord un run de référence.

| # | Cas | Décision | Issue connue | Ce qu'un bon conseil aurait dû dire | Accès |
|---|---|---|---|---|---|
| 1 | `delegation` : déléguer par défaut l'implémentation à Codex et Grok pour économiser le quota Claude | 2026-10-14 | Abandonné le lendemain : le quota Claude était loin d'être entamé | Mesurer la consommation réelle avant de réorganiser le travail : l'option zéro suffisait | aucun |
| 2 | `integration` : bouton « Tout intégrer » qui enchaîne mises à jour et merges des copies de travail | 2026-10-27 | Refusé le jour même : l'utilisateur lance chaque intégration lui-même. Seule l'aide aux conflits a été automatisée (2026-10-28) | Laisser l'utilisateur maître de chaque intégration, difficile à défaire, et automatiser l'assistance plutôt que l'enchaînement | dépôt figé au commit `f31a2ac` (2026-10-26) |
| 3 | `auto-open` : ouvrir automatiquement le terminal d'une session lancée par une action | 2026-10-16 au plus tard | Refusé à plusieurs reprises : les sessions tournent en arrière-plan, l'utilisateur les suit depuis la liste | Partir de l'usage réel : l'utilisateur mène plusieurs sessions et ne veut pas quitter sa page | aucun |

Précautions contre la fuite de l'issue :

- la question et le contexte décrivent la situation telle qu'elle se présentait avant
  la décision (section 2) ; ils ne disent rien de l'issue ;
- le web reste coupé ;
- le cas 2 lit une copie du dépôt extraite par `git archive f31a2ac`, sans historique
  Git ; elle ne contient ni `CLAUDE.md` ni le graphe, et ne mentionne pas « Tout
  intégrer » ;
- les agents tournent dans un dossier temporaire neutre, ou dans la copie pour le cas
  2 : la mémoire de l'assistant, propre au dépôt réel, n'est pas chargée.

### Compositions

Référence : la composition par défaut actuelle, avec les réglages de l'instance en
service.

| Siège | Agent · modèle · effort |
|---|---|
| Contrarien | claude · fable · xhigh |
| Premiers principes | codex · gpt-6.1-sol · xhigh |
| Expansionniste | codex · gpt-6.1-sol · xhigh |
| Outsider | claude · fable · xhigh |
| Exécutant | codex · gpt-6.1-sol · xhigh |
| Chairman | claude · opus · xhigh |

Rejeux : même question, même contexte, mêmes accès et mêmes modèles. Un seul siège
change : la persona testée prend la place de l'**Outsider** et garde son agent, son
modèle et son effort. Aucun siège n'est ajouté.

Choix du siège remplacé (validé par l'utilisateur) :

- les trois issues vont dans le même sens : faire moins, garder la main, mesurer
  d'abord ;
- l'**Expansionniste** est la seule voix qui pousse à faire plus. Le remplacer
  avantagerait mécaniquement n'importe quel nouveau venu ;
- le **Contrarien** et les **Premiers principes**, avec l'option zéro, poussent déjà
  dans le sens de l'issue. Les remplacer handicaperait le nouveau venu ;
- l'**Outsider** peut pencher des deux côtés. C'est le siège le plus neutre, et le
  même pour toutes les personas testées, qui restent ainsi comparables entre elles.

### Exécution

Les runs ne passent pas par l'instance en service, dont l'API exige un jeton que les
sessions d'agent ne reçoivent pas. Un script lance `CouncilRuns`
(`server/council-runner.ts`) sur une base de travail isolée, dans le dossier temporaire
de la session. Les personas et les réglages du council y sont recopiés depuis une
sauvegarde de la base réelle (`sqlite3 -readonly … ".backup …"`). Les invites, les
relectures anonymes et la synthèse sont donc celles de Cerebro. La base réelle n'est
jamais ouverte en écriture. Chaque run est exporté en Markdown pour être relu.

### Grille de jugement

Pour chaque run :

- **Décision** : la recommandation et la première action de la synthèse sont-elles
  conformes à l'issue connue, partiellement conformes ou contraires ?
- **Apport de la persona testée** : dans sa réponse, au moins un *fait vérifié*
  (source citée : fichier:ligne du dépôt ou élément du contexte), un *test* (expérience
  concrète, avec un seuil) ou un *arbitrage propre* (une conclusion qu'aucun autre
  conseiller ne tire) ? La synthèse le reprend-elle ?
- **Verdict** : la décision du rejeu est-elle meilleure, égale ou moins bonne que celle
  de la référence, au vu de l'issue, et pas seulement différente ?

Critère de sortie : une persona qui n'apporte jamais de fait, de test ou d'arbitrage
propre ne rejoint pas `defaultPersonaIds`.

Limites connues :

- un seul run par condition : l'écart entre deux runs peut venir du hasard du tirage ;
- les issues des cas 2 et 3 sont des préférences de l'utilisateur, pas des faits
  mesurés. L'apport attendu y est de dire quoi demander ou observer chez l'utilisateur ;
- sans accès au dépôt ni au web (cas 1 et 3), un fait vérifié ne peut venir que du
  contexte fourni.

### Coût

Chaque run compte 5 réponses, 5 relectures et 1 synthèse, soit 11 appels (2N + 1).

| Option | Runs | Appels |
|---|---:|---:|
| A : 3 références + Empiriste | 6 | 66 |
| B : A + Économiste + Mainteneur | 12 | 132 |
| C : B + Utilisateur final (axe parties prenantes, suggéré par le relevé) | 15 | 165 |

Les trois cas d'une même condition tournent en parallèle. Durée estimée : 10 à 15
minutes par condition.

## 2. Questions et contextes soumis

Textes identiques pour la référence et pour chaque rejeu.

### Cas 1, `delegation`

> **Question.** Faut-il déléguer par défaut l'implémentation aux CLI Codex et Grok pour
> économiser le quota Claude ?
>
> **Contexte.** Je suis développeur et je construis seul Cerebro, une application web
> locale qui pilote des sessions d'agents de code (Claude Code, Codex, Grok) dans des
> terminaux, projet par projet. Le projet a démarré aujourd'hui et avance vite.
> J'utilise Claude Code pour presque tout : conception, implémentation et relecture, en
> longues sessions.
>
> J'ai un abonnement Claude, un abonnement ChatGPT qui donne accès à Codex, et un compte
> d'équipe Grok. Les trois CLI sont installées et savent travailler en mode non
> interactif (`codex exec`, `grok -p`).
>
> Je crains d'atteindre la limite d'usage de mon abonnement Claude et d'être bloqué en
> plein travail.
>
> L'idée : par défaut, Claude garde la conception et la relecture, et délègue l'écriture
> du code à Codex ou à Grok en les appelant depuis sa session (`codex exec …`,
> `grok -p …`).

### Cas 2, `integration` (lit la copie du dépôt au commit `f31a2ac`)

> **Question.** Faut-il automatiser entièrement l'intégration des copies de travail de
> Cerebro, avec un bouton « Tout intégrer » qui enchaîne, pour chaque copie, la mise à
> jour avec master et le merge dans master ?
>
> **Contexte.** Cerebro est une application web locale, utilisée par une seule personne,
> son développeur, pour piloter des sessions d'agents de code (Claude Code, Codex,
> Grok). Chaque conversation travaille dans sa propre copie du dépôt, un worktree Git sur
> sa propre branche : plusieurs conversations avancent ainsi en parallèle sans se gêner.
>
> Pour ramener le travail d'une copie dans master, le panneau « Copies de travail »
> propose un parcours en quatre étapes, copie par copie :
> 1. enregistrer le travail de la conversation dans un commit, en séparant les fichiers
>    qui étaient déjà modifiés à la création de la copie ;
> 2. régler les conflits avec la cible : « Mettre à jour avec master » merge master dans
>    la copie, les conflits se résolvent dans la copie, à la main ou en le demandant à
>    la conversation, puis « Terminer la mise à jour » crée le commit de merge ;
> 3. « Intégrer » merge la copie dans master, après confirmation, si rien ne bloque
>    (master propre, agents au repos) ;
> 4. « Push » publie vers le remote.
>
> Intégrer plusieurs copies demande donc plusieurs actions par copie, et chaque conflit
> interrompt le parcours.
>
> Proposition : un bouton « Tout intégrer » qui enchaîne automatiquement, pour toutes
> les copies prêtes, la mise à jour avec master puis le merge dans master, sans
> intervention entre les étapes.

### Cas 3, `auto-open`

> **Question.** Quand une action de Cerebro lance une session d'agent (revue de code,
> commit, tâche du backlog), faut-il ouvrir automatiquement son terminal ?
>
> **Contexte.** Cerebro est une application web locale, utilisée par une seule personne,
> son développeur, pour mener plusieurs sessions d'agents de code (Claude Code, Codex,
> Grok) en parallèle, projet par projet. Chaque session tourne dans un terminal. La
> barre latérale liste les sessions avec leur état (en cours, en attente d'une réponse,
> au repos) ; un clic ouvre le terminal d'une session. Les sessions continuent de
> tourner quand on ne les regarde pas, et Cerebro peut prévenir sur Slack quand une
> session attend une réponse ou a fini son tour.
>
> Plusieurs actions de la page d'un projet lancent une session d'agent : le bouton de
> revue de code, le commit et push assisté, le démarrage d'une tâche du backlog.
>
> Proposition : après chacune de ces actions, ouvrir automatiquement le terminal de la
> session lancée, pour voir l'agent démarrer et pouvoir lui répondre tout de suite.

## 3. Résultats

### Exécution

- 15 runs le 2026-10-30, de 22 h 22 à 22 h 51 : une condition après l'autre, les trois
  cas d'une condition en parallèle. Chaque run a abouti avec 5 réponses, 5 relectures
  et une synthèse, en 3 à 6,5 minutes.
- Grok n'a jamais été appelé : le script refuse toute composition qui lui confierait
  un siège ou le chairman.
- Les rapports complets (avis, relectures, synthèse, classement) sont dans
  [`council-evaluation/`](council-evaluation/), un fichier `<cas>-<condition>.md` par
  run.
- Aucune trace de l'issue dans les 15 rapports : les mémoires du projet, qui la
  contiennent, n'ont pas été chargées. Les agents Claude chargent en revanche les
  instructions globales de l'utilisateur (`~/.claude/CLAUDE.md`), comme dans un vrai
  council : une synthèse mentionne `rtk`.

### Précisions sur la grille

- **Fait vérifié** : une source qu'on peut contrôler (fichier:ligne du dépôt). Seul le
  cas 2 lit le dépôt. Dans les cas 1 et 3, une persona ne peut que reprendre le
  contexte fourni : c'est noté « contexte seulement ».
- **Test** : une expérience à mener avant de décider, avec un seuil. Chaque persona
  doit finir par « ce qui me ferait changer d'avis ». Ce passage ne compte comme test
  que s'il est le livrable de la persona ou si la synthèse en fait son critère de
  décision.
- **Arbitrage propre** : une conclusion qu'aucun autre conseiller du même run ne tire.
- **Repris** : la synthèse cite la lettre du siège ou reprend son contenu.
- **Décision** : ce que le développeur aurait fait en suivant la synthèse à la lettre,
  c'est-à-dire sa recommandation et surtout sa première action.
- **Rang** : rang moyen du siège testé dans les relectures des quatre autres
  conseillers (1 = meilleur).
- **Aveugle** : note de 0 à 10 donnée par un second correcteur, un agent distinct qui
  ne connaissait que les issues et les synthèses, mélangées et anonymisées. Il ignorait
  quelle composition avait produit quoi. Détail dans
  [`council-evaluation/notation-aveugle.md`](council-evaluation/notation-aveugle.md).

### Cas 1, `delegation`

Issue : idée abandonnée le lendemain, le quota Claude était loin d'être entamé.

| Condition | Décision (recommandation, première action) | Conformité | Apport du siège testé | Repris | Rang | Aveugle | Verdict |
|---|---|---|---|---|---:|---:|---|
| Référence (Outsider) | Non par défaut. `/usage` et projection jusqu'à la réinitialisation : sous le plafond, ne rien changer. Puis 15 minutes pour `AGENTS.md`. Le plan garde un essai comparatif à trois configurations, sans condition. | conforme | Question naïve décisive : « as-tu déjà été bloqué ? Regarde la jauge. » Contexte seulement. | oui : « le point le plus décisif » | 3,25 | 7 | — |
| Empiriste | Non par défaut. `/usage` avec un seuil fixé d'avance : une journée sous un septième du plafond hebdomadaire, « le problème n'existe pas encore, ne construis aucune délégation ». Pilote seulement si la limite est atteinte. | conforme | Test : relevé d'une journée (seuil d'un cinquième), puis 5 tâches déléguées contre 5, abandon sous 30 % d'économie. Contexte seulement. | oui : seuil et formule de la première action | 2,00 | 8 | égale : essai conditionné à la mesure |
| Économiste | Non par défaut. Mesurer (`/usage`, `ccusage`) : loin des plafonds, « la question est réglée pour la semaine ». | conforme | Arbitrage propre : l'option zéro, avec bascule manuelle vers Codex. Test : son critère (bloqué deux fois en cinq jours ouvrés, 30 % d'économie) devient le critère de révision. Estimations annoncées comme telles. | oui : « complété par l'option zéro de A » | 2,00 | 9 | égale : la mesure clôt la question pour la semaine |
| Mainteneur | Non par défaut. Ce soir : `/usage`, `AGENTS.md`, `HANDOFF.md` et une petite tâche confiée à Codex hors de Claude (30 minutes). | partielle : bonne décision, mais la première action construit avant de mesurer | Arbitrage : un interrupteur de secours, jamais le mode nominal (coût de possession de trois CLI). Test : le nombre de blocages réels, que la synthèse combine aux autres mesures. Aucun fait sourcé. | oui : « B pour le plan de repli » | 2,50 | 5 | moins bonne : construit le repli avant de mesurer |
| Utilisateur final | Non par défaut. 45 minutes : `AGENTS.md`, `/usage`, reprise à froid par Codex. | partielle : bonne décision, mais la première action construit avant de mesurer | Arbitrage partagé : un secours plutôt qu'un défaut. Vérifications sans seuil. Contexte seulement. | peu : position écartée par le chairman | 2,25 | 4 | moins bonne : construit le repli avant de mesurer |

Les cinq conseils refusent la délégation par défaut. Ils se séparent sur la première
action. La référence, l'Empiriste et l'Économiste mesurent d'abord et laissent la
mesure décider. Le Mainteneur et l'Utilisateur final font d'abord construire un repli
vers Codex, un travail que l'issue a rendu inutile. L'Outsider de la référence pose
déjà la question qui tranche.

### Cas 2, `integration`

Issue : refusé le jour même. Le développeur lance chaque intégration lui-même, aucun
lot n'a été construit. Seule l'aide aux conflits a été automatisée.

| Condition | Décision (recommandation, première action) | Conformité | Apport du siège testé | Repris | Rang | Aveugle | Verdict |
|---|---|---|---|---|---:|---:|---|
| Référence (Outsider) | Non au bouton tel quel. File d'intégration éventuelle. Première action : mesurer `worktree_operations` ; lots d'au moins 3 copies et moins d'un tiers en conflit, construire ; sinon rien. Si les conflits dominent, améliorer leur renvoi vers la conversation. | partielle | Faits (`web/src/Worktrees.tsx:291-292`, `server/worktrees.ts:632-652`, `636`, `971`). Test : son seuil d'un tiers de conflits devient une branche de la décision. Pousse vers un bouton minimal « Intégrer les copies sans conflit », à l'opposé de l'issue. | oui (12 lignes) | 2,00 | 6 | — |
| Empiriste | Non au bouton tel quel. Mesurer : une copie par séance en médiane, abandonner ; sinon, script de simulation pendant 2 à 3 semaines avant d'écrire une file. Sélection explicite. La copie en conflit va à sa conversation. | partielle | Faits : un merge raté laisse les conflits dans master (`server/worktrees.ts:973-977`), plus `520`, `635-652` et `670`. Test : script sur un worktree jetable, seuils d'abandon. | oui : « c'est la méthode de E qui l'emporte » | 1,75 | 5 | égale |
| Économiste | Non au bouton tel quel. Tout de suite (environ une journée) : « Intégrer » enchaîne mise à jour et merge copie par copie, sous une confirmation assumée comme relecture du diff. Lot sur sélection seulement si les données le justifient. Première action : un test et une modification de `server/worktrees.ts`. | partielle | Faits : 2 ou 3 clics par copie (`web/src/Worktrees.tsx:286-293`, `server/worktrees.ts:674-676`), plus `935-962`, `635-652` et `977`. Arbitrage propre : option zéro ou version à moitié prix, et « ces deux jours valent mieux sur la résolution de conflits déléguée à la conversation », c'est-à-dire l'issue réelle. Test : son critère sur `worktree_operations` conditionne l'étape 2. | en partie : les clics et la version à moitié prix, pas la piste des conflits | 2,25 | 4 | légèrement moins bonne : construit tout de suite |
| Mainteneur | Non au bouton tel quel. Étape 1 (moins d'une journée) : type `merge` dans `OperationResult`, marque « validée » posée par le développeur. Lot seulement si les rafales sont hebdomadaires. Première action : mesurer les rafales. | partielle | Faits : un merge échoué ne notifie rien (`server/operation-results.ts:3`), le jeton de confirmation est à usage unique (`server/worktrees.ts:935-962`), plus `520`, `665-680` et `958`. Arbitrage : le push est la ligne rouge. | oui (16 lignes) | 2,75 | 5 | égale |
| Utilisateur final | Non au bouton tel quel, mais « ne rien faire serait un mauvais choix » : simulation de lot en lecture seule tout de suite, lot atomique ensuite, délégation des conflits en parallèle. Première action : écrire `simulateBatch`. | contraire : « oui à une intégration de lot atomique » | Faits (`web/src/Worktrees.tsx:63-68`, `376-380`, `439-444` ; `README.md:819-836`, `865-868`). Arbitrage propre : l'utilisateur perdrait la confirmation par copie et le choix de l'ordre, et « remarquerait l'arrêt en plein milieu plus que les clics ». Vérification : observer une vraie séance. Test : son seuil est combiné à celui de D pour le palier 2. | en partie : « le vrai frein est le conflit (E) », mais la décision va dans l'autre sens | 3,00 | 3 | moins bonne |

Aucun conseil ne retrouve l'issue entière. Tous refusent le bouton tel quel, mais
envisagent un lot sous condition, et aucun ne demande au développeur s'il veut garder
la main sur chaque intégration. Sur ce cas, chaque persona testée apporte des faits
sourcés que la synthèse reprend. Ces faits ne changent pas la décision. La référence
garde la meilleure note à l'aveugle grâce à sa branche « si les conflits dominent,
améliorer leur renvoi vers la conversation », la seule proche de l'issue.

### Cas 3, `auto-open`

Issue : refusé à plusieurs reprises. Les sessions tournent en arrière-plan, le
développeur les suit depuis la liste.

| Condition | Décision (recommandation, première action) | Conformité | Apport du siège testé | Repris | Rang | Aveugle | Verdict |
|---|---|---|---|---|---:|---:|---|
| Référence (Outsider) | Non. Notification « Revue lancée — Ouvrir », surbrillance, Maj+clic, alerte quand une session attend, permissions prédéfinies. Exception pour le commit seulement si une semaine d'usage montre qu'on ouvre presque toujours son terminal. Première action : la notification. | conforme | Arbitrage propre et décisif : « pourquoi construire une appli pour lancer des agents en parallèle, puis les regarder un par un ? », plus le cas des lancements en rafale. Contexte seulement. | oui : « je suis E et A » | 1,00 | 8 | — |
| Empiriste | Non par défaut, une règle par action. Commit ouvert seulement si son flux demande une validation. Première action : fonction commune réglée sur « arrière-plan », journal local, lecture du prompt de commit. | partielle : l'exception du commit dépend du flux de l'agent, pas de l'usage | Test : journal local sur 30 lancements, seuils d'abandon. Arbitrage : « ça dépend de l'action ». Contexte seulement. | oui : « c'est le cadrage de B » | 1,25 | 5 | légèrement moins bonne. En pratique, le prompt de commit du 16/10 ne demandait pas de validation systématique (`cb7bc0c`) : la règle serait restée « arrière-plan » |
| Économiste | Non, « quelle que soit l'action ». Première action : vérifier les trois chemins de lancement et supprimer tout changement de vue, puis notification et journal. | conforme | Arbitrage : l'option zéro, le coût est l'attention. Test : plus de 3 lancements sur 4 ouverts en moins de 15 secondes sur une semaine. | oui : « le critère de E est le plus directement utilisable » | 1,50 | 8 | égale |
| Mainteneur | Non par défaut, sauf pour le commit : `open: true` dès la première action. | contraire : ouvre le terminal du commit dès la première action | Arbitrage propre mais contraire à l'issue : « oui, avec un réglage activé par défaut ». Risques concrets (vol de focus, terminal vide avant le branchement du PTY). Test : part des terminaux quittés en moins de 5 secondes. | oui : risques et critère | 3,75 | 3 | moins bonne |
| Utilisateur final | Non par défaut, Maj+clic. Exception pour le commit si son premier tour exige une réponse ou une approbation d'outil. Première action : observer la première minute des trois actions, puis la confirmation cliquable. | partielle | Arbitrage : un accusé visible répond à « est-ce parti ? », pas à « il m'attend ». Vérification : observer une semaine d'usage. Contexte seulement. | oui : « B et C ont raison » | 1,25 | 6 | légèrement moins bonne : selon le mode de permission, l'exception se serait déclenchée |

L'Outsider porte ici l'argument décisif et obtient le meilleur rang possible. Seul
l'Économiste fait aussi bien. Les trois autres remplaçants gardent une ouverture
automatique pour le commit, que le développeur a refusée : tout de suite pour le
Mainteneur, sous condition pour l'Empiriste et l'Utilisateur final.

### Bilan par persona

| Persona | Fait vérifié | Test repris par la synthèse | Arbitrage propre | Rang moyen | Aveugle, moyenne | Verdicts cas 1 / 2 / 3 | Critère de sortie |
|---|---|---|---|---:|---:|---|---|
| Outsider (siège de référence) | cas 2 | cas 2 | cas 1 et 3, décisifs | 2,08 | 7,0 | — | — |
| Empiriste | cas 2 | cas 1, 2 et 3 : des expériences conçues, son livrable | cas 3 | 1,67 | 6,0 | égale / égale / légèrement moins bonne | franchi |
| Économiste | cas 2 | cas 1, 2 et 3 : son critère de changement d'avis | cas 1 et 2 | 1,92 | 7,0 | égale / légèrement moins bonne / égale | franchi |
| Mainteneur | cas 2, dont un fait nouveau (`operation-results.ts:3`) | cas 1 et 3 | cas 1 ; cas 3, contraire à l'issue | 3,00 | 4,3 | moins bonne / égale / moins bonne | franchi |
| Utilisateur final | cas 2 | cas 2 | cas 2 (cas 3 : partagé avec un autre conseiller) | 2,17 | 4,3 | moins bonne / moins bonne / légèrement moins bonne | franchi |

Le test n'est pas discriminant : chaque persona doit finir sur un critère mesurable, et
les synthèses en reprennent souvent un. Seul l'Empiriste en fait son livrable :
hypothèse décisive, expérience la moins chère, seuil d'abandon. Ce qui départage les
personas, c'est l'effet sur la décision.

Rangs moyens des sièges fixes sur les 15 runs : Premiers principes 1,75, Exécutant
2,45, Contrarien 2,87, Expansionniste 3,27.

### Contre-jugement à l'aveugle

Le jugement principal, rédigé en connaissant les conditions, et le correcteur à
l'aveugle concordent sur 9 rejeux sur 12 : même sens par rapport à la référence. Les
trois écarts sont des rejeux d'abord jugés « égale » :

- Mainteneur et Utilisateur final, cas 1 : le correcteur les note 5 et 4 contre 7 à la
  référence, parce que leur première action fait construire le repli avant toute
  mesure. Sa lecture est retenue : elle suit mieux la grille, où la première action
  compte.
- Empiriste, cas 3 : 5 contre 8. Le correcteur ne savait pas que le prompt de commit
  de l'époque ne demandait pas de validation systématique. Le verdict retenu,
  « légèrement moins bonne », tient compte des deux arguments.

Il ne place aucun rejeu nettement au-dessus de la référence. Les deux seules notes
supérieures (Économiste 9 et Empiriste 8 contre 7, cas 1) forment selon lui un bloc
avec la référence, et il juge l'écart non significatif.

## 4. Recommandation sur la composition par défaut

**Garder `defaultPersonaIds` tel quel : Contrarien, Premiers principes,
Expansionniste, Outsider, Exécutant.** Le changement reste à la décision de
l'utilisateur.

1. **Remplacer l'Outsider n'améliore aucune décision.** À budget constant, aucune des
   quatre personas n'a produit une décision nettement meilleure que la référence sur
   ces trois cas, ni au jugement principal ni à celui du correcteur à l'aveugle. La référence
   obtient 7,0 de moyenne à l'aveugle, l'Économiste autant, l'Empiriste 6,0, le
   Mainteneur et l'Utilisateur final 4,3. L'Outsider a porté l'argument décisif dans
   deux cas sur trois (cas 1 : « regarde la jauge » ; cas 3 : rang 1,00).
2. **Les quatre personas franchissent le critère de sortie.** Chacune apporte au moins
   un fait vérifié, un test ou un arbitrage propre que la synthèse reprend. Aucune
   n'est donc écartée : elles restent au catalogue et dans les compositions par type de
   question, qui les contiennent déjà (Empiriste et Mainteneur en « Technique » ;
   Utilisateur final, Empiriste et Économiste en « Produit »). Franchir le critère ne
   suffit pas pour autant à entrer dans la composition par défaut.
3. **Si un siège se libère, l'Économiste et l'Empiriste.**
   - L'Économiste n'a jamais nettement dégradé une décision. Son option zéro et ses
     critères sont repris.
   - L'Empiriste a le meilleur rang des pairs et c'est le seul à concevoir des tests.
     En revanche, sa règle « action par action » a laissé une porte ouverte dans le
     cas 3.
   - Le Mainteneur et l'Utilisateur final sont à réserver aux compositions
     spécialisées : chacun a éloigné deux synthèses de l'issue.
4. **L'angle des parties prenantes reste à couvrir autrement.** L'Utilisateur final
   devait couvrir cet angle, dominant selon le relevé des angles morts. Il n'a pourtant
   pas aidé sur les deux cas qui en relevaient (2 et 3). Aucun conseil n'a proposé de
   demander son avis au développeur, alors que les deux issues étaient ses
   préférences.
5. **Point d'attention, sans changement proposé.** Dans la composition « Décision »,
   le Mainteneur est le seul siège testé ici qui a poussé immédiatement une décision
   d'usage à l'opposé de l'issue (cas 3). L'Économiste y serait une alternative à
   évaluer.

## 5. Limites et suites

- **Un seul tirage par condition.** Plusieurs verdicts tiennent à la première action
  d'une synthèse. Un second run de référence (l'option R, non retenue) mesurerait
  l'écart d'un tirage à l'autre.
- **Trois issues dans le même sens.** Toutes vont vers « faire moins, garder la
  main ». Elles ne peuvent donc pas tester le remplacement de l'Expansionniste, le
  siège le moins bien classé par ses pairs sur les 15 runs (3,27) : n'importe quel
  remplaçant y gagnerait mécaniquement. Pour décider si l'Empiriste doit remplacer
  l'Expansionniste, il faudrait rejouer des décisions dont l'issue a été « faire
  plus » (une fonctionnalité adoptée et utile), en remplaçant ce siège-là.
- **Préférences de l'utilisateur.** Les issues des cas 2 et 3 sont des préférences.
  Aucun conseil, même avec l'Utilisateur final, n'a proposé de demander au développeur
  s'il voulait garder la main : un council sans l'utilisateur ne voit pas ce type
  d'issue.
- **Un seul LLM pour le siège testé.** Les quatre personas tournaient sur claude ·
  fable · xhigh, le LLM de l'Outsider. Leur comportement avec un autre modèle n'est pas
  mesuré.

## Observation annexe

Dans la base de l'instance en service, l'Empiriste et l'Historien des échecs ont des
besoins d'accès vides (`needs: []`). Le code déclare pourtant `["project", "web"]` pour
l'Empiriste et `["web"]` pour l'Historien des échecs. Les deux personas ont été
modifiées à la même seconde (19 h 46 min 01 s). Au lancement d'un council, Cerebro ne
signale donc pas qu'il leur manque l'accès au dépôt ou au web. Cette évaluation n'en
dépend pas : elle a recopié les personas telles quelles, et les accès viennent des
réglages du run.
