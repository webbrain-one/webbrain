# Commandes slash

DIV accepte les commandes slash en tant que premier élément d'une ligne dans
le champ de saisie. Tapez `/help` dans le panneau pour afficher les syntaxes
complètes et la description des options. Saisir une commande canonique suivie
d'une espace ouvre l'autocomplétion de ses options disponibles.

## Référence

| Commande | Ce qu'elle fait |
|---------|--------------|
| `/help` | Affiche la liste des commandes disponibles |
| `/ask` | Passer en mode Ask avant d'envoyer |
| `/act` | Passer en mode Act avant d'envoyer |
| `/dev` | Passer en mode Dev avant d'envoyer |
| `/plan` | Passer en mode Ask avec une intention de planification |
| `/schedule [invite]` | Créer une tâche planifiée, en préremplissant éventuellement son invite |
| `/schedule --list` | Afficher les tâches planifiées |
| `/watch [--keep] [--secs <30-120>] [--long \| --short] <condition et action> [/beep]` | Interroger la page courante pour une condition ; s'arrête après la première correspondance sauf si `--keep` est défini, et peut jouer une alerte en arrière-plan |
| `/progress` | Afficher le journal de progression actuel |
| `/btw [invite]` | Ouvrir une conversation latérale rapide |
| `/scratchpad` | Afficher le bloc-notes actuel |
| `/scratchpad --append <texte>` | Ajouter du texte au bloc-notes actuel |
| `/scratchpad --clear` | Effacer le bloc-notes actuel |
| `/memory` | Afficher la mémoire utilisateur enregistrée |
| `/memory --add <texte>` | Enregistrer une préférence utilisateur |
| `/memory --forget <id>` | Oublier une entrée de mémoire par identifiant |
| `/workflow` | Ouvrir le gestionnaire des workflows avec les actions Exécuter, Renommer, Exporter et Supprimer avec confirmation |
| `/workflow --save <nom>` | Compiler la dernière exécution tracée réussie en un workflow réutilisable et sans valeurs |
| `/workflow --run <id>` | Exécuter un workflow enregistré en mode Act, en collectant localement les paramètres d'exécution |
| `/workflow --delete <id>` | Supprimer un workflow enregistré |
| `/workflow --export <id>` | Télécharger un fichier JSON portable `webbrain-workflow/1` assaini |
| `/workflow --import --file` | Importer un fichier de workflow portable comme nouveau workflow local |
| `/teach` | Afficher l’état du mode d’apprentissage et le nombre d’actions capturées dans l’onglet actuel |
| `/teach --start <nom>` | Commencer à apprendre un workflow à partir de vos clics et modifications de champs |
| `/teach --end` | Arrêter l’apprentissage et compiler les actions en workflow enregistré sans valeurs saisies |
| `/allow-api` | **Dérogation de mutation API par conversation.** Voir [plus bas](#allow-api). |
| `/foreground [invite]` | Exécuter une tâche locale au premier plan pour assurer la compatibilité visuelle |
| `/dangerously-skip-permissions` | **Contournement global des demandes d'autorisation.** Désactive `Ask before consequential actions` sans ouvrir les Paramètres. DIV agira sans demandes par site jusqu'à ce que vous réactiviez le réglage. |
| `/compact` | Force le compactage du contexte pour la conversation actuelle |
| `/verbose` | Bascule l'affichage verbeux/compact des outils |
| `/reset` | Efface la conversation et tous les indicateurs par conversation |
| `/screenshot [--full-page]` | Capture l'onglet visible, ou la page entière défilable avec `--full-page` (Chrome uniquement) |
| `/record [--full-screen] [--hide-recording-indicator] [--transcribe]` | Enregistre l'onglet actuel, ou un écran/une fenêtre avec `--full-screen` (Chrome uniquement) ; `--hide-recording-indicator` masque la bannière et `--transcribe` enregistre une transcription |
| `/export [--traces \| --config]` | Télécharge la conversation en Markdown horodatée par version, la chaîne d'outils avec `--traces`, ou un instantané des Paramètres avec `--config` |
| `/import <json>` | Importer un instantané de Paramètres collé en ligne |
| `/import --file` | Choisir et importer un fichier JSON d'instantané de Paramètres |
| `/profile` | Bascule le remplissage automatique du profil sans ouvrir les Paramètres |
| `/vision` | Bascule le mode vision (compréhension de captures d'écran) sur le fournisseur actif |

## `/watch`

`/watch` effectue sa première vérification immédiatement, puis interroge toutes
les 60 secondes par défaut. `--secs` accepte 30 à 120 secondes.

Les conditions relatives comme « quand un nouveau commit apparaît » établissent
une référence lors de la première vérification ; les conditions absolues comme
« quand la CI est verte » peuvent correspondre immédiatement.

Un `/beep` en fin de ligne active l'outil d'alerte réservé aux watches ;
`--short` et `--long` sélectionnent sa tonalité. Les alertes ne se déclenchent
qu'après une action vérifiée réussie, et `--keep` supprime les alertes répétées
pour la même clé d'événement stable. Si un modèle vérifie l'action mais omet
l'outil d'alerte optionnel, le watch enregistre l'avertissement et se termine ou
continue sans son.

Les interrogations s'exécutent dans des onglets inactifs dédiés, de sorte que
quitter la page initiale ne la ramène pas vers l'URL surveillée, et l'onglet
auxiliaire est fermé à la fin du watch. Les échecs d'interrogation transitoires
sont tolérés ; trois échecs consécutifs arrêtent le watch.

## `/foreground`

Les exécutions locales ordinaires restent liées à leur onglet d'origine et
fonctionnent sans activer cet onglet ni donner le focus à sa fenêtre. Chrome
effectue les captures via CDP avec une émulation du focus limitée à l'exécution ;
Firefox capture directement l'onglet cible avec `tabs.captureTab`. Si Chrome
renvoie plusieurs fois une image vide en arrière-plan, DIV l'écarte et
continue à partir du DOM et des données d'accessibilité.

Utilisez `/foreground <invite>` comme solution de compatibilité pour une seule
exécution lorsqu'un site ne restitue pas correctement son état visuel en
arrière-plan. Cette commande rétablit l'activation de l'onglet et le focus de la
fenêtre pour cette exécution uniquement. Elle n'est pas persistante, et les
exécutions Cloud gérées conservent leur comportement actuel au premier plan car
leur navigateur est dédié à la tâche.

## `/allow-api`

`/allow-api` lève la restriction UI-d'abord pour la conversation en cours, afin
que l'agent puisse utiliser POST/PUT/PATCH/DELETE via `fetch_url` ou
`research_url` lorsque l'UI échoue. Un badge apparaît pendant l'activation, et
il s'efface au `/reset`.

Pour conserver la même politique entre les conversations et les redémarrages
du navigateur, activez **Toujours autoriser les mutations API** sous
**Paramètres → Général → Avancé**. Ce réglage est désactivé par défaut et reste
actif jusqu'à sa désactivation. `/reset` efface toujours la dérogation
`/allow-api` de la conversation, mais ne modifie pas ce réglage persistant.

La règle UI-d'abord par défaut existe parce que les actions API sont invisibles
(vous ne voyez pas ce qui est envoyé), nécessitent souvent des jetons
d'authentification distincts que vous n'avez peut-être pas configurés, et peuvent
avoir un rayon d'impact bien plus grand qu'un mauvais clic visible. N'utilisez
`/allow-api` que lorsque vous avez décidé d'accepter ce compromis pour une tâche
spécifique. Voir [modèle de sécurité](security-model.md#indicateur-allow-api).

## Suffixes de capture d'exécution

Ceux-ci sont intentionnellement absents de `/help` et de l'autocomplétion.

Ajoutez `/record [--save-as <fichier>]` à la fin d'une invite normale pour
démarrer l'enregistrement de l'onglet courant juste avant l'exécution, puis
l'arrêter et enregistrer le WebM quand cette exécution se termine (Chrome
uniquement).

Ajoutez `/screenshot [--save-as <fichier>]` pour enregistrer des captures de la
zone visible juste avant et après l'exécution (Chrome et Firefox). Par exemple,
`Teste le paiement /screenshot --save-as checkout.png` enregistre
`checkout-before.png` et `checkout-after.png` ; sans `--save-as`, DIV
utilise des noms horodatés.

Pour ce suffixe de diagnostic, Chrome peut réactiver l'onglet d'origine avant
d'enregistrer la capture « après ». Firefox capture directement cet onglet sans
l'activer. Si l'enregistrement ou la capture initiale ne peut pas être démarré
et sauvegardé, l'exécution n'est pas envoyée. Les `/record` et `/screenshot`
autonomes conservent leur comportement existant.

## Exports, instantanés et workflows

Les schémas complets et les propriétés de confidentialité de chaque export sont
décrits dans [export and workflow formats](../export-and-workflow-formats.md)
(en anglais). En bref :

- **Les instantanés de Paramètres** utilisent `webbrain-config/1` et incluent
  toutes les valeurs portables des Paramètres, y compris les clés d'API
  fournisseur, vision, transcription et CapSolver, les données de profil, la
  mémoire utilisateur, les compétences personnalisées et les choix de
  permissions. **Le JSON est en clair et doit être conservé de façon
  sécurisée.** Les sessions/IDs d'appareil Cloud Sync liés à l'appareil, les
  conversations, les traces, les tâches planifiées, les compteurs d'usage et les
  dépenses cumulées ne sont pas exportés.
- **Les workflows enregistrés** utilisent un schéma distinct
  `webbrain-workflow/1` ; ce ne sont pas des rejeux bruts de traces. Les valeurs
  `ref_id` historiques, les sélecteurs CSS d'action, les coordonnées, les chaînes
  de requête, les fragments et les valeurs de champ saisies sont exclus. Les
  valeurs saisies deviennent des paramètres d'exécution, et chaque action est
  liée à l'origine et à la famille d'URL enregistrées. À l'exécution, DIV
  résout une cible fraîche dans l'arbre d'accessibilité et passe par les
  contrôles habituels de permission Act, de confirmation de soumission et de
  vérification. Les cibles ambiguës échouent de façon sûre. Si une action a
  peut-être déjà eu lieu mais que son résultat est inconnu, le rejeu s'arrête au
  lieu de la retenter. Les valeurs des paramètres d'exécution ne sont pas
  enregistrées dans le workflow, la conversation, la mémoire utilisateur, la
  trace de rejeu ni l'invite de repli de l'Agent ; elles sont tout de même
  transmises à la page cible par l'action navigateur demandée. La trace source
  opt-in d'origine reste séparée et peut contenir des arguments d'outil bruts
  jusqu'à ce que l'utilisateur supprime cette trace.
- Si le rejeu démarre hors de l'origine ou de la famille d'URL enregistrées, le
  rejeu déterministe passe la main à l'Agent avec la portée de départ assainie,
  afin que les règles normales de navigation, de permission et de vérification
  puissent récupérer le workflow au lieu de l'interrompre immédiatement.
- **Les fichiers de workflow portables** contiennent la définition
  `webbrain-workflow/1` brute assainie et sont limités à 1 Mio. L'export
  renormalise la définition avant le téléchargement. L'import la renormalise à
  nouveau, attribue un nouvel ID local et de nouveaux horodatages, et n'écrase
  jamais un workflow existant : le même fichier peut donc circuler en toute
  sécurité entre Chrome, Firefox et DIV Cloud.
