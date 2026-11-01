# Council : Quand une action de Cerebro lance une session d'agent (revue de code, commit, tâche du backlog), faut-il ouvrir automatiquement son terminal ?

Lancé le 2026-10-30T21:26:37.809Z · statut : succeeded · chairman : claude · opus · effort xhigh

## Question

Quand une action de Cerebro lance une session d'agent (revue de code, commit, tâche du backlog), faut-il ouvrir automatiquement son terminal ?

## Contexte

Cerebro est une application web locale, utilisée par une seule personne, son développeur, pour mener plusieurs sessions d'agents de code (Claude Code, Codex, Grok) en parallèle, projet par projet. Chaque session tourne dans un terminal. La barre latérale liste les sessions avec leur état (en cours, en attente d'une réponse, au repos) ; un clic ouvre le terminal d'une session. Les sessions continuent de tourner quand on ne les regarde pas, et Cerebro peut prévenir sur Slack quand une session attend une réponse ou a fini son tour.

Plusieurs actions de la page d'un projet lancent une session d'agent : le bouton de revue de code, le commit et push assisté, le démarrage d'une tâche du backlog.

Proposition : après chacune de ces actions, ouvrir automatiquement le terminal de la session lancée, pour voir l'agent démarrer et pouvoir lui répondre tout de suite.

## Synthèse

### Points d’accord

- **Le terminal n'est pas nécessaire à l'exécution.** Les cinq conseillers, A compris, admettent que la session tourne sans être regardée. La barre latérale et Slack signalent déjà quand une réponse est attendue. Personne ne propose de modifier les agents ni Slack.
- **Tout dépend d'une hypothèse que personne n'a mesurée** : après un lancement, l'utilisateur ouvre-t-il de toute façon le terminal, et l'agent pose-t-il une question rapidement ? Les cinq critères de changement d'avis portent tous sur ce point.
- **Plusieurs lancements d'affilée sont le pire cas.** C'est surtout vrai pour plusieurs tâches du backlog lancées l'une après l'autre (B, C, E) : chaque ouverture fait quitter la page projet, et seule la dernière session reste visible.
- **Une fois la session ouverte, rien ne doit la rouvrir automatiquement** quand son état change (A le dit, et personne ne le conteste).
- **En relecture, les avis convergent nettement.** Les quatre relecteurs reprochent à toutes les réponses d'appliquer une règle unique à trois actions qui ne se ressemblent pas, ou de ne pas tenir compte de ce que l'utilisateur veut faire au moment du clic. Trois d'entre eux proposent un lancement en arrière-plan avec un lien direct, ou un choix « Lancer » / « Lancer et ouvrir ».

### Désaccords

