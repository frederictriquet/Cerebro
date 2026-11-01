# Council : Quand une action de Cerebro lance une session d'agent (revue de code, commit, tâche du backlog), faut-il ouvrir automatiquement son terminal ?

Lancé le 2026-10-30T21:44:38.991Z · statut : succeeded · chairman : claude · opus · effort xhigh

## Question

Quand une action de Cerebro lance une session d'agent (revue de code, commit, tâche du backlog), faut-il ouvrir automatiquement son terminal ?

## Contexte

Cerebro est une application web locale, utilisée par une seule personne, son développeur, pour mener plusieurs sessions d'agents de code (Claude Code, Codex, Grok) en parallèle, projet par projet. Chaque session tourne dans un terminal. La barre latérale liste les sessions avec leur état (en cours, en attente d'une réponse, au repos) ; un clic ouvre le terminal d'une session. Les sessions continuent de tourner quand on ne les regarde pas, et Cerebro peut prévenir sur Slack quand une session attend une réponse ou a fini son tour.

Plusieurs actions de la page d'un projet lancent une session d'agent : le bouton de revue de code, le commit et push assisté, le démarrage d'une tâche du backlog.

Proposition : après chacune de ces actions, ouvrir automatiquement le terminal de la session lancée, pour voir l'agent démarrer et pouvoir lui répondre tout de suite.

## Synthèse

### Points d’accord

- **Quatre conseillers sur cinq (A, B, C, E) rejettent l'ouverture systématique.** Même D, le seul à dire oui, ajoute des garde-fous qui en reconnaissent le coût : jamais de bascule tardive, et un simple lien si l'utilisateur a quitté la page.
- **Au moment du clic, la vraie question est « est-ce parti ? », pas « il m'attend ».** La seconde question est déjà couverte par l'état « en attente » dans la barre latérale et par Slack.
- **La ressource rare, c'est l'attention.** Les agents tournent en parallèle, mais on ne regarde qu'un terminal à la fois. Ouvrir le terminal à chaque lancement pénalise les lancements en rafale (trois tâches du backlog d'affilée), qui sont pourtant l'usage central de Cerebro.
- **Le terminal doit rester à un clic.** B et C proposent tous deux une confirmation visible avec un bouton « Ouvrir le terminal ». D arrive à la même chose dans son point 4.
- **Tous acceptent de revoir leur position selon l'usage réel**, avec un critère chiffré.

### Désaccords

- **D (oui) contre tous les autres (non).** C'est surtout l'angle imposé qui l'explique : l'exécutant part du oui et répond au « comment ». Son seul argument sur le fond, vérifier que la demande est partie, est mieux servi par une confirmation qui ne fait pas changer d'écran. Son rang de dernier est mérité sur la décision, mais son plan reste la meilleure liste de garde-fous.
- **E (« ne rien faire suffit ») contre B et C (il faut une confirmation).** B et C ont raison. Sans retour visible, on reclique et on lance des sessions en double. E identifie le besoin (« savoir si l'action a démarré ») sans y répondre.
- **A affirme qu'une question immédiate révèle un prompt incomplet.** Trois relecteurs le contestent, et ils ont raison : une demande d'approbation d'outil ou une validation du message de commit ne révèle aucun défaut de prompt. A voit juste sur le fond (pendant le chargement, il n'y a rien à répondre) mais généralise trop.
- **Ce qu'il faut mesurer : la frappe ou aussi la simple consultation.** Les critères de A, B, C et E reposent tous sur la saisie dans le terminal. Les relectures de C et D montrent que regarder sans taper a de la valeur : vérifier le projet, la demande, repérer une erreur. Un retour rapide sur la page projet peut donc signaler une vérification réussie, pas du bruit.
- **Mesurer ou essayer.** Les quatre réponses proposent des seuils qui supposent une instrumentation que Cerebro n'a pas. Les relectures de A et B le relèvent : quand l'auteur est l'unique utilisateur, une semaine d'essai coûte moins cher que le protocole de mesure. Je les suis.

### Angles morts

