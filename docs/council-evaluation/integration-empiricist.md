# Council : Faut-il automatiser entièrement l'intégration des copies de travail de Cerebro, avec un bouton « Tout intégrer » qui enchaîne, pour chaque copie, la mise à jour avec master et le merge dans master ?

Lancé le 2026-10-30T21:26:37.799Z · statut : succeeded · chairman : claude · opus · effort xhigh · lecture du projet

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

- **Le « sans intervention » n'est pas réaliste.** A, B, C et E le disent, et D le reconnaît aussi puisqu'il met les copies en conflit dans une file à part. Résoudre un conflit demande de comprendre ce que chaque changement voulait faire.
- **« Prête » veut seulement dire « fusionne sans conflit Git ».** Deux copies qui fusionnent proprement peuvent quand même casser master une fois réunies (A, B, C, E). Avoir N branches qui passent ne garantit pas un master qui passe.
- **Chaque intégration change `targetHead`.** Pour les copies suivantes, les prévisions de conflit et les jetons de confirmation ne sont plus valables, et il faut tout recalculer copie par copie (tous les conseillers).
- **La prévision compare chaque copie au master actuel, une par une.** Elle ne voit donc pas les conflits entre deux copies prêtes, qui n'apparaissent qu'une fois la première intégrée (E, A).
- **Le moteur fait déjà l'essentiel :** commit automatique quand une mise à jour passe sans conflit, verrous, contrôle d'empreinte Git (B, C, D, E).
- **Personne ne connaît les deux chiffres qui décident de l'utilité du bouton :** combien de copies sont réellement prêtes en même temps, et à quelle fréquence on tombe sur un conflit.

### Désaccords

- **Faut-il construire le bouton ?** D veut une chaîne d'intégration autonome. C propose une file qui s'arrête au premier blocage, en trois jours. E veut d'abord mesurer, avec des seuils d'abandon. B propose de ne rien faire. A refuse, sauf si les tests tournent entre chaque merge. **Ce qui les sépare, c'est le volume qu'ils supposent.** D part sur dix fois plus de conversations sans aucune donnée, alors que B demande la preuve d'un coût réel. Faute de données, **c'est la méthode de E qui l'emporte.** D finit dernier à juste titre : laisser les autres copies avancer pendant qu'une est en conflit aggrave ce conflit, et confier la résolution aux agents supprime le dernier regard humain.
- **Faut-il toujours mettre la copie à jour avant de l'intégrer ?** La proposition le prévoit, et le `--ff-only` de C l'impose. B et E montrent que c'est inutile sans conflit : l'interface réserve déjà cette étape aux conflits prévus, et `updateFromTarget` refuse une copie déjà à jour. **B a raison.** Mettre à jour systématiquement double les commits de merge (un dans chaque sens) et ne fait que déplacer l'endroit où l'on s'arrête.
- **La confirmation par copie protège-t-elle encore quelque chose ?** Pour A, la re-préparation automatique la rend décorative. B, C et D répondent que le serveur continue de vérifier l'état Git. **Chacun a raison en partie.** L'empreinte protège contre un état qui change entre la préparation et l'exécution, pas contre l'inattention. Ce qu'un lot supprime, c'est le regard humain sur chaque copie, pas le contrôle Git. La question est donc de savoir ce qui remplace ce regard.
- **Comment juger qu'un lot a servi ?** E ne compte que les lots allés au bout. D répond, en relecture, qu'un lot interrompu fait déjà gagner du temps. **D a raison, à une condition :** l'arrêt ne doit pas laisser master dans un état intermédiaire. Or c'est précisément ce que produit la proposition telle qu'elle est écrite.

### Angles morts

