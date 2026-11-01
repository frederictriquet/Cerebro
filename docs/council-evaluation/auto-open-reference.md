# Council : Quand une action de Cerebro lance une session d'agent (revue de code, commit, tâche du backlog), faut-il ouvrir automatiquement son terminal ?

Lancé le 2026-10-30T21:22:15.415Z · statut : succeeded · chairman : claude · opus · effort xhigh

## Question

Quand une action de Cerebro lance une session d'agent (revue de code, commit, tâche du backlog), faut-il ouvrir automatiquement son terminal ?

## Contexte

Cerebro est une application web locale, utilisée par une seule personne, son développeur, pour mener plusieurs sessions d'agents de code (Claude Code, Codex, Grok) en parallèle, projet par projet. Chaque session tourne dans un terminal. La barre latérale liste les sessions avec leur état (en cours, en attente d'une réponse, au repos) ; un clic ouvre le terminal d'une session. Les sessions continuent de tourner quand on ne les regarde pas, et Cerebro peut prévenir sur Slack quand une session attend une réponse ou a fini son tour.

Plusieurs actions de la page d'un projet lancent une session d'agent : le bouton de revue de code, le commit et push assisté, le démarrage d'une tâche du backlog.

Proposition : après chacune de ces actions, ouvrir automatiquement le terminal de la session lancée, pour voir l'agent démarrer et pouvoir lui répondre tout de suite.

## Synthèse

### Points d’accord

- **Quatre conseillers sur cinq (A, B, C, E) répondent non.** Ouvrir le terminal à chaque lancement contredit la raison d'être de Cerebro : confier une tâche à un agent, faire tourner plusieurs sessions en parallèle et n'être appelé que lorsqu'une intervention est utile. Tu lances une revue justement pour ne pas avoir à la suivre.
- **Tous, D compris, voient le même besoin réel.** Il faut savoir tout de suite que le lancement a réussi, et pouvoir rejoindre la session en un clic. Regarder du texte défiler n'est qu'un moyen, pas le but.
- **Le lancement en série casse l'ouverture automatique.** Si tu enchaînes revue, commit et tâche du backlog, l'écran saute trois fois et tu perds la page du projet (B, C, E). D le reconnaît à sa manière : il prévoit de ne pas changer ta sélection si tu as navigué ailleurs pendant le lancement.
- **Tous font dépendre leur position de l'usage réel**, en particulier de cette question : ouvres-tu le terminal manuellement juste après le lancement ?

### Désaccords

1. **Oui ou non : D contre les quatre autres.** D mise sur la valeur des premières secondes : voir le démarrage et corriger une mauvaise consigne. Les autres mettent en avant le coût du changement de contexte. Le désaccord vient d'une hypothèse que personne n'a vérifiée : que se passe-t-il au démarrage ? B affirme que l'agent reste muet pendant cette phase. A, C et D trouvent l'affirmation spéculative. En réalité, la réponse dépend du mode de permission de l'agent (voir les angles morts). **Je ne suis pas D sur le fond.** Son meilleur argument, corriger une consigne, se traite mieux avant le clic ou par un simple lien, et il ne met jamais en balance le coût de l'ouverture. **Je garde en revanche ses garde-fous de mise en œuvre** : ne pas changer ta sélection si tu as navigué pendant le lancement, et afficher les erreurs sur la page du projet.

2. **Une règle uniforme ou une règle par action.** A refuse toute règle par bouton. E, ainsi que les relectures de B et E, rappellent que les trois actions ne se ressemblent pas : un commit n'est pas une tâche du backlog. A cherche la simplicité, E colle au profil d'interaction de chaque action. Mon arbitrage : même comportement par défaut pour tout le monde, avec une seule exception possible, le commit, et seulement si l'usage la justifie.

3. **La méthode de validation.** Les conseillers proposent des seuils (16 sur 20, 80 sur 100, 6 sur 20, 80 % en 10 secondes) ; les relectures proposent plutôt d'essayer chaque comportement pendant une semaine. Les relectures ont raison : pour un outil à un seul utilisateur qui en est aussi le développeur, ces protocoles sont disproportionnés et les seuils arbitraires. D relève en plus un biais : si tu ouvres le terminal à la main juste après le lancement, c'est peut-être que la confirmation manque, pas que l'ouverture automatique serait utile.

4. **Le classement de B.** E place B en premier ; A, C et D le classent dernier pour le ton affirmatif de ses hypothèses. Je retiens son diagnostic, à savoir que l'ouverture automatique réintroduit la surveillance que Cerebro devait supprimer, mais pas sa certitude sur le silence au démarrage.

