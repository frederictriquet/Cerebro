# Council : Quand une action de Cerebro lance une session d'agent (revue de code, commit, tâche du backlog), faut-il ouvrir automatiquement son terminal ?

Lancé le 2026-10-30T21:38:10.254Z · statut : succeeded · chairman : claude · opus · effort xhigh

## Question

Quand une action de Cerebro lance une session d'agent (revue de code, commit, tâche du backlog), faut-il ouvrir automatiquement son terminal ?

## Contexte

Cerebro est une application web locale, utilisée par une seule personne, son développeur, pour mener plusieurs sessions d'agents de code (Claude Code, Codex, Grok) en parallèle, projet par projet. Chaque session tourne dans un terminal. La barre latérale liste les sessions avec leur état (en cours, en attente d'une réponse, au repos) ; un clic ouvre le terminal d'une session. Les sessions continuent de tourner quand on ne les regarde pas, et Cerebro peut prévenir sur Slack quand une session attend une réponse ou a fini son tour.

Plusieurs actions de la page d'un projet lancent une session d'agent : le bouton de revue de code, le commit et push assisté, le démarrage d'une tâche du backlog.

Proposition : après chacune de ces actions, ouvrir automatiquement le terminal de la session lancée, pour voir l'agent démarrer et pouvoir lui répondre tout de suite.

## Synthèse

### Points d’accord

- **L'attention du développeur est la ressource que Cerebro doit économiser.** L'outil existe pour faire avancer plusieurs sessions en parallèle. Même E, le seul « oui » franc, limite l'ouverture à une seule fois et uniquement après un clic de l'utilisateur.
- **Un événement d'arrière-plan ne doit jamais changer le terminal affiché.** Cela vaut pour une notification, un changement d'état ou une fin de tour (B, D, E). Une fois la session démarrée, la barre latérale et Slack suffisent pour la suivre.
- **Les risques techniques sont les mêmes pour tous :**
  - un terminal ouvert avant que le PTY soit branché s'affiche vide (B, D) ;
  - si la création de la session est lente, la bascule peut arriver pendant que l'utilisateur tape ailleurs (B, E).
- **Si on ouvre, le code passe par un seul endroit.** La même fonction sert aux trois boutons, sans nouvelle dépendance (B, E).
- **La décision coûte peu à défaire.** Chacun donne un critère chiffré pour changer d'avis.

### Désaccords

- **Sur le fond :**
  - A, C et D répondent non : rester sur la page du projet.
  - E répond oui, une seule fois, et seulement après un clic.
  - B répond oui par défaut, avec un réglage, à condition que tout passe par un seul endroit du code.
- **Première raison du désaccord : que se passe-t-il au démarrage de l'agent ?** C et D affirment qu'il n'y a rien à répondre dans les premières secondes. B rappelle qu'avec Claude Code hors mode automatique, la première demande de permission arrive souvent dans les dix premières secondes. La réponse dépend du mode de permission choisi par Cerebro au lancement, et personne ne l'a vérifié.
- **Deuxième raison : ce que veut l'utilisateur quand il clique.** A, C et D supposent qu'il délègue et passe à autre chose. E suppose qu'il veut échanger avec l'agent. Chaque camp a raison pour une partie des actions, pas pour toutes.
- **Faut-il un réglage ?** B le demande, les autres le jugent inutile pour un utilisateur unique. Je tranche contre B : un réglage global cacherait la vraie différence, qui se joue action par action.
- **Les critères pour changer d'avis ne se valent pas :**
  - celui de A (test alterné sur 100 lancements, +20 % de débit) n'est pas réaliste pour une personne seule ;
  - celui de C (24 sur 30 avec une réponse indispensable) ne sera presque jamais atteint ;
  - ceux de D (délai entre lancement et premier clic) et de E (6 retours en arrière sur 20) se mesurent facilement.
- **Le classement ne dit pas tout.** C est premier pour sa sobriété, B dernier parce qu'il ne tranche pas. Pourtant B est celui qui a vu les risques d'implémentation les plus concrets.

### Angles morts

- **Une même règle pour trois actions différentes.** Les cinq relectures le relèvent, aucune réponse ne l'a traité :
  - le commit et push assisté est court, l'utilisateur attend son résultat, et il se termine par un push, une action vers l'extérieur difficile à défaire ;
  - la revue de code produit un résultat à lire à la fin, pas au début ;
  - la tâche du backlog est une délégation longue, qu'on lance pour l'oublier.