**Points apparus seulement dans les relectures :**
- **La file de merge classique.** On empile les merges sur une branche candidate dans un worktree jetable, on lance les vérifications sur le résultat cumulé, et on n'avance master en fast-forward que si tout passe et que master n'a pas bougé entre-temps. C, D et E l'ont trouvée chacun de leur côté, et le pré-vol proposé par A s'en rapproche. A citait Bors et Zuul sans en tirer cette conception.
- **Un merge raté laisse les conflits dans master, sans retour en arrière** (constat de E, `server/worktrees.ts:973-977`). Une chaîne qui échoue au troisième merge laisse donc master avancé de deux copies et en conflit, ce qui est pire que la situation actuelle.
- **Les données existent déjà** dans `worktree_operations`, et personne ne propose de les consulter avant de décider (E).
- **L'étape 1 reste manuelle.** Le bouton ne touche pas au commit avec séparation des fichiers déjà modifiés. Le gain se limite donc à une ou deux actions par copie sans conflit.
- **« Prête » ne veut pas dire « souhaitée dans master » (B).** Un bouton qui prend toutes les copies prêtes embarquerait aussi les essais et le travail non relu.
- **Le lot interrompu n'a pas de règle (C).** Rien ne dit ce qu'on garde, ni comment on reprend.
- **Merge ou rebase (A).** La proposition crée deux commits de merge par copie.

**Ce que personne n'a vu :**
- **D'où viennent les « vérifications » ?** Cerebro pilote des dépôts quelconques. Sans commande de vérification configurée pour chaque dépôt, la branche candidate ne prouve que la fusion textuelle, et l'objection de A reste entière. Pendant que les tests tournent, les verrous sont aussi tenus.
- **La branche candidate assouplit la règle des agents au repos côté copies.** On merge le commit relevé au moment du plan. Seul master doit rester inchangé jusqu'au fast-forward.
- **On peut simuler toute la chaîne en mémoire.** `git merge-tree --write-tree` suivi de `git commit-tree` permet, sans worktree, d'afficher avant toute action l'ordre, les copies qui passent et celle qui entre en conflit avec laquelle.

### Recommandation

**Non au bouton « Tout intégrer » tel qu'il est formulé.** Trois raisons :
1. Comme il enchaîne directement dans master, un échec en cours de route laisse master partiellement intégré et en conflit, sans retour en arrière.
2. Sans conflit, il ajoute une mise à jour inutile. Avec conflit, il ne fait que déplacer l'endroit où l'on s'arrête.
3. Il intègre « toutes les copies prêtes », donc aussi celles que personne n'a choisies.

**Si les données montrent de vrais lots** (en médiane, au moins deux copies intégrées dans une même séance), construire **« Intégrer la sélection »** sous forme de file de merge :
1. **Sélection explicite** des copies, avec un ordre modifiable.
2. **Pré-vol en mémoire** de toute la chaîne avec `merge-tree`, puis affichage du plan. Une seule confirmation sur ce plan, avec le résumé des changements de chaque copie : c'est ce qui remplace le regard copie par copie que A veut préserver.
3. **Construction de la candidate** dans un worktree jetable, à partir des commits relevés au moment du plan, sans mettre les copies à jour.
4. **Lancement de la commande de vérification** configurée pour le dépôt. S'il n'y en a pas, l'écran le dit clairement.
5. **Fast-forward de master** seulement si master n'a pas bougé et que tout est vert. Sinon, on ne touche pas à master. On propose d'intégrer les premières copies qui passent, sur choix explicite. La copie en conflit repart dans le parcours manuel actuel, et la résolution peut être confiée à sa conversation.

Le parcours actuel, copie par copie, reste en place. Pas de résolution de conflits par les agents sans intervention humaine dans cette version.

**Si la médiane vaut 1, ne rien construire.** Au plus, suivre B et alléger la confirmation quand aucun conflit n'est prévu.

**Pourquoi je m'écarte du classement :** E, classé premier, a la bonne méthode, et je reprends son expérience. Mais la conception retenue ne vient d'aucune réponse initiale : elle ressort de trois relectures indépendantes. Elle répond mieux à l'objection principale de A (un master qui ne compile plus) que la file de C, qui merge directement dans master. Les tests sur un lot mixte prévus par C au jour 3 restent valables, appliqués à la candidate.

### Première action

**Interroger la table `worktree_operations` de la base locale de Cerebro, sans écrire de code :**
- regrouper les intégrations réussies par séance (par exemple par fenêtres de deux heures) pour obtenir la taille médiane des lots ;
- compter les mises à jour et les intégrations en échec ;
- croiser avec `git log master` pour repérer les correctifs ou reverts faits dans l'heure qui suit une intégration.