- **Oui (A), non (C, D, E), « ça dépend » (B).** Le désaccord tient à ce que chacun suppose de l'utilisateur au moment du clic. A suppose qu'il veut suivre la session (« j'ai cliqué, je veux voir »). D et E supposent qu'il délègue (« je lance, je passe à autre chose »). Les deux cas existent, mais pas pour les mêmes actions. La question ne se tranche donc pas par une règle globale : il faut décider action par action. C'est le cadrage de B, et c'est pour cela que je le suis.
- **Ce que coûte vraiment l'ouverture.** C insiste sur le vol du focus clavier : un « y » destiné à la session A atterrit dans la session B. D et A répondent que C confond « ouvrir » et « prendre le clavier ». Mon arbitrage : au moment du clic, l'utilisateur est sur la page projet, pas en train de taper dans un autre terminal. Le scénario de C ne se produit que si l'ouverture arrive *en retard*, une fois l'utilisateur passé ailleurs. Le garde-fou de A (ne jamais ouvrir le terminal si l'utilisateur a quitté la page entre-temps) suffit à l'empêcher. Le vrai coût est ailleurs : l'ouverture fait quitter la page projet, ce qui empêche d'enchaîner les lancements. Sur ce point, E a raison.
- **Mesurer d'abord ou livrer d'abord.** B veut deux semaines de journal avant tout changement, A veut livrer dès demain. Les relecteurs jugent les protocoles disproportionnés pour un outil qu'une seule personne utilise et qu'elle peut modifier en quelques minutes. Je tranche entre les deux : livrer tout de suite le comportement le moins intrusif, et le concevoir pour qu'il mesure lui-même l'usage.
- **Les critères de changement d'avis sont mal calibrés.** Celui de D (27 lancements sur 30 suivis d'une ouverture en moins de 3 s) est presque impossible à atteindre. Celui de E (vingt heures d'essai A/B avec cinq sessions simultanées) est irréaliste pour une seule personne. Celui de A (« jugées gênantes ») est subjectif. Celui de B est le plus utilisable.
- **Le classement n'est pas toujours juste.** A finit dernier parce qu'il répond à « comment » plutôt qu'à « faut-il », mais ses garde-fous sont les meilleurs du conseil et je les reprends tous. C finit avant-dernier pour sa dramatisation, mais son point sur les lancements en série est juste.

### Angles morts

**Relevés en relecture et retenus :**
- **Les trois actions ne se ressemblent pas** (B et C en relecture). Le commit est un échange court qu'on lance pour le conclure, la tâche du backlog est une délégation pure, et la revue se situe entre les deux.
- **« Ouvrir » recouvre trois choses distinctes** (D, E, A) : afficher le terminal, quitter la page projet, donner le focus clavier. Seules les deux dernières coûtent cher.
- **L'utilisateur devrait pouvoir dire ce qu'il veut au moment du clic** (D, E, A).
- **L'utilisateur est le développeur lui-même** : essayer un autre comportement coûte un drapeau, pas une étude.

**Relevé mais rejeté :** C propose en relecture de basculer automatiquement vers la session quand elle passe pour la première fois en « en attente ». C'est exactement une ouverture tardive, donc le pire cas de vol de focus. Je le garde comme raccourci clavier, jamais comme bascule automatique.

**Vus par personne :**
1. **En arrière-plan, la détection d'état devient vitale.** Si Cerebro ne reconnaît pas une invite de Codex ou de Grok, ou si l'agent échoue au démarrage (authentification expirée, CLI introuvable, dépôt dans un état inattendu), la session s'arrête sans que personne le voie. L'ouverture automatique cachait ce défaut, qui deviendra visible. La confirmation de lancement et la barre latérale doivent donc signaler les échecs de *démarrage de l'agent*, pas seulement ceux de création de la session.
2. **Le délai avant la première question dépend du mode de permissions**, pas de la nature de l'agent. Claude Code en mode par défaut demande une autorisation dès sa première commande shell. L'affirmation de C (« trente secondes de spinners, rien à répondre ») n'est pas vérifiée et dépend de la configuration de chaque agent.
3. **Personne n'a vérifié ce que fait réellement le flux de commit et push.** Le « oui pour le commit » proposé par B et C en relecture suppose que l'agent demande de valider le message ou le push. Si ce flux est entièrement autonome, l'exception tombe.
4. **Il existe déjà un geste connu pour exprimer ce choix** : le clic avec modificateur (comme Ctrl/Cmd-clic pour ouvrir un onglet dans un navigateur). Il évite de doubler chaque bouton avec un « Lancer et ouvrir ».

### Recommandation

**Non par défaut. Une seule exception possible, le commit et push, si son flux demande une validation.**

1. **Comportement par défaut pour les trois actions** : la session se lance en arrière-plan et l'utilisateur reste sur la page projet. Une confirmation s'affiche, par exemple « Revue lancée — Ouvrir (Entrée) », avec un lien direct vers le terminal. La nouvelle session apparaît en haut de la barre latérale. Si l'agent échoue au démarrage, la confirmation l'indique.
2. **Choix au moment du clic** : Maj-clic (ou Ctrl/Cmd-clic) lance la session *et* ouvre son terminal. Un seul bouton par action, pas de réglage supplémentaire.
3. **Exception pour le commit et push** : ouvrir automatiquement son terminal si, et seulement si, le flux demande une validation humaine (message, confirmation du push). C'est un échange court qu'on lance précisément pour le conclure. Si le flux est autonome, il suit le comportement par défaut.
4. **Garde-fous obligatoires, quel que soit le mode (repris de A)** :
   - n'ouvrir le terminal que juste après le clic, jamais une fois que l'utilisateur est passé ailleurs (changement de vue ou saisie ailleurs) ;
   - ne jamais donner le focus clavier à un terminal que l'utilisateur n'a pas choisi ;
   - ne jamais rouvrir un terminal quand l'état de la session change ;
   - désactiver le bouton pendant la création de la session ;
   - gérer l'ouverture dans une seule fonction partagée par les trois actions, avec une règle par action (`arriere-plan` | `ouvrir`).
5. **Mesurer sans protocole à part** : enregistrer localement chaque clic sur « Ouvrir » dans la confirmation, avec son délai. Si, sur une vingtaine de lancements, plus de 70 % des sessions d'une action sont ouvertes ainsi en moins de 10 s, passer cette action en ouverture automatique. C'est le critère de B, mais la mesure vient de l'usage normal.

**Pourquoi ce choix.** Les deux erreurs n'ont pas le même coût. Ouvrir à tort fait perdre la page projet et casse l'enchaînement des lancements, alors que tout le produit est conçu pour le travail en parallèle. Ne pas ouvrir à tort coûte un clic, ou une touche, sur la confirmation. Je ne suis pas A, malgré ses bons garde-fous : il généralise l'intention de suivre la session à des actions qui sont des délégations. Je ne suis pas D à la lettre non plus : « ne rien faire » oblige à chercher la session dans la barre latérale et ne traite pas le cas du commit.

### Première action

Dans le code qui gère la suite d'un lancement, regrouper les trois actions dans une seule fonction si ce n'est pas déjà fait. Cette fonction applique une règle par action, réglée sur `arriere-plan` pour les trois. Elle affiche la confirmation « <Action> lancée — Ouvrir (Entrée) » sans quitter la page projet, et enregistre localement `{action, heure du lancement, heure du clic sur Ouvrir}`. Dans la même séance, lire le prompt du flux de commit et push : s'il demande de valider le message ou le push, passer sa règle à `ouvrir`. Sinon, la laisser telle quelle.

## Avis

### A — Exécutant (codex · gpt-6.1-sol · effort xhigh)

**Oui. Une action qui lance explicitement un agent doit ouvrir son terminal dans la vue existante de Cerebro.** Le premier résultat à obtenir est simple : cliquer sur « Revue de code », voir la bonne session et pouvoir lui répondre.

Dès demain, procéder dans cet ordre :

1. **Livrer le parcours de revue de code.** Dès que la création renvoie l’identifiant de session, afficher son terminal, sans attendre le premier texte de l’agent. Pendant le démarrage, montrer un état de chargement.
2. **Réutiliser ce comportement** pour le commit et push assisté, puis pour les tâches du backlog. Centraliser l’ouverture pour éviter trois implémentations divergentes.
3. **Traiter les incidents immédiats.** Désactiver le bouton pendant la création pour empêcher les doublons. Si celle-ci échoue, conserver la page projet et afficher l’erreur. Si l’utilisateur a changé de page entretemps, ne pas imposer une navigation tardive.
4. **Vérifier les trois parcours**, avec plusieurs sessions déjà actives, puis simuler un démarrage lent et un échec. Les changements d’état ultérieurs ne doivent jamais rouvrir automatiquement le terminal.

**Ressources :** prévoir une journée d’un développeur connaissant le routage et la création des sessions. Aucun changement des agents ou de Slack n’est nécessaire. Le prérequis bloquant est l’obtention fiable de l’identifiant de session : s’il manque, commencer par cela. Attendre que chaque fournisseur d’agent soit « prêt » ajouterait une dépendance inutile et des délais variables.

Ne pas ajouter de préférence utilisateur pour cette première livraison.

**Je changerais d’avis si, sur les 30 prochains lancements, au moins 6 ouvertures étaient explicitement jugées gênantes par l’utilisateur dans un relevé d’usage.**

### B — Empiriste (claude · fable · effort xhigh)

## Observé, supposé, inconnu

**Observé (contexte fourni)** : un seul utilisateur ; les sessions tournent sans être regardées ; la barre latérale affiche l'état et un clic ouvre le terminal ; Slack prévient quand une session attend ou a fini. Trois actions lancent une session : revue, commit/push, tâche du backlog.

**Supposé** : que l'utilisateur veut « voir l'agent démarrer et répondre tout de suite ». Rien dans le contexte ne le mesure. Le reste du produit (états, Slack, parallélisme) est conçu pour l'inverse : ne pas regarder.

**Inconnu (non vérifié)** : délai entre lancement et premier clic manuel sur le terminal ; délai avant la première question de l'agent ; fréquence des lancements en rafale (plusieurs tâches du backlog d'affilée), où l'ouverture automatique volerait le focus à chaque fois.

## Hypothèse décisive

« Après un lancement, l'utilisateur ouvre de toute façon le terminal dans les 30 secondes, et l'agent pose sa première question dans la première minute. » Si c'est vrai, l'ouverture automatique économise un clic. Si c'est faux, elle interrompt.

Elle diffère probablement selon l'action : revue et commit demandent une confirmation, une tâche du backlog ressemble à un envoi sans surveillance. Non vérifié.

## Test le moins cher

Aucun changement d'interface. Journaliser localement, pour chaque lancement : action, horodatage, horodatage du premier clic manuel sur le terminal, horodatage du premier état « en attente d'une réponse », nombre de lancements dans les deux minutes précédentes. Trente lancements ou deux semaines.

## Seuil d'abandon

Abandonner l'ouverture automatique pour une action si moins de la moitié de ses lancements sont suivis d'un clic manuel sous 30 s, ou si plus d'un lancement sur cinq arrive en rafale.

## Ce qui me ferait changer d'avis

Le journal montrant, sur au moins 30 lancements, plus de 70 % de clics manuels sous 30 s et une première question de l'agent sous 60 s dans la majorité des cas. L'ouverture automatique ne serait alors qu'un raccourci d'un geste déjà fait.

### C — Contrarien (claude · fable · effort xhigh)

## Pré-mortem

Un an plus tard, l'ouverture automatique est désactivée par défaut, après trois mois de jurons. Le développeur répondait à un agent du projet A, a lancé une revue sur le projet B, et le terminal de B lui a volé le focus en pleine frappe. Deux fois, un « y » destiné à A a atterri dans B. La troisième, c'était une confirmation de push. Entre-temps, il a constaté que les trente premières secondes d'une session ne sont que spinners et appels d'outils : rien à répondre. Il est reparti ailleurs, et Slack l'a rappelé au bon moment, comme avant.

## Ce qui casse

La proposition contredit la thèse du produit. Cerebro existe pour le parallélisme : lancer, oublier, être prévenu. L'ouverture automatique transforme « lance et oublie » en « surveille ». Elle repose sur une hypothèse non vérifiée : que l'agent a besoin d'une réponse immédiate. En pratique, la première question arrive après la phase d'exploration, et la barre latérale plus Slack la signalent déjà.

Coût caché : le vol de focus. Toute saisie en cours part vers la mauvaise session, y compris les réponses aux demandes de permission. Effet de second ordre : plusieurs tâches du backlog lancées d'affilée produisent une cascade d'ouvertures ; la dernière gagne, les autres disparaissent du champ de vision.

Ça a déjà échoué ailleurs : panneaux de sortie qui s'ouvrent seuls dans les IDE, onglets qui prennent le focus dans les navigateurs. Tous finis en option désactivée.

## Le signal

Le développeur reclique sur la session précédente dans les cinq secondes suivant l'ouverture automatique. Quand ce geste devient réflexe, c'est fini.

## Ce qui me ferait changer d'avis

Deux semaines de journaux montrant que, dans plus de 70 % des lancements, aucune autre session n'était active, et que la première question de l'agent arrive en médiane sous quinze secondes. Alors l'ouverture ne vole rien, et je retire mon objection.

### D — Premiers principes (codex · gpt-6.1-sol · effort xhigh)

**Non. Garde l’ouverture du terminal explicite.**

Le vrai problème est de savoir quand l’agent a besoin de toi. Le terminal est un moyen d’intervenir ; son affichage n’est pas nécessaire à l’exécution.

Les faits élémentaires sont simples : les sessions travaillent sans être visibles, plusieurs peuvent tourner simultanément, et ton attention ne peut suivre qu’une activité à la fois. La barre latérale permet déjà de retrouver une session et signale son état. Slack peut signaler une demande de réponse. Rien n’impose donc de regarder chaque démarrage.

Ouvrir automatiquement le terminal économise un clic lorsque tu souhaites le consulter immédiatement. En contrepartie, cela impose un changement de contexte à chaque lancement, y compris lorsque tu voulais déléguer une tâche puis poursuivre ton travail. Dans une application conçue pour plusieurs agents en parallèle, ce coût contredit l’intérêt de la délégation.

Les deux alternatives donnent une réponse claire :

- **Ne rien faire** suffit : lancer la session en arrière-plan, la retrouver dans la barre latérale, l’ouvrir au clic. C’est ma recommandation.
- **Retirer quelque chose** consiste ici à retirer de la proposition le couplage entre lancement et navigation. Aucun nouveau réglage n’est nécessaire : les boutons déclenchent leur opération, le clic sur une session choisit ce que tu regardes.

Revue de code, commit et tâche du backlog ne justifient pas, par leur seul nom, une prise de contrôle de l’affichage.

**Je changerais d’avis si, sur 30 lancements observés, au moins 27 étaient suivis d’une ouverture manuelle du terminal en moins de trois secondes, avant toute autre action.**

### E — Expansionniste (codex · gpt-6.1-sol · effort xhigh)

**Non : chaque lancement doit permettre d’enchaîner immédiatement l’action suivante.** Le potentiel de Cerebro, c’est de donner à une seule personne la capacité de conduire dix agents simultanément. Ouvrir systématiquement leur terminal installe une habitude qui plafonne cette ambition : chaque délégation provoque un changement de contexte et invite à regarder travailler l’agent.

Visons dix fois plus haut : depuis la page projet, lancer une revue, démarrer trois tâches du backlog, préparer un commit ailleurs, puis intervenir là où une décision humaine débloque réellement le travail. La ressource à multiplier, c’est le nombre de travaux qui avancent pour chaque minute d’attention du développeur.

Concrètement, chaque action devrait créer sa session en arrière-plan, confirmer son lancement avec un accès direct au terminal et conserver la page courante. La barre latérale devient le centre de pilotage : progression, demandes de réponse, résultats disponibles. Les alertes existantes fournissent déjà le mécanisme pour rappeler le développeur au bon moment.

Cette décision ouvre une opportunité plus grande : lancer des groupes de tâches, enchaîner automatiquement revue et correction, préparer plusieurs propositions pendant que le développeur tranche une seule question. Chaque ouverture automatique consomme une partie du bénéfice de cette orchestration. Préserver l’attention dès aujourd’hui rend ces usages naturels demain.

**Je changerais d’avis si un essai alternant les deux comportements sur vingt périodes d’une heure, avec au moins cinq sessions simultanées, montrait que l’ouverture automatique augmente d’au moins 30 % le nombre de tâches terminées par heure.**

## Relectures

### Relecture par C — Contrarien (claude · fable · effort xhigh)

1. B : Seule réponse qui isole l'hypothèse décisive (ouvrirait-on le terminal de toute façon, l'agent pose-t-il une question tout de suite ?) et qui note que la réponse diffère selon l'action (revue/commit interactifs vs tâche de backlog déléguée). Test peu coûteux et seuils par action. Faiblesse : ne tranche pas, et deux semaines de journalisation sont lourdes pour un outil mono-utilisateur.
2. D : Non clair et bien ancré dans le contexte : barre latérale et Slack couvrent déjà le besoin, l'ouverture automatique contredit la délégation en parallèle. Mais règle uniforme pour trois actions hétérogènes, aucune alternative intermédiaire (toast, lien), et un critère de révision (27/30 en moins de 3 s) conçu pour être inatteignable.
3. E : Même conclusion que D avec la seule alternative concrète utile du conseil : créer en arrière-plan, confirmer avec un lien direct vers le terminal, rester sur la page. Pénalisé par un ton d'exhortation, des projections sur des fonctionnalités futures et un critère de révision (20 heures d'A/B avec 5 sessions simultanées, +30 % de débit) irréaliste pour une seule personne.
4. A : Excellent plan d'exécution (identifiant de session, état de chargement, pas de doublon, ne pas naviguer si l'utilisateur a changé de page, jamais de réouverture) et bon critère de révision. Mais répond « comment » plutôt que « faut-il » : la justification du oui tient en une phrase et ignore la tension centrale avec le parallélisme, surtout pour les tâches du backlog.
Angle mort : Tous raisonnent sur une règle unique alors que les trois actions n'ont pas la même nature : le commit et push assisté est un échange court où l'agent propose un message et demande confirmation en quelques secondes, la tâche du backlog est une délégation qui peut durer une heure, la revue est entre les deux. B l'effleure sans en faire le pivot. Un « oui » pour le commit, un « non » pour le backlog et un toast avec lien pour la revue dissoudraient le débat. Personne non plus ne regarde ce que montre réellement un terminal pendant les dix premières secondes d'une session Claude Code ou Codex : un démarrage sans rien à répondre, donc « voir l'agent démarrer » n'a presque aucune valeur.
Ce que tous ont manqué : Aucune réponse ne propose de déplacer le moment du focus automatique : plutôt qu'à l'ouverture, basculer vers la session (ou offrir un raccourci « aller à la dernière session lancée ») quand elle passe pour la première fois en « en attente d'une réponse », à condition que l'utilisateur ne soit pas déjà occupé dans un autre terminal. C'est exactement ce que les deux camps veulent, être là quand l'agent a besoin de soi, sans le changement de contexte au lancement. Et tous oublient que l'utilisateur est le développeur lui-même : le comportement se change et se rétablit en quelques minutes, ce qui rend les protocoles de mesure proposés disproportionnés face à un essai d'une semaine.