- **Les trois actions n'ont pas le même profil** (relectures de B et D). La revue et la tâche du backlog sont des travaux longs, délégués. Le commit-push assisté est court, presque synchrone, et peut demander une validation (message, cible du push) dans les premières secondes. Traiter les trois en bloc est une erreur.
- **Le mode de permissions décide de tout, et il est connu sans rien mesurer** (relecture de A). Si les agents sont lancés avec approbation des outils, ils bloquent tout de suite. En mode auto-approuvé, ils ne sollicitent personne avant plusieurs minutes. Ça se lit dans la commande de lancement de chaque agent.
- **Afficher, changer d'écran et prendre le focus clavier sont trois choses différentes** (relecture de E). Le scénario catastrophe de A, des frappes envoyées au mauvais agent, vient uniquement du vol de focus. Un aperçu qui ne fait pas changer d'écran n'a pas ce coût.
- **Le lancement lent suivi d'un changement de page.** Les boutons sont sur la page projet (B), mais si la création traîne et que l'utilisateur est entre-temps passé dans le terminal d'une autre session, l'ouverture automatique interrompt une conversation en cours. Le point 4 de D est donc indispensable.
- **Personne ne l'a vu : l'échec au démarrage.** Un agent qui plante au lancement (CLI non authentifié, quota atteint, mauvais répertoire) risque d'apparaître « au repos » dans la barre latérale, comme une session terminée. C'est le seul argument solide pour « voir démarrer », et une confirmation qui affiche aussi l'échec y répond mieux qu'un terminal ouvert.
- **Personne ne l'a vu : Slack ne sert que si l'on n'est pas devant Cerebro.** Quand on y est, il manque un signal dans l'application au moment où une session passe « en attente » (pastille, notification cliquable). C'est ce signal, pas l'ouverture au lancement, qui permet de « répondre tout de suite ».
- **Piste de B à garder pour plus tard** : afficher sur la page projet la question de l'agent ou le résultat de la revue, pour que le terminal devienne un outil d'inspection et non le passage obligé.

### Recommandation

**Non à l'ouverture automatique par défaut. Oui à un lancement clairement confirmé, avec l'ouverture comme geste explicite.**