- **Le mode de permission au lancement (B, D).** C'est un fait vérifiable dont dépend tout l'argument « répondre tout de suite ». Si une revue demande une permission dès les premières secondes, la solution est de régler le lancement (permissions déjà accordées, consigne passée en argument), pas d'ouvrir le terminal.
- **Le choix « ouvrir ou rester » est trop binaire.** Deux autres options existent :
  - afficher un aperçu du terminal dans un panneau, sans prendre le clavier (B, C, E) ;
  - proposer un bouton « Lancer et ouvrir » à côté du lancement simple (A).
- **Personne n'a vu l'échec rapide de l'agent.** CLI non authentifiée, quota épuisé ou worktree invalide : la session s'arrête en deux secondes. Si on ne l'a pas ouverte, l'état « au repos » ressemble à « terminé ». Lancer en arrière-plan n'est sûr que si cet échec est signalé clairement.
- **Personne n'a vu non plus les notifications Slack en double.** Si le terminal d'une session est affiché, la prévenir sur Slack qu'elle attend une réponse ne sert à rien. Ce point compte dès qu'on ouvre automatiquement le terminal du commit.

### Recommandation

**Ne pas ouvrir par défaut, sauf pour le commit.** Pour la revue et le backlog, je suis la majorité (C, A, D). Pour le commit et push assisté, je donne raison à E, le dissident, et à l'angle mort relevé par toutes les relectures.

**Commit et push : ouvrir le terminal.** L'utilisateur attend ce résultat avant de continuer, valide le message, et le push qui suit est difficile à défaire. C'est le moment où il faut regarder. L'argument de C (« voir l'agent démarrer ne fait pas avancer le travail ») ne tient pas ici : le travail, justement, c'est cette validation.

**Revue de code et tâche du backlog : rester sur la page du projet.**
- Afficher une confirmation cliquable avec le nom et l'état de la session (A), et mettre la session en évidence dans la barre latérale.
- Quand on veut ponctuellement suivre une session, utiliser Maj+clic ou une entrée « Lancer et ouvrir ». Pas de réglage global, contrairement à ce que propose B.

**Garde-fous quand on ouvre (repris de E et B) :**
- un seul point de code, par exemple `launchSession(action, { open })` ;
- une seule ouverture, et seulement si l'utilisateur est encore sur la même page et n'a rien fait ailleurs depuis son clic ;
- afficher le terminal une fois le PTY branché, avec un état « démarrage » en attendant ;
- aucun événement d'arrière-plan ne déplace l'affichage.

**Condition pour lancer en arrière-plan sans risque.** Un échec dans les premières secondes doit apparaître comme « échec » dans la barre latérale et dans la confirmation, pas comme « au repos ».

**À vérifier dans la foulée.** Regarder avec quel mode de permission la revue et le backlog sont lancés. S'ils posent une question au démarrage, corriger les arguments de lancement plutôt que d'ouvrir le terminal.

**Pas de panneau d'aperçu pour l'instant.** C'est une refonte de l'affichage dont le besoin n'est pas démontré.

**Révision sur données après deux semaines :**
- si plus de 80 % des revues et tâches du backlog sont ouvertes à la main en moins de 10 secondes (critère de D), les ouvrir aussi automatiquement ;
- si plus d'un tiers des terminaux de commit ouverts automatiquement sont quittés en moins de 5 secondes sans frappe (critère de B), arrêter de les ouvrir.

**Pourquoi ne pas suivre C entièrement.** C a la meilleure analyse du coût d'attention, mais sa règle unique ignore le seul cas où l'utilisateur attend de toute façon le résultat.

### Première action

Faire passer les trois boutons par une seule fonction de lancement, avec un paramètre `open` fixé par action :
- commit : `true` ;
- revue et backlog : `false`, avec une confirmation cliquable.

Pour chaque session, enregistrer dans un journal l'action, l'heure de lancement, celle du premier état « en attente » et celle de la première ouverture manuelle du terminal.

Avant de valider, lancer deux revues puis un commit à la suite et vérifier trois choses :
- seul le commit fait basculer l'affichage ;
- le terminal du commit n'est pas vide ;
- aucun changement d'état des revues ne déplace l'affichage.

## Avis

### A — Expansionniste (codex · gpt-6.1-sol · effort xhigh)

**Non : chaque lancement doit pouvoir rester en arrière-plan.** Le potentiel de Cerebro, c’est de permettre à une personne de faire avancer dix chantiers simultanément. Ouvrir systématiquement le terminal transforme chaque délégation en sollicitation immédiate et consomme l’attention nécessaire pour lancer le chantier suivant.