### Angles morts

- **Les trois actions ne se ressemblent pas** (vu seulement dans les relectures de B et E). Le commit et push assisté est un échange court qui se termine par une action visible de l'extérieur, le push. La tâche du backlog est une délégation longue. La revue produit un livrable qu'on lit à la fin.
- **Le mode de permission est la variable décisive** (relecture de E). En mode par défaut, Claude Code demande des autorisations dès les premières secondes. Personne n'en a tiré la conséquence : ces trois actions sont prédéfinies, donc leurs permissions peuvent l'être aussi (outils de lecture pour la revue, commandes git pour le commit). Mieux vaut supprimer la cause qu'ouvrir un terminal pour cliquer sur « autoriser ».
- **Afficher, naviguer et prendre le clavier sont trois choses différentes** (relectures de A, B et C). Un risque concret n'a été cité par personne : des touches tapées pour la page du projet qui partent dans l'agent parce que le terminal s'est ouvert et a pris le clavier.
- **Ce que personne n'a vu : la proposition vise le mauvais moment.** Le besoin de « pouvoir répondre tout de suite » apparaît quand la session passe en attente, pas quand elle démarre. Ouvrir au lancement ne tombe juste que si la question arrive dans les premières secondes. Le bon levier est de rendre ce passage en attente visible dans Cerebro même quand tu y es, par exemple une notification « La revue de X attend ta réponse — Ouvrir » ou un badge dans le titre de l'onglet. Slack reste utile pour les moments où tu es ailleurs. Cela couvre les trois actions, à tout moment.
- **Les échecs de lancement.** Seul D les traite. Si on ne bascule plus vers le terminal, une erreur de lancement doit s'afficher sur la page du projet, sinon elle passe inaperçue.
- **Les coûts ne sont pas symétriques**, contrairement à ce qu'avance la relecture de B. Ne pas ouvrir coûte un clic sur la notification. Ouvrir coûte la page du projet, le clavier et la possibilité d'enchaîner les lancements. Le comportement par défaut doit donc être le moins coûteux quand il se trompe : ne pas ouvrir.

### Recommandation

**Non : pas d'ouverture automatique.** Il faut remplacer la proposition par quatre éléments plus légers.

1. **Une confirmation sur place.** Une notification du type « Revue lancée — Ouvrir le terminal » s'affiche, et la nouvelle session apparaît en tête de la barre latérale, surlignée quelques secondes. Tu restes sur la page du projet et tu gardes le clavier. Si le lancement échoue, l'erreur s'affiche sur cette même page.
2. **Un raccourci pour les fois où tu veux regarder.** Le lien de la notification suffit ; on peut ajouter Maj+clic sur le bouton pour lancer et ouvrir d'un coup. Pas de préférence dans les réglages, pas de temporisation.
3. **Une alerte dans Cerebro quand une session passe en attente.** C'est le vrai moment où tu dois intervenir, et ce signal sert les trois actions, pas seulement leurs premières secondes.
4. **Des permissions prédéfinies pour chaque action**, pour que le démarrage ne bloque pas sur une demande d'autorisation.

**Le commit est la seule exception envisageable.** Utilise ce fonctionnement pendant une semaine. Si tu ouvres presque à chaque fois le terminal juste après un commit, et que tu y réponds vraiment, passe le commit en ouverture automatique avec les garde-fous de D : rien ne s'ouvre si tu as changé de projet ou de session entre-temps, et le terminal ne prend pas le clavier.

**Pourquoi je suis E et A plutôt que D :** le seul gain de l'ouverture automatique, un clic, est déjà apporté par la notification, alors que son coût en contexte perdu se paie à chaque lancement. **Pourquoi je nuance A :** refuser par principe toute règle par bouton ignore que le commit est un échange court.

**Pas de panneau terminal latéral pour l'instant.** C'est un chantier plus lourd, à ne lancer que si la semaine d'essai montre que tu veux voir les premières lignes sans quitter la page du projet.

### Première action

Dans le code commun aux trois actions, juste après la réception de l'identifiant de session, ajoute la notification « <Action> lancée — Ouvrir le terminal » avec un lien vers la session, et surligne cette session en tête de la barre latérale. Si la création échoue, affiche l'erreur sur la page du projet. Vérifie ensuite le parcours en lançant à la suite une revue, un commit et une tâche du backlog : tu dois rester sur la page du projet, sans que le clavier soit capturé, et chaque lien doit ouvrir le bon terminal.

