# Council : Faut-il automatiser entièrement l'intégration des copies de travail de Cerebro, avec un bouton « Tout intégrer » qui enchaîne, pour chaque copie, la mise à jour avec master et le merge dans master ?

Lancé le 2026-10-30T21:32:11.953Z · statut : succeeded · chairman : claude · opus · effort xhigh · lecture du projet

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

- **Ce qui coûte, ce sont les conflits, pas les clics.** Aucun bouton ne supprime la résolution d'un conflit. A, C, D et E le disent explicitement. B l'admet implicitement, puisqu'il propose de renvoyer les conflits à la conversation.
- **« Toutes les copies prêtes » ne forme pas un ensemble stable.** Chaque merge fait avancer master, ce qui rend périmées les prévisions de conflits et les jetons des autres copies. Si on enchaîne, il faut donc traiter les copies **une par une**, avec **un recalcul après chaque merge**.
- **Un merge sans conflit ne garantit pas que le code fonctionne.** Toute chaîne automatique doit lancer la validation du projet (tests) entre deux intégrations.
- **Les conflits doivent se régler dans la copie, jamais dans master.**
- **Le push reste une action séparée.**
- **Il ne s'agit pas de construire un nouveau moteur, mais d'orchestrer l'existant.** Les briques sont là : mise à jour commitée automatiquement quand elle est propre, verrous, jetons à empreinte, contrôles bloquants.
- **La promesse « sans intervention » est irréaliste.** Même D, classé premier, transforme le bouton en « Intégrer les copies prêtes » avec arrêt sur blocage.
- **La décision doit reposer sur des données d'usage.** Chaque conseiller donne un critère chiffré qui le ferait changer d'avis, et les données sont déjà enregistrées dans `worktree_operations`.

### Désaccords

1. **Faut-il construire ?** B veut une file d'intégration, puis une boucle autonome. D veut un lot borné en 3 jours. C préfère ne rien faire, ou au mieux une version à une demi-journée. A propose de retirer une étape plutôt que d'en ajouter. E refuse sans simulation globale préalable. *Explication :* ils n'optimisent pas la même chose (le débit et l'attention pour B et D, le coût et le risque pour C et E, la simplicité pour A). Surtout, **personne n'a mesuré la fréquence réelle des lots**.

2. **Faut-il garder la mise à jour avant l'intégration ?** A veut la supprimer quand aucun conflit n'est prévu. C (en relecture) et E la défendent. **Je tranche contre A.** C'est cette mise à jour qui fait de master un ancêtre de la copie : le merge retour ne peut alors plus produire de conflit. Elle permet aussi de tester, dans la copie, exactement le contenu que master aura après le merge. La supprimer évite un merge mais replace le risque dans master.

3. **Le scénario de E est-il grave ?** A, B et D trouvent qu'il dramatise, C le classe premier. Chacun a à moitié raison :
   - le diagnostic de E est exact si l'on enchaîne, sans regard humain, un `git merge` standard dans master sans abandon automatique ;
   - mais trois relecteurs (A, C, D) ont trouvé indépendamment le remède structurel. Sa simulation globale, qui refuse tout le lot au moindre conflit, devient alors trop restrictive.

4. **Que faire quand une copie bloque : s'arrêter (A, D) ou continuer (B) ?** Tout dépend de savoir si un échec peut toucher master. Si l'on garantit que master est ancêtre de la copie avant le merge, une copie bloquée reste dans son état sans toucher master. Continuer devient alors sûr côté Git. Le seul risque restant vient des dépendances entre copies.

5. **La boucle autonome de B** est jugée hors sujet par tous les autres. Je suis d'accord.

**Sur le classement :** D est premier pour sa faisabilité. Mais son plan ne dit pas comment garantir que l'échec reste dans la copie (C l'a relevé) et ne pèse pas le coût contre le bénéfice. Je reprends la forme du plan de D, le dimensionnement de C et le diagnostic de E. Ce dernier est classé bon dernier, mais c'est lui qui a provoqué la meilleure idée du conseil.

### Angles morts