Visons dix fois plus haut : depuis la page du projet, tu déclenches plusieurs revues, tu démarres des tâches du backlog, puis tu poursuis ton travail pendant que les agents exécutent. Cerebro rend cette activité lisible et fait remonter les décisions qui nécessitent ton intervention. La ressource à multiplier, c’est le travail accompli par minute de ton attention.

Cette décision ouvre trois possibilités concrètes :

- **Lancer en série** plusieurs tâches sans quitter la page du projet.
- **Piloter par exception** : repérer immédiatement les sessions qui attendent une réponse, avec un accès direct à leur terminal.
- **Préparer les lancements groupés** : sélectionner plusieurs tâches et les déléguer d’un geste, sans subir une cascade d’ouvertures.

Après un lancement, affiche une confirmation cliquable avec le nom de la session et son état réel. Le terminal reste accessible immédiatement. L’enjeu est de donner assez de visibilité pour déléguer avec confiance, puis libérer l’attention pour la suite.

**Je changerais d’avis si un test alterné sur 100 lancements de tâches comparables montrait que l’ouverture automatique augmente d’au moins 20 % le nombre de tâches achevées par heure de présence du développeur.**

### B — Mainteneur (claude · fable · effort xhigh)

## Coût de possession

**Charge récurrente.** Faible si l'ouverture passe par un seul point : un événement « session créée » qui déclenche la navigation. Élevée si chacun des trois boutons appelle lui-même l'ouverture : le quatrième bouton l'oubliera, et chaque refonte de la barre latérale touchera trois endroits au lieu d'un.

**Incidents probables.**
- *Vol de focus.* L'utilisateur tape une réponse dans la session A, le commit assisté démarre et bascule sur la session B. La frappe part dans le mauvais agent. C'est le seul effet irréversible de la proposition, et il survient dès qu'on enchaîne deux actions.
- *Course au démarrage.* Le terminal s'ouvre avant que le PTY soit attaché : écran vide, rechargement manuel. Il faudra un état d'attente et un délai. C'est le vrai code à maintenir.
- *Actions distantes.* Si une tâche est lancée depuis Slack, l'ouverture n'a pas de sens ; il faudra une exception.

**Dépendances.** Aucune nouvelle. Le composant terminal et le routeur existent déjà et vivront aussi longtemps que l'application.

**Irréversible.** Les habitudes de l'utilisateur unique. Dans deux ans, retirer l'ouverture automatique sera vécu comme une régression, pas comme une simplification.

## Porte de sortie

Un seul réglage, lu à un seul endroit, activé par défaut. Le retour en arrière coûte alors un changement de valeur par défaut. Sans ce point central, la sortie coûte trois correctifs et une chasse aux appels dispersés : dans ce cas, je refuse la proposition.

## Ce qui me ferait changer d'avis

Un compteur sur un mois d'usage : le nombre de terminaux ouverts automatiquement puis quittés en moins de cinq secondes sans qu'une touche y soit frappée. Au-dessus d'un tiers des ouvertures, la fonctionnalité coûte plus qu'elle ne rend et je la retire, réglage ou non. À zéro message envoyé dans le mauvais terminal sur la même période, le réglage lui-même devient superflu.

### C — Premiers principes (codex · gpt-6.1-sol · effort xhigh)

**Non. Le lancement doit conserver la page courante.**

Le vrai problème est de permettre à plusieurs agents d’avancer avec un minimum d’attention humaine. Ouvrir leur terminal automatiquement consomme précisément la ressource que Cerebro cherche à économiser : l’attention de son utilisateur.

Les faits élémentaires sont simples : une session travaille sans être regardée ; son terminal reste accessible en un clic ; son état indique quand elle attend une réponse. Voir l’agent démarrer ne fait pas avancer son travail. Cela sert surtout à vérifier que le lancement a réussi, ce que l’apparition de la session dans la barre latérale permet déjà de constater.

L’ouverture automatique impose aussi une hypothèse injustifiée : chaque lancement annoncerait une conversation immédiate. Une revue peut tourner pendant qu’on prépare une autre tâche. Le parallélisme perd son intérêt si chaque départ détourne l’utilisateur de son activité.

**Ne rien faire suffit** : lancer la session, rester sur le projet, laisser les états existants signaler le besoin d’intervention. L’utilisateur ouvre le terminal quand il veut le consulter.