### Relecture par D — Premiers principes (codex · gpt-6.1-sol · effort xhigh)

1. B : La plus rigoureuse : distingue faits et hypothèses, envisage des comportements différents selon l’action et propose une vérification concrète. Ses seuils restent arbitraires et son protocole lourd pour un seul utilisateur.
2. E : Recommandation claire, cohérente avec le travail en parallèle, et solution concrète conservant un accès immédiat au terminal. L’ambition de dix agents et le seuil de productivité sont peu étayés.
3. A : Très utile pour réaliser une ouverture automatique robuste, notamment contre les navigations tardives. Mais elle suppose acquise la décision à évaluer et généralise aux trois actions sans justifier ce choix.
4. C : Identifie des risques pertinents d’interruption et de lancements successifs, mais les dramatise avec des scénarios non établis et des généralisations invérifiables. Confond souvent ouverture et capture du clavier.
Angle mort : Le sens exact d’« ouvrir » reste insuffisamment défini : afficher un panneau, quitter la page projet et donner le focus clavier ont des conséquences différentes. Cette distinction pourrait changer la décision.
Ce que tous ont manqué : Toutes omettent un choix explicite « Lancer » / « Lancer et ouvrir ». L’unique utilisateur pourrait essayer immédiatement ces deux parcours et choisir son défaut, sans attendre une campagne de mesures.