**Règle de décision fixée avant de regarder les chiffres :**
- **médiane = 1** : on abandonne ;
- **médiane ≥ 2** : pendant deux à trois semaines, on lance le script de E à chaque fois qu'au moins deux copies sont prêtes, avant d'écrire la file. Ce script fait des merges successifs dans un worktree jetable sans toucher master. On l'étend pour lancer les tests du dépôt sur le résultat cumulé, afin de mesurer aussi les casses que Git ne signale pas.

Si l'historique est trop court ou ne permet pas de reconstituer les lots, c'est ce script qui devient la première action.

## Avis

### A — Contrarien (claude · fable · effort xhigh)

**Pré-mortem, octobre 2027.** Le bouton existe encore, mais on ne l'utilise plus qu'avec une seule copie, c'est-à-dire l'ancien parcours. Il a été abandonné l'après-midi où quatre copies « prêtes » sont entrées d'un coup dans master : chacune mergait proprement, master ne compilait plus. Aucun test n'avait tourné entre les merges ; il a fallu bisecter quatre commits de merge pour voir que la copie B appelait une fonction que la copie A venait de renommer.

**Ce qui casse.**
- « Prête » signifie *textuellement* mergeable. La prévision `integrationConflicts` est un `merge-file` simulé, mis en cache par couple de commits (`server/worktrees.ts`, `forecast`, l. 632-651). Dès que la première copie entre dans master, `targetHead` change et toutes les prévisions restantes sont périmées : l'enchaînement découvre les conflits en route, pas avant.
- Le jeton de confirmation est lié à une empreinte Git et refuse l'exécution si l'état a changé (`prepare`/`begin`, l. 935-955). Après le premier merge, chaque copie suivante doit être re-préparée en silence : on confirme des états que personne n'a vus. La protection devient décorative.
- L'intégration est le seul moment où un humain relit du code écrit par des agents. Les merges dans la copie passent déjà en `--no-verify` (l. 676, 704) ; master n'a que ses hooks Git (`SPEC.md` l. 331), aucun test entre deux merges. C'est le « merge all » que GitHub, Bors et Zuul ont remplacé par des files de merge, parce que N branches vertes ne font pas un master vert.
- L'ordre est choisi par la boucle, pas par le développeur ; le gros refactor doit pourtant passer avant les petits correctifs.
- Les clics économisés sont ceux du cas sans conflit. Le coût réel, c'est le conflit, toujours résolu à la main ou par l'agent de la copie qu'il faut relancer : le lot s'arrête, on repart.

**Signal avant-coureur :** des commits « fix après intégration » ou des reverts dans master dans l'heure suivant un lot ; des opérations `failed` après N succès dans `worktree_operations`.

**Ce qui me ferait changer d'avis :** sur trente intégrations réelles, zéro écart entre la prévision et le résultat de `update-from-target`, et la suite de tests de master lancée entre chaque merge de la chaîne, arrêtant le lot au premier rouge.

### B — Premiers principes (codex · gpt-6.1-sol · effort xhigh)

**Non. Conservez l’intégration explicite par copie.** Le problème est de ramener du travail choisi et compatible dans master. Réduire les clics n’est utile que si ces clics constituent un coût réel.

Première simplification : **mettre systématiquement chaque copie à jour avec master est inutile**. Git peut intégrer directement une branche sans conflit. L’interface propose déjà cette voie et réserve la mise à jour aux conflits prévus ([Worktrees.tsx](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/web/src/Worktrees.tsx:291)). Le parcours décrit comme quatre étapes obligatoires surestime donc le travail nécessaire.

Les contraintes réelles sont ailleurs : changements enregistrés, dépôts propres, agents au repos et références encore valides. Chaque intégration modifie master ; la copie suivante doit être réévaluée. Le serveur refuse déjà une action lorsque l’état Git a changé depuis sa préparation ([worktrees.ts](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/server/worktrees.ts:947)). Surtout, deux changements peuvent fusionner sans conflit et casser ensemble le comportement du logiciel. « Prête à merger » ne signifie pas « validée avec les autres ».

Comparons les deux options simples :

- **Ne rien faire : recommandé aujourd’hui.** Le chemin direct existe ; aucun temps perdu mesuré ne justifie un orchestrateur supplémentaire.
- **Retirer quelque chose :** si les clics deviennent pénibles, supprimer la confirmation supplémentaire après « Intégrer » serait une réduction plus petite, tout en conservant les contrôles serveur et le choix individuel de la copie.