## Avis

### A — Premiers principes (codex · gpt-6.1-sol · effort xhigh)

**Non. Lancer une session ne doit pas ouvrir automatiquement son terminal.**

Le vrai problème est de savoir si l’action a démarré et si elle réclame ton intervention. Voir défiler du texte est un moyen de surveillance, pas un besoin en soi.

Les faits élémentaires sont simples : l’agent travaille sans spectateur ; plusieurs agents peuvent travailler simultanément ; ton attention ne peut suivre qu’un contexte à la fois. Ouvrir automatiquement le terminal transforme donc chaque lancement de travail autonome en changement de contexte imposé. Tu délègues une tâche, puis l’interface te replace immédiatement devant son exécution.

La contrainte réelle est de rendre une demande d’intervention visible. La contrainte supposée est qu’il faudrait regarder chaque démarrage pour pouvoir répondre rapidement. La barre latérale indique déjà les sessions en attente ; un clic permet de les rejoindre.

**Ne rien faire suffit** : conserver la page du projet après le lancement et laisser la nouvelle session apparaître dans la liste existante. Tu peux continuer à préparer une autre tâche ou ouvrir volontairement le terminal.

**Retirer quelque chose** signifie ici retirer à ces boutons leur rôle de navigation : « lancer une revue » lance une revue ; cliquer sur une session ouvre son terminal. N’ajoute ni préférence, ni temporisation, ni règle différente pour chaque bouton.

Je changerais d’avis si, sur 20 lancements consécutifs, tu ouvres manuellement le terminal dans les cinq secondes au moins 16 fois : ce serait une intention répétée et vérifiable que l’interface devrait exécuter.

### B — Contrarien (claude · fable · effort xhigh)

## Pré-mortem

Un an plus tard, l'option est désactivée depuis des mois, ou pire, toujours active et personne n'a vu qu'elle a tué le parallélisme. Chaque lancement arrachait l'utilisateur à la page projet pour le planter devant un terminal où l'agent lisait des fichiers en silence. Il repartait avant la première question ; quand elle arrivait, Slack prévenait de toute façon. La fonctionnalité ne servait jamais, mais coûtait un changement de contexte à chaque clic. Pour l'éviter, il s'est mis à lancer une action à la fois et à attendre. Cerebro est redevenu un terminal avec une barre latérale.

## Ce qui casse

- **L'hypothèse « voir l'agent démarrer et répondre tout de suite »** est fausse : le démarrage est la phase la plus muette (lecture, planification). La première question tombe quand l'utilisateur a déjà changé d'écran.
- **La proposition contredit le produit.** Cerebro repose sur des sessions qu'on ne regarde pas et une notification quand elles ont besoin de vous. Ouvrir le terminal réintroduit le babysitting que l'outil devait supprimer.
- **Le lancement en série devient pénible** : trois tâches du backlog, trois redirections. On apprend à ne plus le faire.
- **Déjà échoué ailleurs** : les IDE qui volent le focus vers le panneau de sortie à chaque build. C'est la première option que les utilisateurs avancés désactivent.

## Le signal avant-coureur

Pour chaque terminal ouvert automatiquement, mesurer si l'utilisateur y est encore quand l'agent pose sa première question. S'il est parti dans la majorité des cas, c'est un pur coût. Second signal : le nombre de sessions simultanées baisse après activation.

## Ce qui me ferait changer d'avis

Deux semaines de mesure montrant que dans plus de la moitié des sessions, l'agent demande une entrée dans les trente premières secondes et que l'utilisateur y répond sans avoir quitté le terminal. Sinon, c'est un réflexe de démo, pas un usage.

### C — Expansionniste (codex · gpt-6.1-sol · effort xhigh)

**Non : lancer une session doit déléguer du travail, pas déplacer automatiquement l’attention vers son terminal.** L’opportunité de Cerebro est de devenir un poste de pilotage où une personne fait avancer dix chantiers simultanément. Ouvrir chaque terminal reproduit le fonctionnement d’un outil utilisé en série : je lance, je regarde, j’attends.

Si l’on vise dix fois plus haut, la bonne unité d’interaction devient l’intention : « révise ce code », « prépare ce commit », « traite cette tâche ». L’utilisateur doit pouvoir enchaîner ces décisions depuis son projet. Chaque ouverture automatique lui retire cette surface de commande et transforme une délégation en invitation à superviser le démarrage.