### Relecture par E — Expansionniste (codex · gpt-6.1-sol · effort xhigh)

1. B : Distingue les faits des hypothèses, envisage des différences entre actions et propose des observations utiles. Ses seuils restent arbitraires.
2. D : Recommandation claire et sobre, fondée sur le fonctionnement parallèle. Sous-estime toutefois l’intérêt du retour immédiat et exige trop pour changer d’avis.
3. A : Plan concret avec de bons garde-fous techniques, mais généralise l’ouverture automatique sans établir que l’utilisateur la souhaite dans les trois parcours.
4. C : Identifie utilement les risques de focus et de lancements successifs, mais les affirmations sur les délais et les précédents ailleurs sont sans preuve.
Angle mort : L’intention au moment du clic reste insuffisamment examinée : déléguer puis continuer, ou entrer immédiatement dans un échange. Le parallélisme ne tranche pas cette question, et une navigation attendue n’est pas nécessairement une interruption.
Ce que tous ont manqué : Un choix explicite au lancement : « Lancer » ou « Lancer et ouvrir », avec confirmation immédiate de création. Toutes omettent aussi de distinguer l’affichage du terminal de l’attribution du focus clavier.

### Relecture par B — Empiriste (claude · fable · effort xhigh)

1. C : Seule réponse qui nomme le vrai coût : le vol de focus avec frappe détournée (un « y » de confirmation de push dans la mauvaise session), la cascade d'ouvertures quand on lance plusieurs tâches, et le fait que les premières secondes n'offrent rien à répondre. Signal d'échec observable et condition de renversement réaliste.
2. E : Bon diagnostic (chaque ouverture consomme le bénéfice de la délégation) et seule à proposer le compromis pratique : confirmation de lancement avec lien direct vers le terminal, page courante conservée. Affaiblie par l'emphase visionnaire et un protocole d'essai disproportionné pour un outil mono-utilisateur.
3. D : Conclusion juste et sobre, appuyée sur les mécanismes existants (barre latérale, Slack), mais argumentation générique : ne mentionne ni le vol de focus ni la cascade, et le seuil de renversement (27/30 ouvertures manuelles en moins de trois secondes) est irréaliste.
4. A : Plan d'implémentation soigné (désactivation du bouton, pas de navigation tardive, pas de réouverture sur changement d'état) mais ne répond pas à la question : n'affronte jamais le parallélisme ni le vol de focus, et affirme le « oui » par principe sans l'étayer.
Angle mort : Aucune réponse ne distingue les trois actions. Le commit et push assisté est un flux court, interactif et à enjeu (valider le message, confirmer le push) où l'on veut presque toujours le terminal tout de suite ; la revue de code produit un résultat à lire plus tard ; la tâche du backlog est une pure délégation. Une règle unique pour les trois est le mauvais cadrage : la bonne réponse est probablement « oui » pour le commit et « non » pour les deux autres.
Ce que tous ont manqué : Toutes raisonnent comme si le choix était binaire et coûteux, alors que le mal réel est le vol de focus clavier, pas l'affichage. Une règle contextuelle règle l'essentiel : ouvrir le terminal seulement si aucune autre session n'est affichée ou en cours de saisie, sinon afficher une confirmation avec lien. Et pour un outil local utilisé par son seul développeur, l'expérience coûte un drapeau et une semaine d'usage : bien moins que les protocoles de renversement proposés.