« Tout intégrer » ajoute une gestion de l’ordre, des interruptions et des reprises, sans supprimer le travail qui exige un jugement.

**Je changerais d’avis si un relevé de dix jours montrait quotidiennement plus de dix minutes de manipulations mécaniques sur des lots déjà relus, sans aucun conflit ni décision entre deux intégrations.**

### C — Exécutant (codex · gpt-6.1-sol · effort xhigh)

**Livrons « Intégrer les copies prêtes », une file séquentielle qui s’arrête au premier blocage.** Une intégration sans intervention garantie est irréaliste : résoudre un conflit exige parfois de comprendre l’intention des changements, et deux branches peuvent fusionner proprement tout en cassant l’application.

Le moteur fournit déjà la mise à jour avec commit automatique lorsqu’elle réussit, les contrôles d’obsolescence et le verrouillage ([server/worktrees.ts](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/server/worktrees.ts:665)). Il faut orchestrer ces primitives.

**Ressources : un développeur maîtrisant Git, TypeScript et React ; trois journées comme budget initial.**

1. **Demain matin : figer le périmètre.** Copies déjà commitées, même dépôt et même cible, master propre, agents au repos. Afficher les exclusions et l’ordre d’intégration ; une confirmation lance le lot. Les dépendances connues entre branches déterminent l’ordre.
2. **Demain après-midi : obtenir une première preuve côté serveur.** Pour chaque copie : relire l’état, mettre à jour si nécessaire, arrêter sur conflit, exécuter les vérifications, puis intégrer avec `--ff-only`. Maintenir le verrou sur la copie et master pendant cette chaîne. Recalculer l’état après chaque intégration : les confirmations existantes deviennent obsolètes lorsque master avance.
3. **Jour 2 : ajouter le bouton et le suivi.** Statut par copie, motif d’arrêt, journal des commits, reprise explicite après correction. Le panneau distingue déjà les étapes et blocages ([Worktrees.tsx](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/web/src/Worktrees.tsx:48)).
4. **Jour 3 : valider les interruptions.** Étendre les tests existants aux lots : deux copies compatibles intégrées, troisième conflictuelle arrêtée, quatrième intacte, master contenant exactement les commits attendus ([tests/worktrees.test.mjs](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/tests/worktrees.test.mjs:118)). C’est le premier résultat vérifiable.

Je changerais d’avis si trois des vingt premiers lots exigeaient une réparation manuelle de master malgré des contrôles verts.

### D — Expansionniste (codex · gpt-6.1-sol · effort xhigh)

**Oui. « Tout intégrer » doit devenir le point d’entrée d’une véritable chaîne d’intégration autonome.**

Avec dix fois plus de conversations parallèles, le développeur devient le goulot d’étranglement s’il doit accompagner chaque branche jusqu’à master. Automatiser cette jonction permet d’exploiter davantage d’agents, de découper les tâches plus finement et de multiplier les expériences. Le gain décisif est le nombre de travaux que l’on ose lancer parce que leur intégration ne réclamera plus une tournée de manipulations.

Les briques existent : une mise à jour sans conflit crée déjà automatiquement son commit ([server/worktrees.ts](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/server/worktrees.ts:665)), et l’intégration vérifie les empreintes Git et verrouille les espaces concernés ([server/worktrees.ts](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/server/worktrees.ts:947)). Construisons une file qui actualise chaque copie depuis le master courant, exécute les validations, intègre, puis recalcule l’état de la suivante. Une copie conflictuelle rejoint une file de résolution pendant que les autres avancent.

L’opportunité adjacente est de boucler directement avec les agents : confier le conflit à la conversation d’origine, vérifier sa résolution, puis réinsérer la copie dans la file. Les conversations et leurs branches restent utilisables après intégration ([README.md](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/README.md:871)) : cette continuité permet de transformer « produire, intégrer, poursuivre » en cycle permanent. Le bouton amorce ainsi une capacité de production qui peut croître sans augmenter proportionnellement la coordination humaine.

**Ce qui me ferait changer d’avis :** sur 30 lots d’au moins cinq copies, le temps humain médian par copie intégrée, corrections dans les 24 heures comprises, diminue de moins de 50 % face au parcours actuel.