Je garderais donc la page courante, avec une confirmation immédiate et un lien **« Ouvrir le terminal »**. La barre latérale rend l’activité visible ; les demandes de réponse attirent l’attention lorsqu’une intervention devient utile. Le terminal reste accessible en un clic.

Ce choix ouvre une trajectoire beaucoup plus ambitieuse : lancer plusieurs tâches du backlog, déclencher des revues sur plusieurs projets, puis consulter une file de résultats et de décisions à prendre. Cerebro peut organiser le travail autour des interventions humaines nécessaires. Rester attaché à l’ouverture systématique laisse sur la table le principal effet de levier des agents : leur capacité à avancer pendant que leur utilisateur fait autre chose.

Je changerais d’avis si, sur 100 lancements sans ouverture automatique, au moins 80 étaient suivis d’une ouverture manuelle du terminal sous cinq secondes et d’une saisie dans la minute, avant toute autre action dans Cerebro.

### D — Exécutant (codex · gpt-6.1-sol · effort xhigh)

**Oui : une action explicite qui lance un agent doit ouvrir son terminal dans Cerebro.** L’utilisateur voit immédiatement le résultat de son clic et peut corriger une mauvaise instruction dès le démarrage.

Dès demain, consacrer **une journée de développeur** à cette modification, dans cet ordre :

1. **Réutiliser l’ouverture existante.** Identifier le mécanisme déclenché par un clic sur une session dans la barre latérale. Les trois actions doivent appeler ce même mécanisme après création de leur session.
2. **Ouvrir dès réception de l’identifiant de session.** Afficher le terminal avec un état « démarrage » tant que le processus ne produit rien. Si la création échoue, afficher l’erreur sur la page du projet.
3. **Protéger la navigation.** Si l’utilisateur a changé de projet ou sélectionné une autre session pendant le lancement, conserver sa sélection et signaler la nouvelle session dans la barre latérale.
4. **Vérifier les trois parcours.** Lancer une revue, un commit assisté et une tâche du backlog. Pour chacun, vérifier que le bon terminal s’ouvre, accepte une réponse et laisse les autres sessions continuer. Tester également un échec de lancement et un changement de projet pendant l’attente.

Le premier résultat vérifiable est simple : **un clic sur « revue de code » affiche automatiquement le terminal correspondant, sans second clic**.

La dépendance pratique est l’obtention rapide d’un identifiant de session. Attendre un signal « agent prêt » uniforme entre Claude Code, Codex et Grok ajouterait un chantier d’intégration inutile.

**Je changerais d’avis si, sur vingt lancements observés, l’utilisateur quittait au moins six fois le terminal ouvert automatiquement en moins de cinq secondes, sans y intervenir.**

### E — Outsider (claude · fable · effort xhigh)

**Question naïve n°1 : pourquoi construire une appli pour lancer des agents en parallèle, puis les regarder un par un ?** Le contexte dit que les sessions tournent sans qu'on les regarde et que Slack prévient quand il faut répondre. Si c'est vrai, ouvrir le terminal à chaque lancement contredit la raison d'être de l'outil. On lance une revue *pour ne pas avoir à la suivre*.

**Question naïve n°2 : que voit-on en ouvrant le terminal ?** Un agent qui démarre, c'est en général trente secondes de « je réfléchis ». Rien à lire, rien à répondre. L'ouverture automatique donne une impression de réactivité mais montre surtout un écran qui défile. Ce que l'utilisateur veut à cet instant, c'est une confirmation : « c'est parti, voici la session ». Un toast ou une surbrillance dans la barre latérale suffit.

**Question naïve n°3 : et si je clique trois boutons de suite ?** Revue, puis commit, puis tâche du backlog. Trois terminaux qui s'ouvrent et se volent la vue. L'utilisateur perd la page du projet d'où il travaillait. L'écran saute, et il ne sait plus lequel des trois il regarde.

**Ce que je ferais :** ne pas ouvrir. Mettre la nouvelle session en tête de la barre latérale, surlignée, avec un lien « ouvrir » dans la notification de lancement. Et si une action précise (la revue de code, peut-être) pose presque toujours une question dans les premières secondes, alors traiter *cette* action à part, pas les trois en bloc.

**Ce qui me ferait changer d'avis :** un chiffre tiré des logs de Cerebro. Si, sur les lancements effectués via ces boutons, l'utilisateur ouvre lui-même le terminal de la session dans les 10 secondes dans plus de 80 % des cas, alors l'ouverture automatique ne fait qu'économiser un clic qu'il fait déjà, et on l'active. En dessous, elle dérange plus qu'elle n'aide.