### Relecture par A — Exécutant (codex · gpt-6.1-sol · effort xhigh)

1. D : Recommandation claire et proportionnée, fondée sur les capacités existantes et le coût d’attention. Le seuil de révision reste arbitraire.
2. B : Bonne distinction entre faits et hypothèses, avec des observations utiles par action. Mais tranche peu et propose des seuils insuffisamment justifiés.
3. E : Proposition concrète avec confirmation et accès au terminal. L’ambition de dix agents et le protocole de validation dépassent toutefois le besoin établi.
4. C : Repère les risques des lancements successifs, mais accumule des affirmations non étayées sur le focus, le démarrage des agents et les précédents ailleurs.
Angle mort : Le coût réel de l’ouverture est présumé : afficher un terminal, changer de vue et capter le focus clavier sont des comportements distincts. Un lancement volontaire peut aussi traduire une intention de suivi immédiat.
Ce que tous ont manqué : Aucune réponse ne propose d’exprimer cette intention au lancement : conserver le lancement en arrière-plan par défaut, avec une commande explicite « Lancer et ouvrir ».

## Classement agrégé

| Position | Lettre | Conseiller | Rang moyen | Relectures |
| --- | --- | --- | --- | --- |
| 1 | B | Empiriste | 1,25 | 4 |
| 2 | D | Premiers principes | 2 | 4 |
| 3 | E | Expansionniste | 2,5 | 4 |
| 4 | C | Contrarien | 3,25 | 4 |
| 5 | A | Exécutant | 3,5 | 4 |

<!-- rangs moyens : Empiriste 1.25, Premiers principes 2, Expansionniste 2.5, Contrarien 3.25, Exécutant 3.5 -->
