# Council : Faut-il automatiser entièrement l'intégration des copies de travail de Cerebro, avec un bouton « Tout intégrer » qui enchaîne, pour chaque copie, la mise à jour avec master et le merge dans master ?

Lancé le 2026-10-30T21:38:10.245Z · statut : succeeded · chairman : claude · opus · effort xhigh · lecture du projet

## Question

Faut-il automatiser entièrement l'intégration des copies de travail de Cerebro, avec un bouton « Tout intégrer » qui enchaîne, pour chaque copie, la mise à jour avec master et le merge dans master ?

## Contexte

Cerebro est une application web locale, utilisée par une seule personne, son développeur, pour piloter des sessions d'agents de code (Claude Code, Codex, Grok). Chaque conversation travaille dans sa propre copie du dépôt, un worktree Git sur sa propre branche : plusieurs conversations avancent ainsi en parallèle sans se gêner.

Pour ramener le travail d'une copie dans master, le panneau « Copies de travail » propose un parcours en quatre étapes, copie par copie :
1. enregistrer le travail de la conversation dans un commit, en séparant les fichiers qui étaient déjà modifiés à la création de la copie ;
2. régler les conflits avec la cible : « Mettre à jour avec master » merge master dans la copie, les conflits se résolvent dans la copie, à la main ou en le demandant à la conversation, puis « Terminer la mise à jour » crée le commit de merge ;
3. « Intégrer » merge la copie dans master, après confirmation, si rien ne bloque (master propre, agents au repos) ;
4. « Push » publie vers le remote.

Intégrer plusieurs copies demande donc plusieurs actions par copie, et chaque conflit interrompt le parcours.

Proposition : un bouton « Tout intégrer » qui enchaîne automatiquement, pour toutes les copies prêtes, la mise à jour avec master puis le merge dans master, sans intervention entre les étapes.

## Synthèse

### Points d’accord

- **Le push reste un geste manuel séparé.** Personne ne propose de l'inclure dans le lot. A en fait sa ligne rouge, car c'est le push qui rend le lot difficile à annuler.
- **Chaque intégration déplace master.** Les prévisions de conflits et la confirmation calculées avant le premier merge ne valent plus pour les copies suivantes. Une automatisation doit réévaluer chaque copie contre le master produit par les précédentes (A, B, C, D, E).
- **Les conflits ne s'automatisent pas.** Ils se résolvent dans la copie, à la main ou par la conversation. Un lot ne fait gagner du temps que sur les copies sans conflit (A, C, D, E).
- **Un merge sans conflit textuel ne prouve pas que le code fonctionne ensemble.** Avec du code écrit par des agents, le vrai risque est le conflit sémantique : deux changements qui fusionnent proprement mais cassent l'application (C, D, et toutes les relectures).
- **Si un lot existe, il doit avancer copie par copie et s'arrêter au premier blocage.** Il ne doit jamais laisser master à moitié mergé (D, E, toutes les relectures).
- **Personne n'a de données d'usage.** Chaque conseiller fait dépendre sa position d'une mesure, mais aucune n'a encore été faite.

### Désaccords

**1. Construire ou non.**
- B et E disent oui.
- C dit non : il faut d'abord simplifier.
- A propose une boucle minimale ou rien.
- D dit non sans simulation et sans tests.

Ce qui sépare ces positions, c'est le volume supposé. B imagine vingt conversations ; A et C partent d'un usage personnel. B finit dernier à juste titre : sa projection ne correspond pas à la situation, et « intégrer pendant que les agents produisent » contredit la règle qui exige des agents au repos.

**2. La mise à jour avec master est-elle utile ?**
- C : c'est du travail Git inutile, puisque Git ne l'exige pas.
- A, dans sa relecture : c'est elle qui permet de tester le résultat combiné dans la copie, puis d'avancer master en fast-forward (avance simple, sans commit de merge dans master).