## Relectures

### Relecture par B — Contrarien (claude · fable · effort xhigh)

1. E : La plus concrète : nomme les vrais modes d'échec (écran qui défile sans rien à lire, trois clics qui se volent la vue), propose un retour immédiat (surbrillance + lien), et seule à envisager un traitement différencié par action. Critère de réversion mesurable.
2. A : Raisonnement net et bien hiérarchisé (besoin réel = savoir si l'action a démarré et si elle réclame une intervention), solution minimale. Mais le refus dogmatique de toute règle par bouton ignore que le commit assisté est un dialogue court qui appelle presque toujours une réponse immédiate.
3. C : Même conclusion, bonne vision du poste de pilotage et de la file de décisions, mais reste abstraite : pas de scénario d'échec concret, pas de distinction entre les trois actions, ton un peu grandiloquent pour une question d'UX.
4. D : Prend le contre-pied avec un argument réel (corriger une mauvaise consigne au démarrage) et un plan d'implémentation sérieux, mais ne pèse jamais le coût : parallélisme, barre latérale et Slack déjà existants, enchaînement de lancements. Décide avant d'avoir arbitré.
Angle mort : Les trois actions sont traitées en bloc alors qu'elles ont des profils d'interaction opposés : le commit et push assisté est un échange court où l'agent propose un message et attend une validation dans les secondes qui suivent ; une tâche du backlog est longue et autonome ; la revue produit un livrable qu'on lit à la fin. Un « non » global pénalise le commit, un « oui » global pénalise le backlog. S'y ajoute le mode de permission des agents (Claude Code pose des questions d'autorisation très tôt hors mode automatique), qui conditionne directement l'utilité d'être présent au démarrage.
Ce que tous ont manqué : Toutes acceptent la prémisse qu'ouvrir le terminal signifie quitter la page du projet. Une ouverture non modale (panneau latéral, tiroir, aperçu des premières lignes dans la barre latérale) donnerait le retour immédiat et la possibilité de répondre sans perdre le contexte ni la surface de commande, ce qui dissout l'alternative. Aucune ne remarque non plus que le coût d'erreur est symétrique (un clic dans un sens comme dans l'autre) et que, l'utilisateur étant le développeur, le test le moins cher est d'essayer chaque comportement une semaine plutôt que d'instrumenter des logs.

### Relecture par A — Premiers principes (codex · gpt-6.1-sol · effort xhigh)

1. E : La plus équilibrée : confirmation visible, ouverture accessible et exceptions par action. Son seuil de validation reste arbitraire.
2. C : Relie clairement la décision au travail en parallèle et propose une alternative concrète, malgré une ambition de volume supposée.
3. D : Apporte des protections utiles contre les ouvertures tardives, mais justifie peu le choix d’ouvrir systématiquement avant de détailler son implémentation.
4. B : Identifie bien les risques attentionnels, mais présente comme certaines des hypothèses sur le démarrage silencieux et la perte de parallélisme.
Angle mort : La valeur d’une brève consultation pour cet utilisateur unique reste inconnue : repartir rapidement peut signifier qu’une vérification utile est terminée. Les seuils proposés mesurent mal le bénéfice obtenu et le coût du changement de contexte.
Ce que tous ont manqué : Distinguer visibilité, navigation et focus : un terminal pourrait s’afficher dans un panneau conservant la page projet, sans capturer la saisie. Cette possibilité change le compromis posé comme binaire.

### Relecture par C — Expansionniste (codex · gpt-6.1-sol · effort xhigh)

1. E : La plus équilibrée : confirmation du lancement, ouverture volontaire, exceptions possibles et observation des usages.
2. A : Raisonnement clair et solution simple, mais règle uniforme trop rigide et confirmation du lancement peu traitée.
3. D : Plan concret et bons garde-fous contre une ouverture tardive, mais justification insuffisante de l’ouverture systématique.
4. B : Risques pertinents, mais scénario excessivement spéculatif : ouvrir un terminal ne supprime pas le parallélisme.
Angle mort : L’intention réelle de l’unique utilisateur reste inconnue : déléguer une revue et commencer un commit assisté peuvent appeler des comportements différents. Les seuils proposés ne sont pas justifiés.
Ce que tous ont manqué : Toutes omettent de distinguer affichage et prise de focus : un terminal visible dans un panneau conservant la page projet pourrait permettre de suivre le démarrage sans imposer une navigation.