**Absents des réponses, relevés par les relectures :**
- **La confirmation sert de relecture du code produit par les agents** (E et C). « Prête » au sens Git (commitée, cible propre, agents au repos) ne veut pas dire « travail accepté » (A). Un lot sans intervention supprime le dernier regard humain sur le diff avant master, sans rien mettre à la place.
- **Master devient ancêtre de la copie** (A, C, D). Après une mise à jour réussie avec le master courant, et tant qu'un verrou empêche master de bouger, le merge retour ne peut produire aucun conflit textuel. Cela rend impossible le scénario « master bloqué au milieu d'un merge » (`MERGE_HEAD`) décrit par E.
- **L'ordre du lot** n'est défini par personne, alors que c'est lui qui décide quelles copies entreront en conflit.
- **Ce qui se passe quand le lot échoue à moitié** (B, D) : un résultat partiel est-il acceptable, et comment l'annuler ?
- **Ce que deviennent les choses après l'intégration** : le worktree, la branche, la conversation qui continue sur une branche déjà fusionnée, et les copies actives dont la base vieillit à chaque merge.
- **Une branche d'intégration temporaire** (B, C) permettrait de valider le résultat cumulé avant de faire avancer master une seule fois.

**Ce que personne n'a vu :**
- **Le `--ff-only` proposé par A, C et D abîme l'historique.** Après « merge de master dans la copie », une avance rapide fait suivre à master l'historique de la copie (le « foxtrot merge »). `git log --first-parent master` devient illisible et le revert d'une copie devient ambigu. **La garantie ne vient pas de l'avance rapide mais du fait que master est ancêtre de la copie.** Dans ce cas, un `git merge --no-ff` ne peut pas non plus produire de conflit. Il crée en plus un commit d'intégration par copie, annulable avec `git revert -m 1`. Cela répond directement au signal d'alarme de E (« un revert sans savoir quelle copie il visait »).
- **On peut annuler automatiquement un échec dans master.** La SPEC interdit l'abandon automatique parce qu'il pouvait y avoir un conflit à résoudre dans master. Avec cette garantie, il n'y a plus rien à résoudre dans master. Tout échec, par exemple un hook, peut donc déclencher un `git merge --abort` automatique.
- **Il faut tester dans la copie, pas dans master.** Après la mise à jour, la copie contient exactement ce que master contiendra. Master, lui, est le dossier du projet, où le développeur travaille peut-être.
- **Un verrou trop large bloque master longtemps.** Tenir master verrouillé pendant N passages de tests le bloque N fois la durée des tests. Le verrou doit couvrir uniquement la fenêtre entre la mise à jour et le merge. Si master avance pendant les tests, il faut refaire la mise à jour.
- **L'étape 1 n'est pas automatisable.** Le tri des fichiers déjà modifiés à la création de la copie demande un jugement. Un lot ne peut donc couvrir que des copies déjà commitées, et le gain réel est plus faible qu'annoncé.

### Recommandation

**Non au bouton tel qu'il est formulé.** « Tout intégrer sans intervention » supprime la seule chose qui ait de la valeur dans la confirmation : la relecture du diff produit par un agent. Et il ne supprime pas la seule chose qui coûte : les conflits. Le gain se limite à quelques clics par copie (C), ce qui ne justifie ni 2 à 3 jours de travail ni des merges dans master sans regard humain.

**À la place, deux étapes.**

**Étape 1 — tout de suite, environ une journée : rendre l'intégration d'une copie sûre par construction et faisable en un geste.**
- « Intégrer » sur une copie en retard enchaîne, sous un seul verrou couvrant la copie et master :
  1. mise à jour depuis master ; en cas de conflit, arrêt, et le conflit reste dans la copie comme aujourd'hui ;
  2. validation du projet dans la copie, de façon facultative ;
  3. vérification `git merge-base --is-ancestor master copie` (master est-il bien ancêtre de la copie ?) ;
  4. `git merge --no-ff` dans master ;
  5. libération du verrou.
- **Une seule confirmation**, qui affiche le résumé du diff. On l'assume comme une relecture, pas comme une formalité.
- Tout échec dans master déclenche un `git merge --abort` automatique, puisqu'il n'y a plus de conflit à y résoudre.
- C'est la version à moitié prix de C, avec en plus le scénario de E rendu impossible. Et elle profite à chaque intégration, pas seulement aux lots.