Les deux ont raison, selon le design. Sans tests, C a raison : un merge direct suffit. Avec des tests, la copie devient l'endroit où l'on valide. **Pour un lot, je suis A.** C est premier au classement grâce à son recadrage, mais cette affirmation tombe dès qu'on veut valider avant de toucher master. A est quatrième, mais sa relecture donne le design qui réconcilie C, D et E.

**3. Le lot contourne-t-il le jeton de confirmation ?**
- A et D : oui.
- B, C et E : non, on peut le redemander avant chaque merge.

Redemander le jeton garantit encore que l'état n'a pas bougé entre la préparation et l'exécution. Mais le consentement perd son sens : le développeur a validé l'état de départ, pas les N états intermédiaires. **La solution : confirmer un plan figé** (le commit de chaque copie et le master de départ), et tout arrêter si une copie bouge. Les états intermédiaires de master découlent alors du plan.

**4. Réversibilité.** A estime qu'un `git reset --hard` sur le master de départ suffit. Les relecteurs trouvent ce point exagéré : la commande efface le travail non commité et ne défait pas les merges faits dans les copies. Si l'on n'avance master qu'en fast-forward et sur un dossier propre, ce reset devient sûr. Les commits de merge laissés dans les copies sont sans danger.

**5. Tout intégrer d'un coup, ou copie par copie ?**
- B, C et E proposent de tout intégrer dans un worktree temporaire, puis d'avancer master en une fois.
- A propose d'avancer master copie par copie, en fast-forward.

**Je retiens la version copie par copie.** Le danger décrit par D, c'est un master bloqué en plein merge, pas « deux copies sur quatre intégrées ». Un état partiel où chaque étape a été testée reste cohérent. Le worktree temporaire ajoute un objet de plus à gérer, et le tout-ou-rien n'apporte rien ici.

**6. Coût.** E prévoit trois jours de développement ; A et D jugent cela trop lourd pour un outil personnel sans preuve de besoin.

### Angles morts

- **« Prête » n'est pas défini** (relectures de A, C et E). Commitée, relue et voulue sont trois choses différentes :
  - si le développeur relit chaque diff, les clics pèsent peu face à la relecture et le bouton ne fait presque rien gagner ;
  - si « prête » veut seulement dire « tout est commité », le bouton envoie dans master du code que personne n'a relu.

  Il faut une marque explicite « validée », posée par le développeur.
- **Les sessions d'agents en cours** (relecture de D). Merger master dans une copie change ses fichiers sans que la conversation le sache. Un verrou posé sur tout le lot gèle toutes les conversations pendant sa durée. Il faut verrouiller uniquement la copie en cours et master, et prévenir la conversation que sa copie a reçu master. Le fast-forward de master modifie aussi le dossier du projet, où travaillent les sessions en mode partagé.
- **Personne n'a vu que le gain dépend des rafales, pas du volume.** Le bouton ne sert que quand le développeur intègre au moins trois copies d'affilée. A compte les merges par semaine, C et E comptent les clics, mais aucun ne mesure ces rafales.
- **Personne n'a vu qu'une copie testable doit être exécutable.** Lancer les tests dans chaque worktree suppose les dépendances installées (`node_modules` est propre à chaque worktree), un build et une config locale disponibles. Il faut aussi qu'une commande de test soit configurée pour le dépôt, et rien n'indique que Cerebro en ait une. La durée des tests multipliée par N copies fixe la durée du lot, donc du gel des conversations.
- **Personne n'a vérifié le coût réel d'une copie sans conflit aujourd'hui.** Si l'interface ne propose déjà la mise à jour qu'en cas de conflit prévu (`web/src/Worktrees.tsx:374`, cité par C), le parcours actuel est : commit, Intégrer, confirmer. Le gain du bouton se réduirait alors à une confirmation par copie.
- **L'ordre doit être choisi, pas subi** (relecture de D) : d'abord les copies sans conflit prévu, puis les plus petites.
- **Les échecs passent inaperçus** (A). `OperationResult` n'a pas de type `merge` : un échec en milieu de lot ne déclenche aucune notification. Les hooks Git s'exécutent aussi N fois.