### Relecture par E — Outsider (claude · fable · effort xhigh)

1. B : Réfute la prémisse même de la proposition : le démarrage est la phase la plus silencieuse, la première question tombe quand on a déjà quitté l'écran. Pré-mortem ancré dans le produit (sessions non regardées + Slack), analogie IDE pertinente, signaux mesurables concrets. Manque seulement la recommandation explicite de remplacement.
2. A : Réponse nette et directement applicable : séparer le besoin réel (savoir que ça a démarré, savoir si ça réclame une intervention) du moyen supposé (regarder). « Ne rien faire suffit », pas de préférence ni de temporisation, critère de réversibilité à 16/20. Un peu moins profond que B sur le pourquoi.
3. C : Bonne conclusion et proposition pratique (confirmation + lien « Ouvrir le terminal »), mais argumentation surtout visionnaire (poste de pilotage, file de décisions) plutôt que fondée sur les mécanismes concrets de Cerebro. Le seuil 80/100 est peu réaliste pour un outil mono-utilisateur.
4. D : Plan d'implémentation soigné (protection de la navigation, cas d'échec), mais la position ignore la tension centrale : Cerebro existe pour piloter des sessions en parallèle et notifie déjà quand une intervention est nécessaire. La justification tient en une phrase et ne pèse jamais le coût du changement de contexte.
Angle mort : Les quatre traitent les trois actions comme homogènes alors qu'elles ne le sont pas. Le commit et push assisté est une interaction courte où l'on attend probablement une validation rapide (message de commit, confirmation du push) : l'utilisateur veut être devant. La tâche du backlog est une délégation longue : il veut passer à autre chose. La revue de code est entre les deux. A va jusqu'à interdire toute règle par bouton, ce qui est une erreur de principe. Second angle mort : l'outil n'a qu'un utilisateur, qui est son développeur. Des protocoles de mesure à 20 ou 100 lancements sont disproportionnés ; une semaine d'essai de chaque comportement tranche la question à coût quasi nul.
Ce que tous ont manqué : Personne ne relève que la variable décisive est le mode de permissions de l'agent. En mode par défaut, Claude Code demande une autorisation d'outil dans les premières secondes, et l'ouverture automatique a alors un sens ; en mode auto-accept ou headless, le démarrage est effectivement muet et B a raison. Personne non plus ne propose les résolutions d'interface classiques qui rendent le choix inutile : un clic modifié (Maj+clic) qui lance et ouvre le terminal, ou un toast « Session lancée — Ouvrir » qui donne le retour immédiat sans voler le focus. Cela satisfait les deux camps sans préférence ni règle par bouton.

### Relecture par D — Exécutant (codex · gpt-6.1-sol · effort xhigh)

1. E : La plus opérationnelle : confirmation visible, accès volontaire et distinction entre actions. Son seuil d’ouverture manuelle reste toutefois une preuve insuffisante.
2. C : Recommandation claire, parcours concret et critère incluant une saisie réelle. L’ambition des « dix chantiers » dépasse cependant le besoin établi.
3. A : Solution simple exploitant l’interface existante, mais exclut trop catégoriquement les différences entre actions et suppose suffisant le retour de lancement actuel.
4. B : Pré-mortem utile sur les interruptions, mais présente comme établies des hypothèses sur les démarrages silencieux et la baisse du parallélisme.
Angle mort : Toutes assimilent largement ouverture du terminal, déplacement de l’attention et surveillance prolongée. Or une consultation initiale peut être utile sans empêcher le travail parallèle ; son coût dépend aussi du mode d’affichage.
Ce que tous ont manqué : Une comparaison réversible des deux comportements avec l’unique utilisateur, par type d’action. Les seuils proposés sont arbitraires : ouvrir manuellement peut traduire un manque de confirmation, sans démontrer qu’une ouverture automatique améliorerait l’usage.

## Classement agrégé

| Position | Lettre | Conseiller | Rang moyen | Relectures |
| --- | --- | --- | --- | --- |
| 1 | E | Outsider | 1 | 4 |
| 2 | A | Premiers principes | 2,25 | 4 |
| 3 | C | Expansionniste | 2,5 | 4 |
| 4 | B | Contrarien | 3,25 | 4 |
| 5 | D | Exécutant | 3,5 | 4 |

<!-- rangs moyens : Outsider 1, Premiers principes 2.25, Expansionniste 2.5, Contrarien 3.25, Exécutant 3.5 -->