**Retirer quelque chose** est la bonne option si certaines actions provoquent déjà cette navigation : supprimer ces ouvertures forcées. Aucun réglage supplémentaire n’est nécessaire.

Je changerais d’avis si, sur 30 lancements consécutifs observés, au moins 24 étaient suivis d’une ouverture manuelle du terminal en moins de cinq secondes et d’une réponse indispensable au démarrage effectif du travail.

### D — Contrarien (claude · fable · effort xhigh)

## Pré-mortem

Dans un an, l'option est désactivée depuis longtemps, ou Cerebro est redevenu un lanceur de terminaux, un seul à la fois. L'ouverture automatique a réintroduit le réflexe que l'outil devait tuer : regarder l'agent démarrer. Le développeur lance une tâche du backlog, le terminal s'ouvre, il attend que le contexte se charge, puis seulement il lance la suivante. Le parallélisme, raison d'être de Cerebro, s'est érodé sans qu'aucune décision ne l'ait acté.

## Ce qui casse

- **L'hypothèse « répondre tout de suite » est fausse presque toujours.** Les premières secondes d'une session sont du chargement de contexte, rien à répondre. Le cas utile est déjà couvert : état « en attente » dans la barre latérale et notification Slack.
- **Vol de focus.** L'action part de la page projet ; en arracher l'utilisateur après chaque clic transforme trois lancements successifs en trois allers-retours. C'est exactement le comportement que les IDE finissent tous par rendre désactivable.
- **Navigation implicite qui gêne la suite.** Lancement groupé de plusieurs tâches, déclenchement depuis Slack ou un script : chaque nouveau chemin devra trancher s'il ouvre ou non, et une course entre création de session et ouverture donnera des terminaux vides.

## Signaux avant-coureurs

Retour arrière dans les cinq secondes après ouverture ; lancements devenus séquentiels au lieu de groupés ; une case « ne pas ouvrir » ajoutée dans le mois.

## Ce qui me ferait changer d'avis

Journaliser deux semaines, sans auto-ouverture, le délai entre lancement et premier clic sur le terminal. Si dans plus de 80 % des cas le clic survient sous dix secondes, l'automatisation n'économise qu'un clic et je me range. Idem si plus de la moitié des sessions posent une question dans les trente premières secondes.

### E — Exécutant (codex · gpt-6.1-sol · effort xhigh)

**Oui : une action explicite qui lance un agent doit afficher son terminal, une seule fois.** On doit pouvoir vérifier immédiatement que la demande est partie et répondre à une éventuelle question. Les changements d’état ultérieurs restent dans la barre latérale et les notifications.

Dès demain, procéder dans cet ordre :

1. **Commencer par la revue de code.** Après confirmation de la création de la session, sélectionner son identifiant et afficher son terminal avec le mécanisme déjà utilisé par le clic dans la barre latérale. Ne pas attendre la première sortie de l’agent. Premier résultat vérifiable : un clic sur « Revue » lance exactement une session et montre le bon terminal.
2. **Appliquer ce comportement au commit assisté et au backlog.** Réutiliser la même fonction d’ouverture. Si le lancement échoue, conserver la page et afficher l’erreur. Si l’utilisateur a changé de page pendant la création, ne pas lui reprendre la navigation.
3. **Vérifier les cas qui cassent le travail parallèle.** Lancer deux sessions successivement ; recevoir une notification d’une ancienne session ; provoquer un échec de lancement. Aucun événement d’arrière-plan ne doit changer le terminal affiché.

Ressources : le développeur seul, les composants existants et une courte vérification avec un agent réel. Viser une première version dans la journée. Ajouter une préférence, refondre la navigation ou modifier les trois intégrations d’agents allongerait inutilement le chemin ; cette évolution doit rester dans l’interface de lancement.

**Je changerais d’avis si, sur 20 lancements réels, au moins 6 ouvertures étaient immédiatement annulées par un retour à la page précédente en moins de trois secondes, sans saisie dans le terminal.**

## Relectures

### Relecture par D — Contrarien (claude · fable · effort xhigh)