1. **Clic = lancement en arrière-plan.** La page projet affiche aussitôt une confirmation qui reste visible : « Revue lancée · Ouvrir le terminal ». Le bouton est désactivé pendant la création, pour éviter les doublons, et une erreur explicite s'affiche si le lancement échoue.
2. **« Lancer et ouvrir » devient un geste explicite** : Maj-clic ou bouton secondaire. C'est l'intention au moment du clic qui décide, pas une règle unique (relectures de C et E).
3. **Exception possible pour le commit-push assisté, et pour lui seul**, à condition que son premier tour exige une réponse (validation du message, approbation d'un outil). À vérifier en lisant le prompt et le mode de permissions, pas avec de l'instrumentation. Si on retient l'ouverture pour le commit, elle se fait uniquement si l'utilisateur est encore sur la page d'origine, jamais avec retard, et sans prendre le focus clavier d'un terminal déjà actif.
4. **Investir plutôt dans un signal dans l'application quand une session passe « en attente »**, qu'on peut voir depuis n'importe quelle page. C'est là que se trouve le clic économisé que la proposition cherchait.

**Pourquoi je ne suis pas D :** son argument se résume à la confirmation du lancement, que la confirmation visible fournit sans pénaliser les lancements en rafale. Je reprends en revanche ses garde-fous (identifiant de session obtenu avant que l'agent soit prêt, jamais de bascule tardive). **Pourquoi je relativise A**, malgré la justesse de son pré-mortem : le risque qu'il décrit vient du vol de focus, que cette conception exclut d'emblée.

**Quand réviser :** après une semaine d'usage, si le Maj-clic sert pour la majorité des lancements d'une action donnée, l'ouverture devient le comportement par défaut pour cette action seulement. Pas besoin de tableau de bord : le développeur est l'unique utilisateur, sa propre gêne suffit comme mesure.

### Première action

Lancer une fois chacune des trois actions (revue, commit-push, tâche du backlog), ouvrir le terminal à la main et noter ce que l'agent demande dans la première minute : approbation d'un outil, validation du message de commit, cible du push, ou rien. En parallèle, relever le mode de permissions passé à Claude Code, Codex et Grok au lancement. Ça prend un quart d'heure et ça tranche l'exception du commit sans aucune instrumentation. Ensuite, implémenter la confirmation cliquable avec désactivation du bouton et état d'erreur, en commençant par le bouton de revue.

## Avis

### A — Contrarien (claude · fable · effort xhigh)

## Pré-mortem

Un an plus tard, l'ouverture automatique est désactivée dans les réglages et plus personne n'y pense. Ce qui s'est passé : le développeur enchaînait trois actions (revue, tâche du backlog, commit) et chaque lancement lui volait le focus et le terminal qu'il regardait. Pire : il tapait une réponse à l'agent A quand le terminal de B s'est ouvert ; ses frappes sont parties dans B, qui a pris un fragment de phrase pour une consigne. Après deux incidents, l'ouverture automatique est devenue un réflexe de fermeture, puis une option coupée.

## Ce qui va casser

L'hypothèse non vérifiée : « voir l'agent démarrer » aurait de la valeur. Pour une revue ou une tâche du backlog, les trente premières secondes sont du chargement de contexte, sans rien à répondre. Le moment utile, c'est « en attente d'une réponse », et la barre latérale plus Slack le signalent déjà. L'auto-ouverture duplique un signal existant et y ajoute un coût : une interruption forcée.

Si l'agent a besoin d'une réponse immédiate après un lancement scripté, c'est le prompt de l'action qui est incomplet, pas l'interface. L'auto-ouverture masque ce défaut au lieu de le corriger.

Effet de second ordre : l'outil est fait pour le parallélisme, et cette fonction punit le parallélisme. On finira par lancer les actions une par une.

## Signal d'alerte

Les terminaux auto-ouverts que l'on quitte en moins de cinq secondes. Si c'est la majorité, la fonction est du bruit. Et le premier message envoyé au mauvais agent.

## Ce qui me ferait changer d'avis

Deux semaines d'instrumentation sans auto-ouverture : la part des sessions lancées où le développeur tape dans le terminal durant la première minute. Au-dessus de 60 %, j'ai tort et l'ouverture par défaut se justifie.

### B — Utilisateur final (claude · fable · effort xhigh)

**Ce que je remarquerais.** Je clique sur « revue de code » et, d'un coup, je ne suis plus sur la page du projet : je suis devant un terminal qui défile. Si je ne lance qu'une chose, c'est agréable : je vois que ça démarre, je n'ai pas à me demander si le clic a pris. Mais si j'enchaîne trois tâches du backlog, l'écran saute à chaque clic et je perds ma liste. Et pour un commit‑push assisté, je n'ai rien à dire à l'agent : je veux rester où je suis et voir « poussé ».

**Ce que j'y gagne.** La certitude que la session existe, et zéro clic si l'agent me pose une question tout de suite.

**Ce que j'y perds.** Mon contexte. Les premières secondes d'une session sont rarement celles où l'agent a besoin de moi ; il me réclame cinq minutes plus tard, et la barre latérale et Slack me le disent déjà. L'ouverture automatique répond à « est‑ce parti ? », pas à « il m'attend ». Un accusé visible (« session lancée », cliquable) me donnerait la première chose sans me voler la seconde.

**Ce que je devrais supporter.** Apprendre à ne plus lancer en rafale, ou subir les sauts d'écran.

**À vérifier avant de décider** (tout ceci reste une intuition) : observer une semaine d'usage réel. Mesurer, pour chaque lancement, le délai avant la première frappe dans le terminal et la fréquence des retours vers la page du projet en moins de dix secondes. Compter les lancements groupés. Demander : « que fais‑tu dans les trente secondes après le clic ? »

**Ce qui me ferait changer d'avis.** Si, sur plus de la moitié des lancements mesurés, je tape dans le terminal dans les trente premières secondes, ou si je reclique un bouton faute de savoir si la session est partie, alors l'ouverture automatique est la bonne réponse.

### C — Expansionniste (codex · gpt-6.1-sol · effort xhigh)

**Non : une action doit lancer le travail, pas reprendre ton attention.** Ouvrir automatiquement le terminal transforme chaque délégation en invitation à superviser. Cerebro doit permettre de déclencher dix fois plus de travail sans multiplier les interruptions.

Le potentiel dépasse le confort d’un clic économisé : faire de la page projet un véritable poste de commande. Tu lances une revue, démarres deux tâches du backlog, prépares un commit, puis poursuis ton travail pendant que les agents avancent. Le terminal devient le lieu où tu interviens, et son ouverture reste une décision explicite.

Après chaque lancement, Cerebro doit afficher une confirmation immédiate et persistante : session créée, action engagée, état visible, bouton **Ouvrir le terminal**. Une session qui attend une réponse doit ressortir clairement dans la barre latérale ; Slack couvre déjà le besoin de prévenir lorsque tu regardes ailleurs.

Cette règle ouvre des possibilités beaucoup plus ambitieuses : lancer plusieurs tâches ensemble, enchaîner des étapes entre agents, suivre un objectif à travers plusieurs sessions. L’ouverture automatique impose au contraire un modèle où chaque nouveau travail réclame son passage à l’écran. Elle consomme précisément la ressource que les agents doivent libérer : ton attention.

Le bon indicateur devient **le travail accompli par intervention humaine**, plutôt que la vitesse à laquelle on voit apparaître les premières lignes du terminal.

**Ce qui me ferait changer d’avis :** sur 50 lancements sans ouverture automatique, au moins 70 % sont suivis d’une ouverture manuelle en moins de cinq secondes, puis d’un message envoyé à l’agent dans la minute.

### D — Exécutant (codex · gpt-6.1-sol · effort xhigh)

**Oui, pour ces trois actions explicites.** Le clic doit lancer la session puis afficher son terminal existant dans Cerebro. C’est le chemin le plus court pour vérifier que la demande est partie et répondre à une première question de l’agent.

**Dès demain, dans cet ordre :**

1. **Traiter la revue de code en premier.** Récupérer l’identifiant de la session créée et utiliser le mécanisme d’ouverture déjà déclenché par un clic dans la barre latérale. Premier résultat vérifiable : un clic sur « Revue » affiche le terminal de cette nouvelle session, avec la bonne demande.
2. **Afficher immédiatement un état de démarrage.** La connexion au terminal peut prendre du temps ; l’écran doit montrer cette attente, puis une erreur explicite si le lancement échoue. Désactiver le bouton pendant la création pour éviter les doublons.
3. **Étendre le même comportement** au commit assisté et au démarrage d’une tâche du backlog, en partageant la logique d’ouverture.
4. **Respecter une navigation intervenue entre-temps.** Si l’utilisateur a quitté la page pendant la création, signaler la session avec un lien pour l’ouvrir. Un démarrage lent ne doit pas provoquer un changement d’écran tardif.

Ressources : un développeur, une demi-journée allouée à l’implémentation et aux vérifications manuelles. La dépendance critique est l’obtention d’un identifiant de session avant que l’agent soit prêt. Attendre ses premières lignes pour naviguer rendrait le comportement lent et imprévisible.

Je changerais d’avis si, sur les 20 prochains lancements, au moins 6 sont suivis d’un retour au projet en moins de cinq secondes, sans interaction avec le terminal.

### E — Premiers principes (codex · gpt-6.1-sol · effort xhigh)

**Non. Lancer une session ne doit pas ouvrir automatiquement son terminal.**

Le vrai problème est de savoir si l’action a démarré et si elle réclame une intervention. Regarder l’agent commencer n’est pas un besoin en soi. Une revue doit produire une revue ; une tâche doit avancer. Leur lancement ne signifie pas que l’utilisateur souhaite maintenant les superviser.

La contrainte réelle est l’attention d’une seule personne face à plusieurs agents. Les agents travaillent en parallèle ; l’attention reste séquentielle. Ouvrir automatiquement un terminal transforme chaque délégation en changement de contexte imposé. Cela contredit l’intérêt même de déléguer : pouvoir continuer ailleurs pendant que le travail avance.

**Ne rien faire suffit ici.** La barre latérale indique déjà l’état des sessions, un clic permet de les consulter, et Slack peut signaler qu’une réponse est nécessaire. Ces mécanismes couvrent le besoin décrit. Aucun élément du contexte ne montre qu’un affichage automatique résoudrait un problème supplémentaire.

**L’option de retrait est de supprimer la consultation du terminal du parcours nécessaire à ces actions.** Lancer, puis quitter mentalement la tâche, doit être un parcours complet. Le terminal reste accessible pour intervenir ou inspecter le travail. Ajouter une ouverture systématique réintroduirait précisément l’étape dont l’exécution en arrière-plan permet de se passer.

Je changerais d’avis pour une action donnée si, sur 20 lancements observés, au moins 16 exigeaient une décision humaine indispensable dans les dix premières secondes, avant tout travail utile.

## Relectures

### Relecture par A — Contrarien (claude · fable · effort xhigh)

1. B : Seule réponse qui distingue les trois actions (le commit-push n'a rien à demander, les tâches du backlog se lancent en rafale) et qui sépare le vrai besoin, « est-ce parti ? », du besoin supposé, « il m'attend ». Propose l'accusé cliquable comme alternative et des mesures précises. Hésite à trancher, mais donne le meilleur matériau pour décider.
2. C : Non clair et bien fondé sur la ressource rare, l'attention, avec une alternative concrète : confirmation persistante plus bouton « Ouvrir le terminal ». Critère de révision chiffré et raisonnable. Perd en justesse par l'emphase (poste de commande, dix fois plus de travail) qui dépasse la question posée.
3. E : Principe juste (agents parallèles, attention séquentielle) et conclusion nette, mais « ne rien faire suffit » esquive le problème que la réponse identifie elle-même : savoir que l'action a démarré. Aucune alternative proposée, et un seuil de révision (16 sur 20) presque impossible à atteindre, donc peu falsifiable.
4. D : Prend le « oui » pour acquis et livre un plan d'implémentation sans peser le coût principal : perte de contexte et sauts d'écran lors de lancements multiples, ni différence entre actions. Quelques points utiles (état de démarrage, bouton désactivé, navigation intervenue) mais la question était « faut-il », pas « comment ».
Angle mort : Toutes traitent l'ouverture comme une navigation plein écran qui remplace la page projet, d'où un faux dilemme entre « voir démarrer » et « garder son contexte ». Un aperçu non navigant (volet latéral ou queue de sortie en ligne sous le bouton), un clic modifié (clic = fond, Maj-clic = ouvrir) ou un réglage par action dissout le compromis. Et comme l'utilisateur est le développeur, un simple interrupteur essayé une semaine coûte moins que les protocoles de mesure que les quatre réponses proposent.
Ce que tous ont manqué : Le facteur décisif est connu sans rien mesurer : le mode de permissions des sessions lancées. Si Claude Code ou Codex demandent des approbations d'outils dans les premières secondes, l'ouverture immédiate se justifie ; en mode auto-approuvé ou headless, l'agent ne sollicite personne avant plusieurs minutes et l'ouverture n'a aucune valeur. Personne ne note non plus le cas le plus coûteux : lancer une action alors qu'on est déjà dans le terminal d'une autre session, où l'ouverture automatique interrompt une conversation en cours plutôt qu'une simple page.

### Relecture par E — Premiers principes (codex · gpt-6.1-sol · effort xhigh)

1. B : Le meilleur arbitrage : bénéfices, interruptions, lancements groupés et alternative concrète. Les observations proposées aideraient à décider, même si les seuils restent arbitraires.
2. C : Recommandation cohérente avec le travail parallèle, accompagnée d’une confirmation visible et d’un accès explicite au terminal. Les ambitions d’orchestration dépassent toutefois le besoin présenté.
3. D : Proposition opérationnelle, attentive aux erreurs et aux changements de page pendant le démarrage. Mais le choix initial du « oui » reste peu justifié face au coût des interruptions.
4. A : Pré-mortem utile sur le focus et les frappes mal dirigées. L’affirmation qu’une question immédiate révèle forcément un prompt incomplet est fausse et fragilise le raisonnement.
Angle mort : Les réponses distinguent insuffisamment afficher le terminal, remplacer la page et lui donner le focus clavier. Ces comportements ont des coûts d’interruption très différents.
Ce que tous ont manqué : Proposer deux intentions au lancement : « Lancer » en arrière-plan et « Lancer et ouvrir ». Cela permettrait de choisir selon la situation, sans imposer une règle unique.

### Relecture par C — Expansionniste (codex · gpt-6.1-sol · effort xhigh)

1. B : La plus équilibrée : distingue confirmation et intervention, considère les lancements groupés et propose un accusé cliquable.
2. D : Solution concrète qui traite erreurs, doublons et navigation tardive ; le choix d’ouvrir systématiquement reste insuffisamment justifié.
3. E : Bonne analyse du coût d’attention, mais « ne rien faire » suppose que les signaux existants confirment suffisamment le lancement.
4. A : Identifie des risques pertinents, mais dramatise la capture des frappes et assimile à tort toute question immédiate à un prompt incomplet.
Angle mort : Les critères d’évaluation négligent la consultation passive : vérifier le bon projet, la bonne demande ou une erreur peut être utile sans taper. Un retour rapide au projet peut donc témoigner d’une vérification réussie.
Ce que tous ont manqué : Toutes omettent un choix explicite au lancement : garder une action principale adaptée au flux habituel et proposer un geste secondaire pour « lancer et ouvrir » ou « lancer en arrière-plan ».

### Relecture par B — Utilisateur final (claude · fable · effort xhigh)

1. A : La plus juste et la plus concrète : identifie que les 30 premières secondes sont du chargement sans rien à répondre, que le signal utile (« en attente ») existe déjà, nomme un mode de défaillance réel (frappes envoyées au mauvais agent), relève qu'un besoin de réponse immédiate trahit un prompt incomplet, et donne un critère de réfutation mesurable.
2. C : Bon raisonnement sur l'attention comme ressource et seule réponse à proposer une alternative concrète (confirmation persistante avec bouton « Ouvrir le terminal »). Perd un peu en rigueur avec un discours de vision (« poste de commande », enchaînements multi-agents) qui dépasse la question posée.
3. E : Juste sur le fond (attention séquentielle, agents parallèles, mécanismes existants suffisants) mais reste abstrait : « ne rien faire » sans traiter le besoin réel qu'il nomme lui-même, savoir que l'action a bien démarré. Redondant avec C en moins actionnable.
4. D : Seule réponse « oui », mais sans peser le coût sur le parallélisme ni le fait que Slack et la barre latérale couvrent déjà le besoin. Son plan d'implémentation est solide (identifiant de session avant le prêt, état de chargement, pas de bascule tardive après navigation, ce qui neutralise d'ailleurs le scénario d'A), mais il décrit comment faire sans justifier pourquoi.
Angle mort : Les quatre traitent les trois actions comme un bloc. Or elles n'ont pas le même profil : une revue de code et une tâche du backlog sont des travaux longs de fond, alors qu'un commit et push assisté est un flux court, synchrone, où l'agent va presque sûrement demander de valider un message ou une cible de push dans les secondes qui suivent. La bonne réponse est probablement par action (non pour revue et backlog, oui ou question inline pour le commit), et dépend de ce que le premier tour de l'agent exige réellement. Personne n'a non plus noté qu'au moment du clic l'utilisateur est sur la page projet, pas dans un autre terminal, ce qui change le coût d'une ouverture immédiate par rapport à une ouverture différée.
Ce que tous ont manqué : Tous raisonnent en « terminal ou rien ». L'option intermédiaire manque : faire remonter sur la page projet le premier tour de l'agent (sa question éventuelle, ou le résultat de la revue comme artefact), de sorte que le terminal devienne un outil d'inspection et non le lieu obligé de l'interaction. Par ailleurs, pour un outil mono-utilisateur dont l'auteur est l'utilisateur, le choix est quasi gratuit et réversible : un réglage par action, une semaine d'essai, et l'on tranche sur la gêne ressentie. Les quatre proposent des seuils de mesure qui supposent une instrumentation que Cerebro n'a pas, alors que le simple essai coûte moins que le débat.

### Relecture par D — Exécutant (codex · gpt-6.1-sol · effort xhigh)

1. C : La plus exploitable : recommandation claire, confirmation visible, accès explicite au terminal et critère de réévaluation.
2. B : Bonne analyse des bénéfices et des coûts, avec observation des usages. Mais des clics répétés justifieraient surtout un meilleur accusé de lancement.
3. E : Raisonnement solide sur l’attention, mais « ne rien faire suffit » néglige la confirmation du démarrage ; son seuil de révision est trop restrictif.
4. A : Souligne les risques du parallélisme, mais dramatise un incident hypothétique et affirme à tort qu’une question immédiate révèle nécessairement un prompt incomplet.
Angle mort : La recommandation reste trop uniforme : l’intention au clic et le déroulement réel de chaque action comptent. Un commit assisté peut appeler un échange immédiat ; une revue peut être entièrement déléguée.
Ce que tous ont manqué : La consultation sans saisie : vérifier le périmètre, lire une erreur ou observer le démarrage peut justifier l’ouverture. Tous leurs critères de réévaluation privilégient la frappe ou une décision humaine immédiate, sans mesurer cette valeur.

## Classement agrégé

| Position | Lettre | Conseiller | Rang moyen | Relectures |
| --- | --- | --- | --- | --- |
| 1 | B | Utilisateur final | 1,25 | 4 |
| 2 | C | Expansionniste | 1,75 | 4 |
| 3 | E | Premiers principes | 3 | 4 |
| 4 | A | Contrarien | 3,25 | 4 |
| 5 | D | Exécutant | 3,25 | 4 |

<!-- rangs moyens : Utilisateur final 1.25, Expansionniste 1.75, Premiers principes 3, Contrarien 3.25, Exécutant 3.25 -->
