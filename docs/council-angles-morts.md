# Angles morts des councils : relevé du 2026-10-30

Première étape de l'epic « Council : exploiter l'analyse « quelles personas ajouter » »
(council du 2026-10-22). Avant d'ajouter un siège, on vérifie sur les angles morts déjà
enregistrés quels axes manquent vraiment. Aucun appel LLM : le script extrait, le
classement est fait à la main.

**Règle de décision** : un axe présent dans au moins un tiers des runs mérite une
persona ; un axe absent n'en mérite pas.

## En bref

- La base de cette machine ne contient que **2 runs**, lancés le 2026-10-22 à huit
  minutes d'intervalle, soit **34 occurrences** d'angles morts. La tâche en prévoyait
  10 à 20.
- Formellement, les quatre axes passent le seuil, car un run sur deux y suffit :
  preuve 1/2, coût 1/2, durée 2/2, parties prenantes 2/2. Aucun n'est absent.
- **Verdict : non concluant.** Avec 2 runs, la règle ne distingue rien. Ces données ne
  justifient ni d'agrandir le conseil par défaut, ni de retirer un axe. Ne pas toucher à
  `defaultPersonaIds`.
- Le signal le plus net ne vient pas des trois personas recommandées. L'axe
  **utilisateur et parties prenantes** domine : 15 occurrences sur 34, présent dans les
  deux runs. Les 8 occurrences « preuve » viennent toutes du council sur les personas
  lui-même. Le coût n'apparaît qu'une fois, pour recommander de régler les manques dans
  les prompts existants, sans siège de plus.
- Aucun council enregistré n'a d'issue connue. La section 5 propose à la place trois
  décisions passées du projet dont l'issue est connue, à faire valider avant
  l'évaluation.

## 1. Données

Script : [`scripts/council-blindspots.mjs`](../scripts/council-blindspots.mjs). Il lit
les N derniers runs de `council_runs` (20 par défaut), les plus récents d'abord. Pour
chaque run, il affiche `reviews[].blindSpot`, `reviews[].missed` et chaque puce de
`synthesis.blindSpots`, avec une référence stable : `<run>/R2.missed` pour une
relecture, `<run>/S3` pour la 3e puce de la synthèse. La base est ouverte avec
`readOnly: true` : SQLite refuse toute écriture et ne crée pas une base absente.

```sh
sqlite3 -readonly ~/.cerebro/cerebro.db ".backup /tmp/cerebro-copie.db"
node --disable-warning=ExperimentalWarning scripts/council-blindspots.mjs /tmp/cerebro-copie.db
node --disable-warning=ExperimentalWarning scripts/council-blindspots.mjs /tmp/cerebro-copie.db --json
```

Vérification faite sur une copie : empreinte SHA-256, date de modification et taille
identiques avant et après les deux exécutions (Markdown et JSON), aucun fichier
`-journal` créé. Le script tourne aussi sur la copie passée en lecture seule
(`chmod 444`). Sur un chemin absent, il échoue sans créer de fichier.

| Run | Lancé le | Question | Projet | Conseillers |
|---|---|---|---|---|
| `17a12488` | 2026-10-22 23:10 | Quelles autres personas ajouter au council de Cerebro ? | Cerebro | 5 réponses, 5 relectures : Contrarien, Expansionniste, Exécutant (codex · gpt-6-astra) ; Premiers principes, Outsider (claude · opus) |
| `dc5f51f6` | 2026-10-22 23:02 | Comment donner envie d'utiliser l'IA à une petite équipe de développeurs ? | hors projet | 4 réponses, 4 relectures : l'Expansionniste (grok) a échoué, faute de crédits |

Données hors de portée : le pair MacBook a peut-être ses propres runs. Son API exige le
jeton d'administration, que les sessions d'agent ne reçoivent pas. Pour compléter le
relevé, lancer le script sur une copie de sa base.

## 2. Grille de classement

| Axe | Code | Une occurrence en relève quand elle porte sur… |
|---|---|---|
| Preuve et faits | P | des données, une vérification, une mesure, la confrontation des affirmations aux faits |
| Coût et option zéro | C | le coût (argent, temps, appels, latence), un arbitrage, ne rien faire ou faire moins |
| Durée et réversibilité | D | les effets dans le temps, la maintenance, une migration, ce qui devient irréversible |
| Utilisateur et parties prenantes | U | les personnes concernées : utilisateurs, équipe, management, leurs motivations, craintes et usages réels |
| Autre | A | le reste : méthodes de décision, conception du council, découpage du domaine |