1. E : Décision nette et bornée : ouverture une seule fois, uniquement sur action explicite, jamais sur événement d'arrière-plan. Traite l'échec de lancement et le cas où l'utilisateur a déjà changé de page, réutilise le mécanisme existant, refuse le réglage. Plan exécutable dans la journée et critère de retour en arrière réaliste.
2. C : Non argumenté au plus près du but de Cerebro : l'attention est la ressource rare, la barre latérale confirme déjà le lancement et signale l'attente. Option « ne rien faire » bien défendue. Mais balaie trop vite le besoin de répondre aux questions de démarrage, et son seuil de révision (24 sur 30 avec réponse indispensable) est calibré pour ne jamais être atteint.
3. B : Seule réponse à voir les risques d'implémentation réels : course entre ouverture et attachement du PTY, vol de focus si la création est lente, lancements distants depuis Slack. Mais ne tranche pas, conditionne tout à un point central et à un réglage superflu pour une application mono-utilisateur, et surjoue l'irréversibilité des habitudes.
4. A : Bonne idée de confirmation cliquable comme voie médiane, mais noyée dans un discours d'ambition (« dix fois plus haut ») et un élargissement hors sujet vers les lancements groupés. Le critère de révision (test alterné sur 100 lancements, +20 % de débit) est inapplicable pour un développeur seul.
Angle mort : Les quatre réponses appliquent une règle uniforme à trois actions de nature différente. Le commit et push assisté est court, conversationnel et quasi synchrone : on veut voir le message proposé et valider. La tâche du backlog est une délégation longue qu'on lance pour l'oublier. La revue de code produit un résultat à lire à la fin, pas au début. La bonne réponse est probablement « oui » pour le commit, « non » pour le backlog, et indifférente pour la revue. Personne ne pose la question action par action.
Ce que tous ont manqué : Le fait qui tranche est observable et aucune réponse ne demande à le vérifier : les agents posent-ils réellement une question dans les premières secondes ? Cela dépend entièrement de la façon dont Cerebro les lance (mode de permissions préréglé, dossier déjà approuvé, prompt initial passé en argument). Si le lancement est configuré pour ne rien demander au départ, l'argument « répondre tout de suite » disparaît et le débat n'a plus d'objet. Les états de session et les notifications Slack existants permettent de mesurer en quelques jours le délai médian entre création et première attente de réponse, sans écrire de code. Personne n'a non plus relevé que la proposition est réversible en une ligne et que la décision ne mérite ni réglage ni long débat : l'essai instrumenté pendant une semaine coûte moins que n'importe laquelle des analyses proposées.

### Relecture par C — Premiers principes (codex · gpt-6.1-sol · effort xhigh)

1. A : La mieux alignée sur le parallélisme ; sa confirmation cliquable apporte une solution concrète qui préserve visibilité et contrôle.
2. E : Proposition précise et garde-fous pertinents contre les changements de navigation tardifs, mais l’ouverture systématique reste insuffisamment justifiée.
3. D : Bonne analyse du coût d’attention, affaiblie par des conséquences dramatisées et des hypothèses non vérifiées sur le démarrage.
4. B : Centralisation utile, mais incidents techniques trop affirmatifs ; l’absence de frappes mal dirigées ne rend pas une préférence superflue.
Angle mort : Les réponses raisonnent uniformément sur trois actions dont les besoins peuvent différer : un commit assisté peut appeler un échange immédiat, une tâche du backlog une délégation autonome. Les usages réels du développeur devraient départager ces cas.
Ce que tous ont manqué : Dissocier affichage et prise de focus : un aperçu du terminal dans la page projet, sans déplacer le focus clavier, pourrait rendre le démarrage visible tout en permettant d’enchaîner les lancements.

### Relecture par A — Expansionniste (codex · gpt-6.1-sol · effort xhigh)

1. C : La plus solide sur l’objectif de parallélisme : elle exploite les signaux existants et préserve l’attention. Son critère pour changer d’avis est toutefois trop restrictif.
2. E : La plus opérationnelle : ouverture unique, gestion des échecs et protection contre une navigation tardive. Mais lancer explicitement un agent ne signifie pas nécessairement vouloir consulter son terminal.
3. D : Bon examen des interruptions et des effets sur les lancements successifs. Plusieurs affirmations centrales restent spéculatives, notamment sur les premières secondes des sessions.
4. B : Identifie des risques techniques utiles, mais ajoute prématurément un réglage et présente abusivement les habitudes comme irréversibles. Un événement global de création risque aussi d’ouvrir des sessions sans intention locale.
Angle mort : Toutes supposent une politique uniforme, sans établir si le développeur veut généralement enchaîner les lancements ou suivre l’agent immédiatement, ni si cette intention diffère entre revue, commit et backlog.
Ce que tous ont manqué : Le choix peut être explicite à chaque lancement : une action « Lancer et ouvrir » peut compléter le lancement en arrière-plan, sans préférence globale. Cela évite de déduire l’intention de consultation de la seule création d’une session.