**Étape 2 — seulement si les données le justifient : « Intégrer la sélection ».**
- Condition : le critère de C sur `worktree_operations`, c'est-à-dire, sur 4 semaines, au moins 3 journées avec 4 intégrations ou plus, et moins de 10 % de mises à jour en conflit.
- Périmètre : les copies **cochées explicitement**, c'est-à-dire déclarées relues. Jamais « toutes les copies prêtes » par défaut.
- Ordre : celui de la sélection, affiché avant le lancement.
- Traitement une par une, chaque copie passant par le mécanisme de l'étape 1. Une copie bloquée (conflit, tests, hook) reste en l'état dans sa copie et **le lot continue**. C'est sûr, puisqu'un échec ne touche jamais master. Exception : arrêt si une copie dépend d'une autre.
- À la fin, un bilan qui propose aussi de supprimer les worktrees intégrés et d'archiver les conversations. Le push reste une action séparée.

**Ce que je rejette :**
- la boucle autonome de B : pas question de merger du code d'agent sans relecture tant que l'étape 2 n'a pas tourné des semaines sans revert ;
- la simulation globale de E, devenue inutile grâce à la garantie d'ascendance ;
- la suppression de la mise à jour proposée par A : c'est elle qui fournit la garantie.

La branche d'intégration temporaire ne vaut la peine que si des régressions cumulées apparaissent malgré la validation copie par copie.

### Première action

**Écrire dans `tests/worktree-api.test.mjs` un test qui reproduit la cascade décrite par E.**
- Mise en place : deux copies modifient la même zone d'un même fichier, et la copie B ne semble pas en conflit avant l'intégration de la copie A.
- Action : intégrer A, puis B.
- Ce que le test doit vérifier :
  - B s'arrête sur un conflit **dans la copie B** ;
  - master ne contient ni `MERGE_HEAD` ni fichier modifié ;
  - l'intégration de A produit un unique commit de merge dont le premier parent est l'ancien master.

**Puis faire passer ce test** en modifiant le chemin d'exécution dans `server/worktrees.ts` (vers la ligne 973 selon C et E ; je n'ai pas vérifié cette référence) :
- mise à jour sous le même verrou ;
- vérification `merge-base --is-ancestor` ;
- `merge --no-ff` ;
- `merge --abort` automatique en cas d'échec.

**En parallèle (10 minutes) :** interroger `worktree_operations` sur les 4 dernières semaines pour décider de l'étape 2.

## Avis

### A — Premiers principes (codex · gpt-6.1-sol · effort xhigh)

**Non au bouton proposé. La première simplification consiste à supprimer la mise à jour systématique.**

Le problème réel est le temps d’attention consacré à ramener des changements choisis dans master. Git n’exige pas de fusionner master dans chaque copie avant de fusionner cette copie dans master. Cerebro propose déjà l’intégration directe lorsqu’aucun conflit n’est prévu : [Worktrees.tsx](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/web/src/Worktrees.tsx:291). Automatiser les deux opérations systématiquement ajouterait donc du travail inutile.

Les contraintes réelles sont une copie entièrement commitée, une cible propre et des agents au repos. Le serveur les contrôle déjà : [worktrees.ts](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/server/worktrees.ts:493). Une autre contrainte demeure : après chaque intégration, master change. Une copie auparavant compatible peut devenir conflictuelle ; les prévisions sont justement attachées au couple de commits source/cible : [worktrees.ts](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/server/worktrees.ts:635). Enfin, une fusion sans conflit ne prouve aucune compatibilité fonctionnelle.

Comparons les options :

- **Ne rien faire** : conserver le moteur actuel suffit tant que les manipulations ne représentent pas un coût mesuré significatif.
- **Retirer quelque chose** : présenter directement « Intégrer » pour les copies compatibles et réserver la mise à jour au traitement des conflits. Le code suit déjà cette logique ; alléger la présentation suffit comme premier changement.

Je recommande cette soustraction. Si un traitement par lot devient nécessaire, sa version minimale serait « Intégrer les copies sélectionnées », séquentiellement, avec revérification avant chaque fusion et arrêt au premier blocage. Aucun enchaînement ne supprime le jugement nécessaire pour résoudre un conflit.

**Je changerais d’avis sur l’ajout d’un bouton de lot si vingt intégrations consécutives montraient plus de dix minutes cumulées de manipulations répétitives sur des copies déjà commitées, relues et sans conflit.**

### B — Expansionniste (codex · gpt-6.1-sol · effort xhigh)

**Oui : « Tout intégrer » doit devenir le point d’entrée d’une véritable file d’intégration.** Cerebro multiplie déjà les conversations ; automatiser leur convergence permet de viser dix fois plus de travaux menés en parallèle. Tant que chaque copie réclame plusieurs interventions, l’attention du développeur plafonne le débit de tout le système.