- Une occurrence reçoit **un seul axe principal** : celui du premier point qu'elle
  soulève. Les autres axes qu'elle touche sont notés en secondaire, sans être comptés.
- Une puce de synthèse compte pour une occurrence. La synthèse reprend souvent un point
  des relectures (« relevé par A et B »). Ce doublon gonfle le nombre d'occurrences,
  mais pas le décompte par run sur lequel repose la règle.

## 3. Décompte

| Axe | Relectures | Synthèses | Occurrences | Runs (sur 2) | Seuil d'un tiers |
|---|---:|---:|---:|---:|---|
| Preuve et faits | 6 | 2 | 8 | 1 (`17a12488`) | atteint |
| Coût et option zéro | 0 | 1 | 1 | 1 (`17a12488`) | atteint |
| Durée et réversibilité | 0 | 3 | 3 | 2 | atteint |
| Utilisateur et parties prenantes | 9 | 6 | 15 | 2 | atteint |
| Autre | 3 | 4 | 7 | 2 | sans objet |
| **Total** | **18** | **16** | **34** | | |

Par run : `17a12488` compte P 8, C 1, D 1, U 2 et A 6. `dc5f51f6` compte D 2, U 13 et
A 1.

Si l'on compte aussi les axes secondaires, la preuve passe à 2 runs sur 2
(`dc5f51f6/S3` : un essai trop court conclut à tort). Le coût reste à 1 run sur 2. Le
verdict formel ne change pas.

## 4. Verdict

**Verdict formel.** Les quatre axes atteignent un tiers des runs : tous
« mériteraient » une persona, aucun n'est écarté.

**Verdict réel : non concluant.** Trois raisons :

1. **Effectif.** Un tiers de 2 runs, c'est un seul run. Une occurrence isolée suffit
   donc à faire passer un axe, et la règle ne peut rien écarter.
2. **Biais du sujet.** `17a12488` est le council sur les personas. Son sujet est de
   savoir comment juger qu'une persona aide, d'où les angles morts de preuve et de
   mesure. Les 8 occurrences « preuve » viennent toutes de lui. Dans l'autre run, un
   relecteur reproche au contraire aux réponses de traiter la résistance « comme un
   problème de preuve » (`dc5f51f6/R3.blindSpot`).
3. **Contexte.** Les deux runs datent du jour de la mise en service du council et
   utilisent les cinq mêmes personas.

**Ce que les données indiquent malgré tout** (indices, pas preuves) :

- **Parties prenantes** : c'est l'axe dominant, avec 13 occurrences sur 16 dans
  `dc5f51f6`, et il apparaît aussi dans `17a12488` (`R4.blindSpot`, `S8`). Il ne figure
  pas parmi les trois personas recommandées (Empiriste, Économiste, Mainteneur), mais
  dans le catalogue spécialisé (Utilisateur final, Analyste des incitations). Deux
  relectures préviennent qu'un rôle simulé ne remplace pas la consultation des
  personnes concernées (`17a12488/R1.blindSpot`, `R3.blindSpot`). Une telle persona
  doit donc signaler ce qu'il faut vérifier auprès de vraies personnes, comme le prévoit
  déjà la tâche du catalogue.