### Relecture par B — Mainteneur (claude · fable · effort xhigh)

1. D : Le plus profond : nomme les mécanismes concrets de dérive (retour au séquentiel, vol de focus, course création/ouverture donnant des terminaux vides, futurs déclencheurs Slack/script), donne des signaux avant-coureurs observables et une mesure réaliste pour un seul développeur (journaliser deux semaines le délai lancement → premier clic).
2. C : Juste et économe : identifie l'attention comme la ressource que l'outil doit protéger, montre que la barre latérale couvre déjà le besoin de « vérifier que c'est parti », recommande de ne rien ajouter voire de retirer les ouvertures forcées existantes. Moins de cas limites que D, mais critère de réversibilité concret.
3. A : Bonne direction et seule à proposer une alternative intermédiaire utile (confirmation cliquable avec nom et état de la session), mais le ton visionnaire prend le pas sur l'analyse, et le test alterné sur 100 lancements mesurant les tâches/heure est irréaliste pour un développeur seul.
4. E : Plan d'exécution soigné (ouvrir une seule fois, ne jamais reprendre la navigation, aucun événement d'arrière-plan ne change le terminal, tests des cas parallèles), mais la prémisse est faible : la vérification du départ est déjà donnée par la barre latérale et les premières secondes n'appellent presque jamais de réponse. Le critère de 6 annulations sur 20 est toutefois le plus facile à mesurer.
Angle mort : Toutes traitent les trois actions comme équivalentes. Or le commit et push assisté est court, synchrone et bloquant : l'utilisateur attend son résultat et doit souvent valider le message ou une résolution avant de continuer, donc y voir le terminal est naturel. La revue de code et la tâche du backlog sont longues et déléguées. La réponse défendable est par action, pas globale, et aucune ne l'a envisagé.
Ce que tous ont manqué : Deux faits concrets du contexte. D'abord, avec Claude Code hors mode automatique, la première demande de permission arrive souvent dans les dix premières secondes : l'affirmation « rien à répondre au démarrage » dépend du mode de permission configuré par session, point que personne ne vérifie. Ensuite, la fausse dichotomie « ouvrir ou rester » : un terminal peut s'afficher en volet latéral ou en aperçu sans quitter la page du projet, ce qui donne la visibilité recherchée par la proposition sans le vol de focus dénoncé par les trois « non ». Enfin, l'utilisateur étant le développeur, l'expérience coûte une heure : brancher le comportement derrière un flag, journaliser une semaine, trancher sur les données plutôt que sur des principes.

### Relecture par E — Exécutant (codex · gpt-6.1-sol · effort xhigh)

1. A : La plus utile pour décider : elle préserve le parallélisme, propose une confirmation cliquable et mesure le bénéfice sur le travail accompli.
2. C : Raisonnement sobre, solidement ancré dans les fonctions existantes. Son critère de révision exige toutefois trop : consulter immédiatement peut être utile sans réponse indispensable.
3. D : Bons exemples de perturbations et signaux observables, mais plusieurs affirmations sur les habitudes et le démarrage des agents restent spéculatives.
4. B : Apporte une réflexion technique utile, mais justifie peu l’ouverture par défaut. Le déclenchement sur toute création de session élargit inutilement la proposition, et les seuils restent arbitraires.
Angle mort : L’intention du développeur au lancement reste inconnue. Déléguer une revue et engager un commit interactif peuvent appeler des comportements différents ; le parallélisme ne suffit pas à trancher uniformément.
Ce que tous ont manqué : Toutes assimilent l’ouverture du terminal à une navigation qui interrompt. Un affichage dans un panneau sans prise de focus pourrait rendre le démarrage visible tout en conservant la page et la saisie courantes.

## Classement agrégé

| Position | Lettre | Conseiller | Rang moyen | Relectures |
| --- | --- | --- | --- | --- |
| 1 | C | Premiers principes | 1,75 | 4 |
| 2 | A | Expansionniste | 2,25 | 4 |
| 3 | E | Exécutant | 2,25 | 4 |
| 4 | D | Contrarien | 2,5 | 4 |
| 5 | B | Mainteneur | 3,75 | 4 |

<!-- rangs moyens : Premiers principes 1.75, Expansionniste 2.25, Exécutant 2.25, Contrarien 2.5, Mainteneur 3.75 -->