Les briques existent : une mise à jour sans conflit crée déjà son commit automatiquement dans [server/worktrees.ts](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/server/worktrees.ts:665). Le même gestionnaire vérifie les états et verrouille les espaces concernés avant intégration. Construire leur orchestration transforme ces opérations isolées en capacité réutilisable.

Je ferais du bouton une commande serveur : prendre les copies prêtes, les traiter séquentiellement, recalculer leur situation après chaque avancée de master, exécuter les vérifications du projet, puis intégrer sans confirmation intermédiaire. Une copie bloquée conserve son état pendant que les suivantes avancent. Le développeur reçoit un bilan exploitable.

**Le potentiel suivant est une boucle autonome : produire, vérifier, intégrer, recommencer.** Cerebro sait déjà enchaîner des tâches selon leurs dépendances dans [server/epic-runner.ts](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/server/epic-runner.ts:197). Relier cet ordonnanceur à l’intégration permettrait de lancer des ensembles de travaux jusqu’à leur convergence. Ensuite, les conflits pourraient repartir vers leur conversation avec une demande de résolution, puis rejoindre automatiquement la file.

Rester au parcours manuel laisse sur la table les petites améliorations qu’on renonce à lancer parce que leur intégration coûte trop d’attention. L’automatisation abaisse ce coût et élargit le nombre d’expériences rentables.

**Je changerais d’avis si, sur 30 lots comparables mesurés, le temps humain économisé était inférieur au temps de diagnostic et de réparation des régressions imputables à l’intégration automatique.**

### C — Économiste (claude · fable · effort xhigh)

## Arbitrage de l'Économiste

**Coût connu** : un orchestrateur serveur qui enchaîne `update-from-target` puis `prepare`/`merge` par copie en respectant jetons à empreinte, verrous copie + cible et bloqueurs (`server/worktrees.ts:935-962`, `server/worktree-gate.ts`), une progression persistée dans `worktree_operations`, des tests (`tests/worktree-api.test.mjs`). **Estimation** : deux à trois jours, plus la maintenance d'une séquence qui mute master plusieurs fois sans regard humain.

**Coût caché** : « toutes les copies prêtes » n'est pas un ensemble stable. Chaque merge dans master invalide la prévision de conflits des autres copies, mise en cache par couple de commits et recalculée en quelques secondes chacune (`server/worktrees.ts:635-652`). Le premier conflit arrête la chaîne ; survenu dans master, il y laisse un merge inachevé qui bloque tout le reste (`server/worktrees.ts:977`).

**Bénéfice réel** : des clics. Une copie propre s'intègre en deux clics ; en retard sur master, trois, car la mise à jour sans conflit est commitée d'un coup (`server/worktrees.ts:674-676`) et le bouton principal propose déjà l'étape suivante (`web/src/Worktrees.tsx:286-293`). Cinq copies : une quinzaine de clics, quelques minutes. Le bouton n'économise rien sur la seule étape chère : résoudre un conflit.

**Option zéro** : garder le parcours actuel. Elle capte déjà l'essentiel.

**Version à moitié prix**, celle que je recommande si l'on fait quelque chose : « Intégrer » sur une copie en retard enchaîne mise à jour propre puis merge, sous une seule confirmation. Un clic de moins par copie, master touché une copie à la fois, aucun orchestrateur. Une demi-journée.

**Coût d'opportunité** : ces deux jours valent mieux sur ce qui interrompt vraiment, la résolution de conflits déléguée à la conversation.

**Ce qui me ferait changer d'avis** : sur quatre semaines, `worktree_operations` montre au moins trois journées à quatre merges de copies ou plus, et moins d'un merge sur dix précédé d'une mise à jour en conflit dans la copie. Alors les clics dominent et le lot se paie.

### D — Exécutant (codex · gpt-6.1-sol · effort xhigh)

**Automatisons le parcours sans conflit, avec arrêt au premier blocage.** Livrons un bouton « Intégrer les copies prêtes ». Promettre que toutes les copies passeront sans intervention est irréaliste : les conflits et les dépendances entre branches demandent encore une décision.

Le socle existe : la mise à jour crée déjà son commit lorsqu’elle réussit, et l’intégration contrôle les changements d’état Git ([server/worktrees.ts](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/server/worktrees.ts:665)). Le travail consiste à orchestrer ces opérations.