- **Coût et option zéro** : une seule occurrence, `17a12488/S5`. Elle recommande de
  régler les manques dans les prompts existants (pré-mortem, option zéro obligatoire,
  « ce qui me ferait changer d'avis »), sans siège de plus. Cela soutient le
  renforcement des prompts plutôt qu'une nouvelle persona.
- **Durée et réversibilité** : 3 occurrences, réparties sur les deux runs. La migration
  de `DEFAULT_PERSONAS` (`17a12488/S7`) fait déjà l'objet d'une tâche de l'epic.
- En axe principal, le coût et la durée ne viennent que des synthèses du chairman.
  Aucun relecteur ne les a relevés en premier.

**Conséquences proposées pour l'epic** :

- Garder `defaultPersonaIds` inchangé, comme le prévoit déjà l'epic.
- Ajouter les personas au catalogue sans les cocher et renforcer les prompts : ces
  changements restent raisonnables, car ils sont réversibles et n'ajoutent aucun appel.
- Inclure l'axe parties prenantes dans l'évaluation à budget constant (Utilisateur final
  ou Analyste des incitations), en plus de l'Empiriste.
- Relancer ce relevé quand toutes les machines réunies compteront au moins 10 runs,
  idéalement une fois l'issue observée enregistrée sur chaque run.

## 5. Trois décisions à issue connue pour l'évaluation

Aucun des deux runs enregistrés ne convient :

- l'issue de `17a12488` est justement ce que cet epic doit établir, l'utiliser serait
  circulaire ;
- `dc5f51f6` est hors projet, et son issue n'est enregistrée nulle part.

Voici trois décisions passées du projet dont l'issue est connue, à soumettre comme
questions de council. Elles viennent des notes de session de l'assistant, conservées
hors dépôt, et de l'historique Git. **La sélection doit être validée par l'utilisateur.**

| # | Question à soumettre | Décision | Issue connue | Ce qu'un bon conseil aurait dû dire | Axes testés |
|---|---|---|---|---|---|
| 1 | Faut-il déléguer par défaut l'implémentation aux CLI Codex et Grok pour économiser le quota Claude ? | 2026-10-14 | Abandonné le lendemain : le quota Claude était loin d'être entamé. Les jauges d'usage arrivent le même jour, le 2026-10-15. | Mesurer la consommation réelle avant de réorganiser le travail : l'option zéro suffisait. | C, P |
| 2 | Faut-il automatiser entièrement l'intégration des copies de travail, avec un bouton « Tout intégrer » qui enchaîne les mises à jour et les merges ? | 2026-10-27 | Refusé le jour même : l'utilisateur veut lancer chaque intégration lui-même. Seule l'aide aux conflits a été automatisée (commits `b16d50a` à `a7e47df`, 2026-10-28). | Laisser l'utilisateur maître de chaque intégration, difficile à défaire, et automatiser l'assistance plutôt que l'enchaînement. | D, U |
| 3 | Quand une action de Cerebro lance une session d'agent (revue de code, commit, tâche du backlog), faut-il ouvrir automatiquement son terminal ? | 2026-10-16 au plus tard | Refusé à plusieurs reprises : les sessions tournent en arrière-plan et l'utilisateur les suit depuis la liste. | Partir de l'usage réel : l'utilisateur lance plusieurs sessions et ne veut pas quitter sa page. | U |

Précautions pour la tâche d'évaluation :

- **Pas de run d'origine.** Chaque cas demande d'abord un run de référence avec la
  composition actuelle. Avec 5 conseillers, chaque run coûte 11 appels (2N + 1) : 33
  appels pour les trois références, puis 33 par persona évaluée. Il faut annoncer ce
  total avant de lancer quoi que ce soit.
- **Fuite de l'issue.** Laisser « lire le projet » décoché et le web coupé. Rédiger
  la question et le contexte tels qu'ils se présentaient avant la décision. Seul le
  cas 2 gagne à lire le dépôt : utiliser alors une copie prise avant la décision, au
  commit `f31a2ac` (2026-10-26). Les cas 1 et 3 se rejouent sans le dépôt. Le premier
  n'en dépend pas, et pour le second, la date de la première demande n'est pas connue
  précisément.
- **Limite.** Les issues des cas 2 et 3 sont des préférences de l'utilisateur, pas des
  faits mesurés. Seul le cas 1 a une issue factuelle. Sur les cas 2 et 3, l'apport
  attendu d'un Empiriste est de dire quoi demander ou observer chez l'utilisateur. Le
  jugement doit en tenir compte.

## 6. Classement détaillé

Axe principal en gras. Les axes secondaires ne sont pas comptés.

### `17a12488`, quelles personas ajouter

| Référence | Source | Résumé | Axe | Secondaire |
|---|---|---|---|---|
| `R1.blindSpot` | relecture Contrarien | Une persona simulée n'apporte ni expertise ni information nouvelle sans données externes ni consultation des personnes concernées | **P** | U |
| `R1.missed` | relecture Contrarien | Personne ne vérifie après coup si les décisions sont meilleures (prédictions, confiance, résultats observés) | **P** | — |
| `R2.blindSpot` | relecture Premiers principes | Un prompt de rôle ne donne qu'une diversité de style ; il faut varier les accès, sinon l'Empiriste invente ses preuves | **P** | A |
| `R2.missed` | relecture Premiers principes | Méthodes éprouvées ignorées (six chapeaux, pré-mortem, Delphi…), pas de routeur, pas de mesure de la redondance | **A** | P |
| `R3.blindSpot` | relecture Expansionniste | Un rôle simulé n'apporte ni données nouvelles ni vraie représentation des personnes concernées | **P** | U |
| `R3.missed` | relecture Expansionniste | Mesurer la qualité des décisions sur des cas à issue observable, à budget comparable | **P** | C |
| `R4.blindSpot` | relecture Outsider | Aucune réponse ne part de l'usage réel de Cerebro, c'est-à-dire des questions effectivement soumises | **U** | A |
| `R4.missed` | relecture Outsider | Cadres reconnus ignorés ; pas de persona « vérificateur » qui confronte les affirmations aux faits | **A** | P |
| `R5.blindSpot` | relecture Exécutant | Valeur des personas supposée : pas de comparaison contrôlée avec et sans chaque rôle, gain face au coût et à la latence | **P** | C |
| `R5.missed` | relecture Exécutant | Protocole pour garder les désaccords utiles : ce qui ferait changer d'avis, preuves pour trancher | **A** | P |
| `S1` | synthèse | Une persona n'est qu'un prompt : sans accès variés, elle invente ses preuves | **P** | A |
| `S2` | synthèse | La convergence du conseil montre que l'angle façonne la forme plus que le fond | **A** | — |
| `S3` | synthèse | Personne ne mesure la qualité réelle des décisions ; comparer les compositions à budget égal | **P** | C |
| `S4` | synthèse | Méthodes éprouvées ignorées ; le « chapeau rouge » (intuition, valeurs) n'a pas de titulaire | **A** | U, D |
| `S5` | synthèse | Plusieurs manques se règlent dans les prompts existants, sans siège de plus (pré-mortem, option zéro obligatoire) | **C** | A |
| `S6` | synthèse | Pas de routeur qui choisisse les personas selon la question | **A** | — |
| `S7` | synthèse | `DEFAULT_PERSONAS` n'est lu qu'à la création de la base : une migration est nécessaire | **D** | — |
| `S8` | synthèse | Le nom « Expansionniste » n'est pas parlant pour un nouveau venu | **U** | — |

### `dc5f51f6`, donner envie d'utiliser l'IA à une petite équipe

| Référence | Source | Résumé | Axe | Secondaire |
|---|---|---|---|---|
| `R1.blindSpot` | relecture Contrarien | Le changement touche l'identité professionnelle et la peur de perdre ses compétences ; un gain mesuré n'y répond pas | **U** | — |
| `R1.missed` | relecture Contrarien | Rôle et motivation du manager, pratiques d'équipe à long terme, droit de rester non-utilisateur | **U** | D |
| `R2.blindSpot` | relecture Premiers principes | Distinguer pour chaque personne les causes du refus | **U** | — |
| `R2.missed` | relecture Premiers principes | L'envie dépend du travail qui restera ; décider avec l'équipe quoi préserver | **U** | D |
| `R3.blindSpot` | relecture Outsider | Les réponses traitent la résistance comme un problème de preuve ; identité, peur d'être remplacé, méfiance envers la direction | **U** | — |
| `R3.missed` | relecture Outsider | Exemplarité et apprentissage entre pairs dans la durée, familles d'outils, temps d'apprentissage | **U** | D, A |
| `R4.blindSpot` | relecture Exécutant | Pas de distinction des situations individuelles (expérience, peur, compétences, désaccord technique) | **U** | — |
| `R4.missed` | relecture Exécutant | Accompagnement pratique de l'apprentissage : temps protégé, formation, binômes | **U** | D |
| `S1` | synthèse | Les causes du refus diffèrent d'une personne à l'autre | **U** | — |
| `S2` | synthèse | L'identité professionnelle : décider avec l'équipe ce qu'on garde « à la main » | **U** | — |
| `S3` | synthèse | La courbe d'apprentissage : un essai d'une demi-journée conclura à tort à l'échec | **D** | P |
| `S4` | synthèse | L'exemplarité du manager ; dire pourquoi on pousse l'IA | **U** | — |
| `S5` | synthèse | Les familles d'outils demandent des apprentissages différents | **A** | — |
| `S6` | synthèse | Les règles d'équipe dans la durée : responsabilité du code généré, relecture, zones interdites | **D** | A |
| `S7` | synthèse | Le droit de rester durablement non-utilisateur | **U** | D |
| `S8` | synthèse | La taille de l'équipe : un seul senior hostile peut faire basculer la dynamique | **U** | — |
