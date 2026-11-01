# Notation à l'aveugle des 15 synthèses

Contre-jugement de l'évaluation [`council-evaluation-personas.md`](../council-evaluation-personas.md).

Le correcteur est un agent distinct. Il a lu trois fichiers, un par cas, avec les cinq
synthèses du cas mélangées et étiquetées S1 à S5. Pour chaque synthèse, il disposait
des points d'accord, de la recommandation et de la première action. Il connaissait
l'issue réelle de chaque décision, pas la composition à l'origine de chaque synthèse.

Consigne : juger ce qui se serait passé si le développeur avait suivi la synthèse à la
lettre (recommandation et surtout première action), au vu de l'issue connue. Pour
chaque synthèse, il donne une conformité et une note de 0 à 10.

La colonne « Condition » a été ajoutée après la notation, depuis la clé de mélange.

## Cas 1, `delegation`

| Synthèse | Condition | Conformité | Note | Justification du correcteur |
|---|---|---|---:|---|
| S3 | Économiste | conforme | 9 | Reprend « l'option zéro de A ». Sa première action (« prends 10 minutes pour mesurer ») conclut : « Si tu es loin des plafonds, la question est réglée pour la semaine ». Le plan garde quelques préparations inutiles. |
| S1 | Empiriste | conforme | 8 | `/usage` avec un seuil fixé d'avance : « moins d'un septième du plafond hebdomadaire : le problème n'existe pas encore. Ne construis aucune délégation ». Un peu de travail en trop (`AGENTS.md`, essai Codex puis Grok dans le plan). |
| S5 | Référence | conforme | 7 | `/usage`, puis « Sinon, ne change rien ». Ajoute dans tous les cas 15 minutes pour `AGENTS.md`, et un essai qui ne dépend pas de la mesure : trois configurations, dont « Claude qui pilote Codex ». |
| S4 | Mainteneur | partielle | 5 | « Sans ce chiffre, tout le reste est spéculatif », mais la première action met en place et teste le repli (`AGENTS.md`, `HANDOFF.md`, tâche réelle confiée à Codex) sans seuil. Ce travail était inutile. |
| S2 | Utilisateur final | partielle | 4 | Première action : 45 minutes pour écrire le contexte commun et tester une reprise à froid par Codex. `/usage` n'y est qu'un point sur cinq, sans seuil ni option zéro. |

Selon le correcteur, S3, S1 et S5 forment un bloc et leurs écarts d'un point ne sont pas
significatifs. Le seul écart net sépare S5 de S4 : d'un côté la mesure décide de la
suite, de l'autre on construit le repli d'emblée.

## Cas 2, `integration`

| Synthèse | Condition | Conformité | Note | Justification du correcteur |
|---|---|---|---:|---|
| S2 | Référence | partielle | 6 | Remarque qu'une copie sans conflit s'intègre déjà en un clic. Ne construit qu'avec des lots médians d'au moins 3 copies. Prévoit la branche « le goulot est la résolution… améliorer le renvoi d'un conflit vers sa conversation », ce qui a été fait le lendemain. Reste ouverte à « Intégrer les copies prêtes ». |
| S1 | Empiriste | partielle | 5 | Première action sans code, mais un seuil bas (médiane ≥ 2) qui mène à deux ou trois semaines de script de lot, puis à une file à confirmation unique. L'aide aux conflits n'est évoquée qu'en passant. |
| S5 | Mainteneur | partielle | 5 | Bon motif de refus (« il supprime le seul filtre actuel, la pause humaine »), première action de mesure. Mais l'étape 1 se fait dans tous les cas, et rien n'aide à résoudre les conflits. |
| S3 | Économiste | partielle | 4 | Meilleur diagnostic (le bouton supprime la relecture du diff, pas les conflits). Mais la première action est une journée de code pour qu'« Intégrer » enchaîne mise à jour et merge : on automatise l'enchaînement plutôt que l'aide aux conflits. |
| S4 | Utilisateur final | contraire | 3 | « Oui à une intégration de lot atomique », « ne rien faire serait donc un mauvais choix », première action `simulateBatch`. Contient pourtant, « en parallèle », la seule idée exactement juste : confier la résolution à la conversation propriétaire. |

Notes resserrées : aucune synthèse ne recommande d'abord de garder l'intégration
manuelle copie par copie et d'aider à résoudre les conflits.

## Cas 3, `auto-open`

| Synthèse | Condition | Conformité | Note | Justification du correcteur |
|---|---|---|---:|---|
| S3 | Économiste | conforme | 8 | « Non, quelle que soit l'action ». Sa première action commence par vérifier si un lancement change déjà de vue, pour le supprimer. Porte laissée ouverte pour le commit, mais seulement si l'usage réel le montre. |
| S5 | Référence | conforme | 8 | « Non : pas d'ouverture automatique », avec le motif même de l'issue (« Tu lances une revue justement pour ne pas avoir à la suivre »). Le commit n'est qu'une exception envisageable après une semaine d'usage. |
| S1 | Utilisateur final | partielle | 6 | Non par défaut, confirmation cliquable. Mais une exception possible pour le commit, qui dépend du comportement de l'agent et non de l'usage, et que la première action sert justement à trancher. |
| S2 | Empiriste | partielle | 5 | Comportement par défaut correct. Mais la première action prévoit, dans la même séance, de passer le commit en ouverture automatique si son prompt demande une validation. |
| S4 | Mainteneur | contraire | 3 | « Ne pas ouvrir par défaut, sauf pour le commit », et la première action fixe `open: true` pour le commit : le comportement refusé est réintroduit tout de suite. |

Selon le correcteur, il y a deux écarts nets :

- entre les synthèses sans aucune ouverture (S3, S5) et celles dont l'exception dépend
  du déroulement propre à l'agent (S1, S2) ;
- entre S4, qui ouvre d'emblée le terminal du commit, et toutes les autres.

## Clé de mélange

```json
{
  "delegation": { "S1": "empiricist", "S2": "end-user", "S3": "economist", "S4": "maintainer", "S5": "reference" },
  "integration": { "S1": "empiricist", "S2": "reference", "S3": "economist", "S4": "end-user", "S5": "maintainer" },
  "auto-open": { "S1": "end-user", "S2": "empiricist", "S3": "economist", "S4": "maintainer", "S5": "reference" }
}
```