1. **Demain matin : définir le lot.** Un seul projet, une cible master, copies entièrement commitées et propres, agents au repos. Afficher l’ordre et les exclusions ; demander une confirmation globale. Le tri des fichiers hérités reste préalable.
2. **Demain après-midi : obtenir une preuve serveur.** Traiter deux copies successivement : actualiser depuis master si nécessaire, exécuter la validation du projet, puis intégrer. Recalculer l’état après chaque merge puisque master avance. Adapter les verrous existants pour couvrir toute la séquence ([server/worktree-gate.ts](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/server/worktree-gate.ts:25)). Premier résultat vérifiable : les deux commits sont ancêtres de master, qui reste propre.
3. **Jours 2 et 3 : rendre le bouton utilisable.** Afficher progression et journal ; arrêter sur conflit, validation échouée ou activité nouvelle. Garder les conflits dans la copie. Après redémarrage, réinspecter avant toute reprise : les tests actuels prévoient déjà les opérations interrompues ([tests/worktrees.test.mjs](/tmp/claude-1000/-home-ftriquet-CodePerso-Cerebro/66c5a0a9-ad74-4140-beb3-4eee83de91d0/scratchpad/cerebro/tests/worktrees.test.mjs:195)). Vérifier également qu’une relance ne réintègre rien.

**Ressources :** un développeur maîtrisant TypeScript et Git, trois jours ciblés. Le push reste une action distincte.

Je changerais d’avis sur l’automatisation intégrale après 50 intégrations réelles consécutives sans intervention, toutes validées par les tests et sans correction ultérieure liée à l’intégration.

### E — Contrarien (claude · fable · effort xhigh)

**Pré-mortem, octobre 2027.** Le bouton est devenu un réflexe. Cinq copies « prêtes » : trois fusionnent, la quatrième échoue, et pas dans la copie : dans master. `execute` lance un `git merge` standard avec hooks dans le dossier cible et, sur échec, « aucun reset ni abandon automatique » (`server/worktrees.ts:973-977`, `SPEC.md:331`). Master reste en MERGE_HEAD, la cinquième est bloquée par `targetDirty`, et le développeur résout à la main dans le dossier du projet, ce que le parcours en quatre étapes avait été conçu pour interdire (`SPEC.md:350`). Variante : les cinq passent, l'application ne démarre plus, et aucun test n'a tourné entre deux merges pour désigner la coupable.

**Ce qui casse.**
1. *L'ensemble « prêt » n'est pas stable.* Dès que A entre dans master, `targetHead` change : B à E redeviennent en retard, leurs `integrationConflicts` sont périmés (`server/worktrees.ts:484,635`) et leur fingerprint invalidé (`server/worktrees.ts:520,952`). Ce n'est pas N intégrations mais une cascade où chaque merge fabrique les conflits du suivant, dans un ordre choisi par défaut. Le bouton devient « intégrer jusqu'au premier accident ».
2. *La confirmation devient décorative.* Le cycle prepare → jeton → start revérifié existe pour qu'un humain valide un état précis ; l'enchaîner sans intervention le garde dans le code et le vide de son sens.
3. *Le coût, ce sont les conflits, pas les clics.* Le bouton n'en supprime aucun ; il déplace seulement le moment où on les découvre, vers le pire endroit.

**Signal avant-coureur :** la première fois que master contient un MERGE_HEAD ou des fichiers non commités après un lot, ou qu'un merge est reverté dans master sans qu'on sache quelle copie il visait.

**Ce qui me ferait changer d'avis :** une simulation séquentielle du lot entier dans un index temporaire (généralisation de `simulateTargetMerge`, `server/worktrees.ts:712`) qui refuse de démarrer si une seule étape conflicte, et un relevé montrant qu'au moins trois copies sont régulièrement prêtes ensemble et que 90 % des intégrations réelles passent sans conflit ni échec de hook.

## Relectures

### Relecture par E — Contrarien (claude · fable · effort xhigh)