### E — Empiriste (claude · fable · effort xhigh)

## Observé (source vérifiable)

- L'intégration est un vrai `git merge` dans le dossier de master ; s'il échoue, les conflits restent dans master, sans reset (`server/worktrees.ts:973-977`, `SPEC.md:331`).
- L'empreinte qui autorise un merge inclut `targetHead` (`server/worktrees.ts:520`) : après chaque copie intégrée, la suivante doit être ré-inspectée et re-préparée.
- La prévision de conflits est calculée contre le master **actuel**, en arrière-plan, une copie à la fois (`server/worktrees.ts:635-652`, `SPEC.md:350`). Elle ne voit pas les conflits **entre deux copies prêtes**, qui n'apparaissent qu'une fois la première intégrée.
- `updateFromTarget` refuse une copie déjà à jour (`server/worktrees.ts:670`) : l'enchaînement doit gérer ce cas.

## Non vérifié

- Nombre de copies prêtes simultanément : aucune donnée d'usage dans le dépôt.
- Fréquence des conflits réels : non vérifié.

## Hypothèse décisive

Le bouton n'a de valeur que si, dans la majorité des lots de ≥2 copies prêtes, la chaîne séquentielle (master→copie, copie→master, copie suivante) se termine sans conflit. Sinon il **déplace** le point d'arrêt au lieu de le supprimer : master déjà avancé par les copies précédentes, une copie bloquée en merge, et la même résolution manuelle qu'aujourd'hui.

## Expérience la moins chère (zéro ligne dans Cerebro)

Script shell : worktree jetable sur master ; pour chaque branche `cerebro/session-*` en avance, `git merge --no-commit` ; si propre, commit et continuer ; sinon noter le conflit et `merge --abort`. Le lancer chaque fois que ≥2 copies affichent « Prêt à intégrer », pendant trois semaines ; consigner taille du lot et issue.

## Seuil d'abandon

- Taille médiane de lot = 1 : rien à enchaîner, abandonner.
- Plus d'un lot sur quatre s'arrête sur un conflit : abandonner la version « sans intervention » ; au mieux, un enchaînement qui s'arrête **avant** le premier merge conflictuel.

## Ce qui me ferait changer d'avis

Un journal d'au moins dix lots montrant une taille médiane ≥3 et au plus un arrêt sur conflit, ou la table `worktree_operations` prouvant que les merges `status='failed'` représentent moins de 10 % des merges.

## Relectures

### Relecture par A — Contrarien (claude · fable · effort xhigh)