### Recommandation

**Non au bouton « Tout intégrer » tel qu'il est formulé.** Il enchaîne mise à jour et merge sans pause, sur des copies « prêtes » qui ne sont pas définies, et sans tests. Il supprime le seul filtre actuel, la pause humaine, sans rien mettre à la place. Le pré-mortem de D décrit exactement ce qu'il produirait.

**Étape 1 — maintenant, moins d'une journée (la voie de C)**
- Pour une copie sans conflit prévu, afficher directement « Intégrer », sans passer par la mise à jour, si ce n'est pas déjà le cas.
- Ajouter le type `merge` à `OperationResult` pour qu'un échec soit signalé. C'est utile même sans lot.
- Ajouter une marque « validée », posée par le développeur après relecture du diff.
- Le push reste séparé.

**Étape 2 — seulement si la mesure le justifie**

Seuil proposé : sur 30 jours, au moins une rafale par semaine (trois intégrations ou plus en moins de 30 minutes). La fonction s'appellerait **« Intégrer la sélection »** :
1. **Sélection.** Seulement les copies marquées validées.
2. **Simulation avant d'agir.** Simuler la chaîne de merges avec `git merge-tree`, dans l'ordre choisi (copies sans conflit prévu d'abord). Afficher qui passe et qui bloque, et sur quels fichiers. Une seule confirmation, liée au plan figé (commit de chaque copie et master de départ).
3. **Exécution copie par copie.** Pour chaque copie : verrouiller la copie et master seulement, mettre à jour la copie avec master, lancer la commande de test du projet dans la copie, avancer master avec `merge --ff-only`, puis revérifier les commits.
4. **Arrêt au premier problème** : conflit, test rouge, copie modifiée ou master sale. Master reste sur la dernière copie validée, jamais en plein merge.
5. **Compte rendu.** Un rapport dans le panneau, une notification, et un message à chaque conversation dont la copie a reçu master.
6. **Jamais de push.**

**Pourquoi ce design.** Il garde le jugement humain là où il compte : la validation des diffs et les conflits. La pause par copie est remplacée par un filtre automatique, les tests, au lieu d'être supprimée. L'effet de l'ordre est visible avant d'agir. Master ne peut jamais rester en plein merge. Sans commande de test configurée et fonctionnelle dans un worktree neuf, on ne fait pas l'étape 2 : c'est la condition de D, et je la retiens.

**Pourquoi pas tout de suite.** Sans rafales mesurées, ce sont les trois jours estimés par E, plus la charge de maintenance décrite par A, pour économiser quelques confirmations.

### Première action

Lancer une requête sur la table `worktree_operations` (citée par A) pour les 30 derniers jours :
- le nombre d'intégrations dans master ;
- le nombre de rafales, c'est-à-dire trois intégrations ou plus en moins de 30 minutes ;
- la part des intégrations passées par « Mettre à jour avec master » et la part qui a eu un conflit.

En même temps, lire `web/src/Worktrees.tsx:374` pour vérifier si la mise à jour est déjà sautée quand aucun conflit n'est prévu.

Ces deux vérifications prennent environ une heure et décident de la suite :
- **rafales rares** : on fait seulement l'étape 1 et on clôt le sujet ;
- **rafales au moins hebdomadaires** : on lance l'étape 2, en commençant par configurer la commande de test du dépôt et vérifier qu'elle passe dans un worktree tout juste créé.

## Avis

### A — Mainteneur (claude · fable · effort xhigh)

**Position du mainteneur : pas le bouton tel que décrit. Une boucle mince sur les primitives existantes, sans table, sans push, ou rien.**

**Coût de possession**

- Chaque merge dans master change `targetHead`, donc l'empreinte de toutes les autres copies et le cache des prévisions de conflit (`server/worktrees.ts:520` et `635-652`). Le lot doit refaire `prepare`/`begin` à chaque copie ; le jeton de confirmation à usage unique (lignes `935-962`) ne protège plus rien : une confirmation pour N états jamais vus.
- Les conflits tombent dans la copie, pas dans master (`updateFromTarget`, lignes `665-680`). Le temps humain est là ; le lot n'économise que des clics sur les copies propres.
- Résultat dépendant de l'ordre : B conflicte parce que A est passée avant. Ticket de support garanti : « pourquoi en lot et pas à la main ».
- `OperationResult` ne connaît pas le type `merge` (`server/operation-results.ts:3`) : un lot qui échoue à la troisième copie se tait. Il faudra un type, une notification, une UI.
- Hooks exécutés N fois, master verrouillé N fois avec saisies différées (`server/worktree-gate.ts:19`, test `tests/worktrees.test.mjs:144`). Quarante tests couvrent le parcours unitaire ; le lot ajoute ordre, échec et redémarrage à mi-course.

**Irréversible et porte de sortie**

Rien n'est irréversible tant que Push reste un geste séparé : chaque opération note `targetHead` avant le merge (ligne `958`), et un `git reset --hard` sur celui de la première opération du lot efface tout. Ajouter « et push » au bouton ferme cette porte : c'est la ligne rouge. Retirer une boucle sans état coûte zéro, les artefacts sont des commits de merge Git ordinaires.

**Ce qui me ferait changer d'avis** : la table `worktree_operations` sur trente jours montrant plus de dix merges réussis par semaine. À ce volume, les clics économisés justifient un lot persistant, avec notifications et tests dédiés.

### B — Expansionniste (codex · gpt-6.1-sol · effort xhigh)

**Oui. « Tout intégrer » doit devenir le point d’entrée d’une véritable file d’intégration automatique.** Avec dix fois plus de conversations, chaque validation répétitive transforme le développeur en goulot d’étranglement. Automatiser cette jonction permet d’augmenter le nombre d’expériences menées en parallèle et de ramener leurs résultats plus vite dans le produit.

Le socle existe : une mise à jour sans conflit crée déjà son commit automatiquement ; l’intégration vérifie les références et verrouille les espaces concernés ([server/worktrees.ts](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/server/worktrees.ts:665)). Le bouton peut orchestrer ces mécanismes : prendre les copies dont le travail est commité, les traiter successivement, puis réévaluer chaque candidate contre le master obtenu après l’intégration précédente.

**Visons une session de développement où vingt conversations produisent et où Cerebro rassemble leurs contributions pendant que le développeur poursuit sa réflexion.** Une copie conflictuelle repart vers sa conversation pour résolution ; les autres continuent. La suite naturelle consiste à exécuter les tests sur chaque résultat combiné, puis à reprendre automatiquement les candidates débloquées.

Ce fonctionnement ouvre une boucle continue : les conversations restent utilisables après intégration et peuvent livrer plusieurs incréments successifs, comportement déjà prévu dans [README.md](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/README.md:871). Réduire le coût de chaque livraison encourage des changements plus petits, intégrés plus fréquemment. Rester au parcours manuel laisse cette capacité de production sur la table, même pour un utilisateur unique : son attention constitue précisément la ressource rare.

**Ce qui me ferait changer d’avis :** sur 50 intégrations automatiques, le temps humain médian par copie, corrections et reprises comprises, ne diminue pas d’au moins 50 % par rapport aux 50 intégrations manuelles précédentes.

### C — Premiers principes (codex · gpt-6.1-sol · effort xhigh)

**Non. Retirez une étape du parcours normal avant de construire un automate.**

Le besoin réel est de ramener du travail validé dans master avec moins d’attention humaine. Enchaîner davantage de commandes ne garantit ni ce résultat ni la compatibilité entre les travaux des agents.

La proposition suppose une obligation inexistante : Git n’exige pas de merger master dans chaque copie avant de l’intégrer. Cerebro réalise déjà une intégration directe ([server/worktrees.ts:973](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/server/worktrees.ts:973)). L’interface propose la mise à jour lorsque des conflits sont prévus ; elle sert à les résoudre dans la copie ([web/src/Worktrees.tsx:374](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/web/src/Worktrees.tsx:374)). L’automatiser systématiquement ajouterait donc du travail Git inutile.

Les contraintes réelles sont simples : travail enregistré et relu, cible propre, agents au repos, résultat compatible. Chaque intégration change master : une copie jugée prête auparavant doit être réévaluée. Le serveur vérifie déjà que l’état confirmé n’a pas changé ([server/worktrees.ts:952](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/server/worktrees.ts:952)). Une fusion sans conflit textuel ne prouve aucune compatibilité fonctionnelle.

Comparons les options :

- **Ne rien faire** : coût de développement nul ; suffisant si l’intégration consomme peu de temps.
- **Retirer** : sortir l’étape « mise à jour » du parcours sans conflit, afficher directement « Intégrer », et présenter les conflits comme une exception à traiter. C’est ma recommandation.
- **Tout automatiser** : ajouter une orchestration avec ordre, réévaluation et reprise après interruption, sans supprimer les décisions difficiles.

Pour une application personnelle, simplifier l’écran suffit avant de créer une file d’intégration.

Je changerais d’avis si un relevé de 30 intégrations après cette simplification montrait au moins 27 parcours sans conflit et plus de 15 minutes cumulées consacrées uniquement aux clics, avec des tests automatiques passant sur chaque résultat fusionné.

### D — Contrarien (claude · fable · effort xhigh)

## Pré-mortem : dans un an

Le bouton existe, mais personne ne l'utilise plus. Il a été retiré après qu'un « Tout intégrer » sur quatre copies a laissé master dans cet état : deux copies mergées, la troisième bloquée en `MERGE_HEAD` dans le dossier du projet, la quatrième refusée pour « dossier cible non propre ». Les deux copies mergées modifiaient le même module ; Git n'a rien vu, l'application ne démarrait plus. Retrouver laquelle était fautive a coûté plus que les huit clics économisés.

## Ce qui casse

- **L'état « prêt » est calculé contre un master qui n'existe plus après le premier merge.** La prévision de conflits (`integrationConflicts`) est mise en cache par couple de commits et compare chaque copie à master, jamais les copies entre elles (`server/worktrees.ts:635-652`). Dès la copie A intégrée, les forecasts de B, C, D sont périmés.
- **Toute la sécurité actuelle repose sur une confirmation par empreinte** (`prepare`/`begin`, `server/worktrees.ts:935-962`) : le token saute si `targetHead` a bougé. L'automatisation contourne précisément ce garde-fou.
- **Un conflit laisse la copie à moitié mergée** (`updateFromTarget`, lignes 674-677) et un merge raté dans master y reste, « sans reset automatique » (`SPEC.md:331`, `worktrees.ts:977`). Le dossier du projet est le pire endroit pour ça : les sessions en mode partagé y travaillent.
- **Aucun test n'est exécuté entre deux merges.** Le code vient d'agents ; les conflits sémantiques, pas textuels, sont le risque réel. La pause humaine par copie est aujourd'hui le seul filtre.

## Signal avant-coureur

Première opération avec `error` non nul suivie d'un `targetDirty > 0` sur master (`worktrees.ts:509-515`).

## Ce qui me ferait changer d'avis

Une simulation de la chaîne complète (A, puis B sur le résultat de A, etc.) dans un index temporaire, sans conflit, **et** la commande de test du projet exécutée avec succès après chaque merge, le bouton s'arrêtant au premier échec. Sans ces deux mesures, non.

### E — Exécutant (codex · gpt-6.1-sol · effort xhigh)

**Livrons « Intégrer les copies prêtes », avec une file séquentielle et arrêt au premier blocage.** Ressources : le développeur actuel, maîtrisant TypeScript, React et Git ; trois jours pour une première version vérifiée.

1. **Demain : construire l’orchestrateur serveur.** Fixer la liste et l’ordre des copies visant master. Accepter uniquement les copies entièrement commitées, avec agents au repos et master propre. Réutiliser les primitives existantes : la mise à jour crée déjà automatiquement son commit lorsqu’elle réussit sans conflit ([worktrees.ts](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/server/worktrees.ts:665)). Premier résultat : deux copies indépendantes intégrées successivement sur un dépôt jetable.

2. **Jour 2 : sécuriser l’enchaînement et ajouter le bouton.** Adapter le verrouillage pour couvrir mise à jour, validation et intégration. Recontrôler les SHA après chaque copie : chaque intégration modifie master. Préparer chaque merge après la mise à jour et attendre son statut final ; l’API répond actuellement avant sa fin. Exiger un fast-forward vers master après actualisation. Afficher l’ordre, la progression et la cause d’arrêt dans le panneau existant ([Worktrees.tsx](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/web/src/Worktrees.tsx:217)).

3. **Jour 3 : vérifier les échecs.** Étendre les tests existants : conflit introduit par la première copie, agent redémarré, master modifié, redémarrage serveur. Vérifier qu’aucune copie suivante ne démarre et que master reste exploitable ([worktrees.test.mjs](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/tests/worktrees.test.mjs:468)).

Promettre une résolution autonome des conflits dès cette version est irréaliste : cela exige des décisions fonctionnelles et une validation que Git ne fournit pas. Un conflit conserve la résolution dans la copie, puis demande une reprise explicite.

**Je changerais d’avis sur la priorité si dix intégrations réelles chronométrées montraient moins de deux minutes cumulées consacrées aux clics d’enchaînement.**

## Relectures

### Relecture par D — Contrarien (claude · fable · effort xhigh)

1. A : La plus ancrée dans le code : invalidation du cache et du jeton de confirmation à chaque merge, dépendance à l'ordre, absence de type d'opération pour signaler l'échec, verrouillages répétés. Trace la vraie ligne rouge (le push) et donne un seuil de volume mesurable sur des données existantes. Recommandation un peu hédgée (« boucle mince ou rien »), mais c'est la lecture des coûts la plus utile pour décider.
2. C : Seule réponse à requalifier le problème : la mise à jour avec master n'est pas un prérequis Git, c'est un outil de résolution de conflits ; retirer cette étape du parcours sans conflit supprime l'essentiel des clics sans construire d'automate. Options comparées, recommandation nette, critère de réversion précis. Moins profonde que A sur ce que coûterait réellement l'orchestration si on la faisait quand même.
3. E : Plan d'exécution solide et conscient de pièges réels (recontrôle des SHA, API qui répond avant la fin, verrou étendu, tests de reprise, pas de résolution autonome des conflits). Mais il présuppose le oui sans peser l'alternative, trois jours est lourd pour un outil mono-utilisateur, et le critère de réversion ne se mesure qu'après avoir construit.
4. B : Vision séduisante mais hors contexte : raisonne sur dix à vingt fois plus de conversations alors que l'outil sert une personne, ignore l'ordre, les échecs à mi-course, l'irréversibilité et le fait que « agents au repos » contredit l'idée d'intégrer pendant que les agents produisent. Critère de réversion inapplicable sans avoir déjà livré.
Angle mort : Aucune réponse n'examine l'interaction entre le lot et les sessions d'agents vivantes, qui sont pourtant la raison d'être de Cerebro. L'intégration exige des agents au repos et verrouille les copies : un lot de N copies gèle toutes les conversations pendant toute sa durée, et chaque merge de master dans une copie change les fichiers sous les yeux de l'agent qui y travaille, ce qui peut invalider son contexte ou ses modifications en cours. Le coût réel d'un « Tout intégrer » n'est pas en clics mais en temps de production d'agents perdu et en copies dont l'état a bougé sans que la conversation le sache. B promet même l'inverse (intégrer pendant que le développeur réfléchit) sans voir la contradiction avec la garde existante.
Ce que tous ont manqué : Toutes raisonnent en « exécuter la séquence » ou « ne pas l'exécuter », et manquent la troisième voie : un plan à sec puis une seule confirmation. Cerebro prédit déjà les conflits contre master ; on peut simuler l'intégration des copies prêtes dans l'ordre choisi (git merge-tree ou merge dans une référence temporaire) sans toucher aux worktrees, afficher le résultat (quelles copies passent, dans quel ordre, laquelle bloque et sur quels fichiers), puis exécuter ce plan précis après une confirmation unique portant sur un état connu. Cela résout le problème du jeton de confirmation soulevé par A, supprime les clics visés par B et E, garde la simplicité voulue par C, et rend l'ordre explicite au lieu de le subir. Aucune réponse ne le propose, ni ne suggère de choisir l'ordre pour minimiser les conflits plutôt que de le fixer arbitrairement.

### Relecture par C — Premiers principes (codex · gpt-6.1-sol · effort xhigh)

1. E : La plus exploitable : file séquentielle, préconditions, revalidation, fast-forward et arrêt explicite. Elle distingue correctement automatisation du parcours et résolution des conflits, malgré un calendrier peu étayé.
2. D : Expose les risques essentiels, notamment les incompatibilités fonctionnelles sans conflit Git, et exige des tests. Mais l’automatisation ne contourne pas nécessairement les garde-fous : elle peut les réappliquer.
3. A : Bonne analyse du coût de maintenance et de l’intérêt d’une solution minimale. Sa réversibilité est toutefois exagérée : reset --hard exige des précautions, et pousser ne rend pas toute correction impossible.
4. B : Explique bien le bénéfice potentiel et la nécessaire réévaluation séquentielle. Mais sa recommandation repose sur un changement d’échelle hypothétique et reporte les tests alors qu’ils conditionnent la fiabilité du dispositif.
Angle mort : Le statut « prête » reste insuffisamment défini : une copie committée, sans conflit et passant les tests peut contenir un changement incomplet, indésirable ou alternatif à une autre copie. Il manque une décision explicite sur les contributions réellement acceptées.
Ce que tous ont manqué : Une autre architecture permettrait de construire et tester réellement le lot dans un worktree d’intégration temporaire, puis de promouvoir son résultat vers master en une seule opération, sous verrou et après revalidation. Cela éviterait de laisser master partiellement intégré lorsqu’une copie bloque.

### Relecture par B — Expansionniste (codex · gpt-6.1-sol · effort xhigh)

1. C : Identifie que la mise à jour préalable n’est pas toujours nécessaire et propose une simplification proportionnée, tout en distinguant conflits Git et compatibilité fonctionnelle.
2. E : Propose un enchaînement concret avec verrouillage, revérification et arrêt au blocage. La priorité de livraison et l’estimation de trois jours restent peu étayées.
3. D : Souligne utilement les conflits sémantiques et l’évolution de master, mais suppose à tort que l’automatisation contourne nécessairement les protections existantes.
4. A : Analyse bien le coût de maintenance, mais minimise dangereusement les risques de reset --hard et confond confirmation automatisée et absence de protection.
Angle mort : Le statut « prêt » reste insuffisamment défini : absence de blocage Git, validation fonctionnelle et volonté d’intégrer sont trois conditions distinctes. Les dépendances entre travaux devraient aussi déterminer la sélection et l’ordre.
Ce que tous ont manqué : Aucune ne développe la promotion atomique du lot : préparer et tester les intégrations dans un worktree temporaire, puis avancer master une seule fois après revalidation. Cela éviterait un master partiellement intégré ; la simulation proposée par D ne précise pas cette garantie.

### Relecture par A — Mainteneur (claude · fable · effort xhigh)

1. D : Identifie le vrai risque (conflits sémantiques sans test entre merges, prévisions périmées après le premier merge, master laissé à moitié mergé) avec des références précises, et donne des conditions concrètes et vérifiables pour dire oui. Surestime un peu le contournement du garde-fou : un orchestrateur peut re-préparer chaque merge avec un targetHead frais.
2. E : Plan le plus actionnable et techniquement juste : file séquentielle, arrêt au premier blocage, recontrôle des SHA après chaque intégration, attente du statut final, exigence de fast-forward qui empêche master de rester sale. Manque le filtre fonctionnel : aucun test entre deux copies, donc l'automate enchaîne des merges textuellement propres mais potentiellement incompatibles.
3. C : Remet utilement en cause la prémisse et propose l'option la moins chère, avec une comparaison claire des trois options. Mais juge la mise à jour avec master « inutile » alors qu'elle est précisément ce qui permet un fast-forward et une validation du résultat combiné avant de toucher master ; et ne répond pas au besoin multi-copies, qui reste à un parcours par copie.
4. B : Vision cohérente et quelques points justes (réévaluation contre le nouveau master, tests sur le résultat combiné), mais presque aucune analyse des modes de défaillance ni des garde-fous à construire ; l'argument repose sur une projection à vingt conversations qui n'est pas la situation décrite. Le moins utile pour décider.
Angle mort : Aucune réponse ne définit ce que « prête » veut dire ni qui le décide. Si c'est le développeur après relecture du diff, les clics sont une fraction négligeable du temps de relecture et le bouton gagne peu ; si c'est l'agent ou un simple « tout est commité », le bouton livre dans master du code non relu et la question devient « quel filtre remplace la pause humaine », pas « combien de clics on économise ». Les critères de changement d'avis de C et E mesurent le temps de clics sans isoler le temps de relecture, donc ne tranchent pas cette ambiguïté.
Ce que tous ont manqué : Personne n'assemble la conception qui dissout le désaccord entre C, D et E : mettre à jour la copie avec master, lancer la commande de test du projet dans la copie sur le résultat combiné, puis seulement fast-forwarder master. La mise à jour cesse d'être du « travail Git inutile » (C), master ne peut jamais rester à moitié mergé (scénario de D), et le filtre fonctionnel exigé par D s'exécute sans jamais merger dans master. C'est aussi ce qui règle le cas des copies qui se contredisent sans conflit textuel, puisque chaque copie est testée contre le master issu des précédentes.

### Relecture par E — Exécutant (codex · gpt-6.1-sol · effort xhigh)

1. C : Meilleur cadrage : la mise à jour préalable n’est pas une obligation Git. Propose une simplification proportionnée à l’usage personnel et rappelle la réévaluation nécessaire après chaque intégration.
2. D : Analyse concrète des échecs partiels et des incompatibilités fonctionnelles, avec des conditions de sécurité utiles. Exagère toutefois : automatiser n’implique pas de contourner les vérifications existantes.
3. A : Bon examen du coût de maintenance et de l’ordre des opérations. Mais les jetons restent utiles si renouvelés, et présenter reset --hard comme une annulation sans risque est trompeur.
4. B : Explique bien les bénéfices possibles d’une file séquentielle, mais les fonde sur un changement d’échelle hypothétique. Repousse les tests à plus tard et définit insuffisamment les copies admissibles.
Angle mort : Le statut « prête » reste insuffisamment défini : un travail committé, sans conflit et même testé n’est pas nécessairement achevé ou approuvé. Il manque une sélection explicite des contributions et de leurs dépendances avant toute automatisation.
Ce que tous ont manqué : Préparer réellement le lot dans un worktree temporaire, y fusionner et tester les contributions, puis avancer master une seule fois après vérification de son état. D évoque une simulation, sans développer cette publication du résultat validé qui éviterait un master partiellement intégré.

## Classement agrégé

| Position | Lettre | Conseiller | Rang moyen | Relectures |
| --- | --- | --- | --- | --- |
| 1 | C | Premiers principes | 1,75 | 4 |
| 2 | D | Contrarien | 2 | 4 |
| 3 | E | Exécutant | 2 | 4 |
| 4 | A | Mainteneur | 2,75 | 4 |
| 5 | B | Expansionniste | 4 | 4 |

<!-- rangs moyens : Premiers principes 1.75, Contrarien 2, Exécutant 2, Mainteneur 2.75, Expansionniste 4 -->