1. C : Seule réponse qui chiffre le bénéfice réel (des clics, quelques minutes) face au coût (2-3 jours plus maintenance), identifie que l'étape chère est le conflit, propose une version à une demi-journée et un critère de revirement mesurable sur des données déjà collectées.
2. D : Plan concret et prudent si l'on construit : lot défini, verrous étendus à la séquence, recalcul après chaque merge, validation avant intégration, reprise idempotente après redémarrage. Manque l'arbitrage coût/bénéfice et s'arrête au premier blocage là où continuer sur les autres copies serait plus utile.
3. A : Juste sur le fond (Git n'impose pas la mise à jour préalable, les prévisions périment, un merge propre ne prouve rien), mais la recommandation est quasi vide : elle admet que le code fait déjà ce qu'elle propose, et sauter la mise à jour déplace les conflits éventuels dans master au lieu de la copie.
4. B : Bonne idée de poursuivre sur les autres copies quand l'une bloque, mais promesse non étayée (dix fois plus de travaux), aucun coût, dérive vers une boucle autonome hors question, et ignore que le conflit reste le vrai goulot.
Angle mort : Tous traitent la confirmation « Intégrer » copie par copie comme de la friction ou de l'orchestration. Pour un outil qui pilote des agents de code, c'est le dernier moment où le développeur regarde réellement le diff produit par l'agent avant qu'il n'entre dans master. Un bouton de lot supprime cette relecture sans la remplacer : aucune réponse ne demande ce qui tient lieu de revue, ni si une validation automatique suffit quand l'auteur du code est un agent.
Ce que tous ont manqué : Aucune ne dit comment le lot choisit l'ordre des copies alors que cet ordre décide quelles copies entreront en conflit : D promet d'afficher l'ordre sans dire comment il est calculé. Aucune non plus n'évoque le cycle après intégration : que deviennent la copie, sa branche et sa conversation (suppression, poursuite du travail sur une branche désormais fusionnée), ce qui fait pourtant partie du coût manuel réel que le bouton prétend réduire.

### Relecture par A — Premiers principes (codex · gpt-6.1-sol · effort xhigh)

1. D : Le compromis le plus exploitable : périmètre explicite, validation, recalcul, arrêt et reprise. L’estimation de trois jours reste peu étayée.
2. C : Bon arbitrage économique et alternative simple, mais réduit trop vite le gain aux clics ; délais et seuils manquent de preuves.
3. B : File séquentielle, recalcul et tests pertinents. Le gain annoncé et l’extension vers l’autonomie restent spéculatifs ; dépendances et récupération sont insuffisamment cadrées.
4. E : Pré-mortem utile sur les échecs partiels, mais surestime les conflits inévitables dans master et impose une simulation globale excessivement restrictive.
Angle mort : La définition fonctionnelle de « prête » reste insuffisante : une copie propre et un agent au repos ne prouvent ni que le travail est terminé et accepté, ni que ses dépendances permettent de l’intégrer dans l’ordre choisi.
Ce que tous ont manqué : L’invariant Git décisif : après une mise à jour réussie avec le master courant, master est ancêtre de la copie. Si sa tête reste protégée par un verrou, une intégration avec --ff-only élimine les conflits de fusion dans master. Cela permet d’automatiser ce parcours tout en laissant les conflits dans les copies ; les régressions fonctionnelles et les autres échecs restent à traiter.

### Relecture par B — Expansionniste (codex · gpt-6.1-sol · effort xhigh)

1. A : Identifie la mise à jour systématique inutile en Git, propose une simplification proportionnée et distingue absence de conflit et compatibilité fonctionnelle.
2. D : Décrit une automatisation bornée et exploitable : validation, verrous, arrêt et reprise. Justifie toutefois peu l’investissement avant de programmer sa réalisation.
3. C : Compare utilement coûts, bénéfices et solution intermédiaire, mais ses estimations sont fragiles et réduire le bénéfice aux clics sous-estime le coût d’attention.
4. E : Éclaire les échecs possibles, mais dramatise l’invalidation normale des prévisions et rejette trop vite la valeur d’une confirmation globale.
Angle mort : Le contrat d’échec reste insuffisamment défini : si trois copies passent puis la quatrième bloque, le résultat partiel est-il acceptable et comment l’annuler ? Journaliser et arrêter ne répond pas à cette décision produit.
Ce que tous ont manqué : Aucune n’explore complètement une branche ou un worktree d’intégration temporaire : y assembler et tester le lot, puis avancer master une seule fois après vérification de son état. La simulation proposée par E vérifie les conflits, sans offrir cette validation fonctionnelle du résultat cumulé.

### Relecture par C — Économiste (claude · fable · effort xhigh)

1. E : Seule réponse qui identifie le vrai risque : un merge qui échoue dans master sans abandon automatique, le lot « prêt » instable dès que targetHead bouge, l'absence de tests entre deux merges. Ancrée dans le code et la SPEC, elle propose un garde-fou précis (simulation séquentielle du lot entier) et des seuils de données. Manque une recommandation de construction, mais c'est la plus utile pour décider.
2. D : Recommandation équilibrée et réalisable : automatiser le chemin sans conflit, arrêt au premier blocage, recalcul après chaque merge, verrous étendus, validation, reprise sûre après redémarrage, push séparé. Plan concret en trois jours. Faiblesse : n'explique pas comment garantir que l'échec reste dans la copie et non dans master.
3. A : Observations justes (prévisions liées au couple de commits, merge propre ≠ compatibilité fonctionnelle, version minimale du lot) et critère de revirement mesurable. Mais la thèse centrale rate l'intention du design : la mise à jour dans la copie sert à tester l'état combiné et à garder master propre, pas seulement à satisfaire Git. Ne parle jamais de tests.
4. B : Vision cohérente et quelques éléments justes (séquentiel, recalcul, vérifications, renvoi des conflits vers la conversation). Mais aucune analyse des modes d'échec, un « dix fois plus » non étayé, et « les suivantes avancent » est dangereux si le blocage est dans master. Critère de revirement mesurable seulement après avoir tout construit.
Angle mort : Aucune réponse ne propose la garantie structurelle qui rend le lot sûr : ne jamais faire de vrai merge dans master pendant l'enchaînement. Si la mise à jour avec master précède immédiatement l'intégration sous un même verrou, le merge dans master devient un fast-forward (`--ff-only`) et ne peut pas conflicter ; seuls les hooks peuvent échouer. Variante plus forte : construire le lot sur une branche d'intégration temporaire, valider une fois, puis avancer master en fast-forward, ce qui rend le lot atomique et supprime le scénario « master en MERGE_HEAD » décrit par E. Le débat porte sur l'ordre et l'arrêt, alors que le choix du type de merge règle l'essentiel.
Ce que tous ont manqué : Toutes définissent « prête » en termes Git uniquement : commitée, cible propre, agents au repos. Le code vient d'agents ; la vraie barrière avant master est la relecture ou l'acceptation par le développeur du diff produit, et personne ne dit où elle se place dans une chaîne sans intervention ni si elle fait partie de la préparation. Corollaire ignoré : chaque intégration rend obsolète la base des copies encore actives, et aucune ne traite l'effet du lot sur les conversations en cours ni le cycle de vie de la copie intégrée (suppression du worktree, fin de conversation).

### Relecture par D — Exécutant (codex · gpt-6.1-sol · effort xhigh)

1. A : Identifie justement la mise à jour préalable souvent inutile et propose une simplification proportionnée, avec revérification après chaque fusion.
2. B : Propose une orchestration concrète avec sérialisation, contrôles et tests. Les gains annoncés et l’extension vers une boucle autonome restent spéculatifs.
3. C : Éclaire le coût d’opportunité, mais ses estimations sont peu étayées et sa solution conserve une mise à jour parfois inutile.
4. E : Soulève des risques utiles, mais surestime leur caractère inévitable et confond partiellement protection contre les changements concurrents et confirmation humaine.
Angle mort : La cohérence d’un lot partiellement intégré : aucune réponse ne définit complètement le traitement des dépendances entre copies, d’un échec fonctionnel, de la reprise et de l’annulation. Sauter une copie bloquée peut compromettre les suivantes.
Ce que tous ont manqué : Après une mise à jour réussie avec le master courant, master est ancêtre de la copie. Sous verrou et à commits inchangés, la fusion retour ne peut donc produire de conflit textuel. Cela relativise le scénario central de C et E, sans éliminer les échecs de hooks ni les régressions fonctionnelles.

## Classement agrégé

| Position | Lettre | Conseiller | Rang moyen | Relectures |
| --- | --- | --- | --- | --- |
| 1 | D | Exécutant | 1,75 | 4 |
| 2 | A | Premiers principes | 2 | 4 |
| 3 | C | Économiste | 2,25 | 4 |
| 4 | B | Expansionniste | 3,25 | 4 |
| 5 | E | Contrarien | 3,25 | 4 |

<!-- rangs moyens : Exécutant 1.75, Premiers principes 2, Économiste 2.25, Expansionniste 3.25, Contrarien 3.25 -->