1. E : Le plus rigoureux : relève les faits décisifs (un merge raté laisse master en conflit sans reset, l'empreinte dépend de targetHead, la prévision ne voit pas les conflits entre copies prêtes), formule l'hypothèse qui conditionne la valeur du bouton, propose une mesure à coût nul et des seuils d'abandon. Seule faiblesse : pas de recommandation tranchée, il renvoie à la mesure.
2. C : Réponse la plus actionnable : refuse le « sans intervention » pour de bonnes raisons (intention des changements, conflits sémantiques) et conçoit une file qui s'arrête au premier blocage, recalcule l'état après chaque intégration, verrouille, passe par ff-only et se teste sur un lot mixte. Manque la question préalable : existe-t-il vraiment des lots de plusieurs copies prêtes ?
3. B : Conteste utilement la prémisse (la mise à jour systématique n'est pas nécessaire, le serveur rejette déjà l'obsolescence, deux branches peuvent fusionner proprement et casser l'application), mais conclut « ne rien faire » sans mesurer la friction que l'unique utilisateur, qui est le développeur, ressent déjà, et n'examine ni la reprise ni les mécanismes concrets.
4. D : Vision d'échelle sans ancrage dans le code réel : ignore l'état de master après un merge raté, les conflits entre copies et le recalcul obligatoire après chaque merge ; faire avancer les autres copies pendant qu'une est en conflit aggrave la situation de celle-ci ; le seuil de réfutation (30 lots d'au moins 5 copies) est hors de portée d'un outil mono-utilisateur.
Angle mort : Tous traitent la question comme de l'orchestration Git et aucun ne regarde le point de contrôle humain qu'un bouton de lot supprime : dans Cerebro le code vient d'agents, et la confirmation par copie avant « Intégrer » est le dernier moment où le développeur voit ce qui entre dans master. B suppose des « lots déjà relus » sans le concevoir, D veut explicitement retirer ce passage, C et E ne le mentionnent pas. La décision dépend pourtant de ce qui remplace cette relecture : résumé des diffs du lot, tests bloquants ou marque « relue » par copie.
Ce que tous ont manqué : Personne ne propose un pré-vol du lot entier avant de toucher master ou une copie : simuler la séquence complète (git merge-tree, ou un worktree jetable comme dans le script de E, mais intégré au produit) pour savoir à l'avance quelles copies passeront, laquelle entrera en conflit et avec qui, et choisir l'ordre qui minimise les conflits. Cela rend l'état « Prêt » vrai pour le lot, évite tout état partiel et transforme le bouton en « appliquer un plan vérifié ». Aucun non plus ne discute rebase contre merge, alors que l'enchaînement proposé produit un commit de merge par copie dans chaque direction.

### Relecture par B — Premiers principes (codex · gpt-6.1-sol · effort xhigh)

1. C : Meilleur compromis : file séquentielle, validations, réévaluation après chaque merge et arrêt au blocage. Proposition concrète, malgré un budget peu étayé.
2. E : Éclaire la décision par une expérience peu coûteuse et des données d’usage. Ses seuils sont arbitraires : un lot interrompu peut néanmoins économiser du temps.
3. A : Analyse solide des régressions sémantiques et des prévisions périmées, mais affirme sans preuve que l’intégration constitue la seule revue humaine et exagère l’inutilité des confirmations.
4. D : Vision cohérente d’une file autonome, mais fondée sur une croissance hypothétique des usages. Sauter les copies conflictuelles sans traiter leurs dépendances fragilise la proposition.
Angle mort : La définition opérationnelle d’une copie « prête » reste insuffisante : branche propre, commits présents et agent au repos ne garantissent pas un travail terminé et approuvé. Une sélection explicite des travaux souhaités dans master doit précéder l’automatisation.
Ce que tous ont manqué : Toutes omettent une solution intermédiaire simple : « Mettre à jour puis intégrer cette copie », avec arrêt sur conflit et validation avant intégration. Elle permettrait de mesurer le gain de clics avant de construire une orchestration globale.

### Relecture par D — Expansionniste (codex · gpt-6.1-sol · effort xhigh)

1. B : Remet en cause la mise à jour systématique et privilégie une simplification proportionnée de l’existant. C’est le meilleur cadrage décisionnel, malgré un seuil d’adoption arbitraire.
2. E : Distingue clairement faits, inconnues et hypothèses, puis propose une expérience peu coûteuse. Mais ses seuils confondent réussite complète du lot et utilité réelle.
3. C : Propose une file interrompable concrète, avec revalidation et vérifications. Cependant, la décision de livrer et le budget de trois jours précèdent la démonstration du besoin.
4. A : Expose bien les incompatibilités sans conflit Git. Mais suppose sans preuve que l’intégration constitue l’unique relecture humaine et assimile abusivement revalidation automatique et protection décorative.
Angle mort : Le bénéfice d’un lot partiellement réussi reste sous-évalué : s’arrêter sur un conflit après plusieurs intégrations peut déjà économiser du temps et de l’attention. Il faut mesurer ce gain et le coût de reprise, plutôt que décider principalement selon la fréquence des lots entièrement réussis.
Ce que tous ont manqué : Préparer et tester le lot sur une branche temporaire, puis avancer master seulement si l’ensemble réussit et si son état initial reste inchangé. Cette alternative évite de laisser master partiellement intégré. E envisage un worktree jetable pour l’expérience, mais aucune réponse n’en fait une option de fonctionnement.

### Relecture par E — Empiriste (claude · fable · effort xhigh)

1. A : La plus juste et la plus profonde : montre, code à l'appui, que « prête » n'est que textuel, que les prévisions et jetons de confirmation deviennent périmés dès le premier merge, que rien ne teste master entre deux merges, et que le coût réel est le conflit, pas le clic. Critères de réversibilité précis et exploitables.
2. C : Réponse la plus directement actionnable : un périmètre réduit (file séquentielle, arrêt au premier blocage, recalcul d'état, vérifications, verrous, tests de lot) qui neutralise l'essentiel des risques soulevés par A. Légère tension sur le --ff-only qui impose une mise à jour systématique, et budget de trois jours un peu lourd pour un outil mono-utilisateur.
3. B : Sobre et correcte : rappelle que la mise à jour préalable n'est pas obligatoire, que le serveur refuse déjà les états périmés, et que « mergeable » n'est pas « validé ensemble ». Mais s'appuie sur l'absence de mesure plutôt que sur une analyse du coût réel, et l'alternative proposée (retirer une confirmation) est marginale.
4. D : Vision séduisante mais peu rigoureuse : l'argument « dix fois plus de conversations » est posé sans preuve pour un outil mono-utilisateur, les risques de casse sémantique et la perte du seul point de relecture humaine sont ignorés, et le critère de réversibilité mesure le temps gagné, pas la santé de master.
Angle mort : Aucune réponse ne propose le schéma classique des files de merge : enchaîner les merges sur une branche candidate temporaire, exécuter les vérifications dessus, puis avancer master en fast-forward uniquement si tout est vert. Cela règle d'un coup le problème « N branches vertes, master rouge », évite les lots partiels où master reste dans un état intermédiaire, rend l'annulation triviale (on jette la candidate) et dispense d'un cycle de tests complet entre chaque merge sur master lui-même. A cite Bors et Zuul sans en tirer cette conséquence de conception, C et D intègrent directement dans master.
Ce que tous ont manqué : Toutes raisonnent sur des hypothèses ou des mesures futures (relevé de dix jours, trente lots) alors que l'application enregistre déjà ses opérations : combien de copies sont réellement prêtes en même temps, à quelle fréquence la prévision annonce un conflit, combien d'intégrations sont suivies d'un correctif. Personne ne propose de consulter cet historique avant de décider, alors que la réponse dépend presque entièrement de la taille typique des lots et du taux de conflit. Aucune ne relève non plus que le bouton ne touche pas l'étape 1 (commit avec séparation des fichiers préexistants), seule étape qui demande un jugement par copie et qui borne de toute façon le gain à deux clics par copie.

### Relecture par C — Exécutant (codex · gpt-6.1-sol · effort xhigh)

1. B : Remet utilement en cause la mise à jour systématique et demande un coût d’usage mesuré avant d’ajouter un orchestrateur. Recommandation proportionnée, malgré des alternatives un peu étroites.
2. E : Distingue faits et hypothèses et propose une expérience peu coûteuse. Toutefois, celle-ci mesure surtout les conflits textuels et ne reproduit pas exactement l’enchaînement proposé.
3. A : Identifie bien les incompatibilités fonctionnelles et le besoin de tests successifs. Mais suppose une revue humaine systématique et présente à tort la préparation automatique comme annulant la protection des empreintes Git.
4. D : Propose une architecture cohérente avec file, validations et réévaluation. Son enthousiasme repose cependant sur un volume hypothétique et étend prématurément le besoin à la résolution autonome des conflits.
Angle mort : Le contrat d’un lot partiellement réussi reste insuffisamment défini : quelles intégrations conserver après un échec, comment reprendre et comment revenir en arrière sans perdre de travail ? Plusieurs réponses signalent ce problème sans proposer de garantie précise.
Ce que tous ont manqué : Le push étant séparé, une autre option consiste à préparer un lot choisi dans un worktree d’intégration temporaire, tester le résultat cumulé, puis l’appliquer à master après revérification de son état. Cette automatisation évite de modifier progressivement master pendant la préparation du lot.

## Classement agrégé

| Position | Lettre | Conseiller | Rang moyen | Relectures |
| --- | --- | --- | --- | --- |
| 1 | E | Empiriste | 1,75 | 4 |
| 2 | B | Premiers principes | 2 | 4 |
| 3 | C | Exécutant | 2 | 4 |
| 4 | A | Contrarien | 2,75 | 4 |
| 5 | D | Expansionniste | 4 | 4 |

<!-- rangs moyens : Empiriste 1.75, Premiers principes 2, Exécutant 2, Contrarien 2.75, Expansionniste 4 -->
