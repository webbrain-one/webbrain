# Scénarios de test DIV

Une douzaine de tâches de bout en bout pour évaluer l'agent navigateur DIV sur un éventail de difficultés et de couverture de motifs d'interface. Chaque scénario liste le site, l'invite à coller dans le panneau latéral et le critère de réussite observable.

## Scénarios

### 1. Résumé Wikipedia — Facile
- **Site :** en.wikipedia.org
- **Tâche :** "Va sur Wikipedia, trouve l'article sur Alan Turing et dis-moi sa date de décès."
- **Attendu :** L'agent navigue, lit l'infobox, répond "7 juin 1954". Un `get_accessibility_tree` → `done`.

### 2. Histoire principale Hacker News — Facile
- **Site :** news.ycombinator.com
- **Tâche :** "Quelle est l'histoire n°1 sur Hacker News en ce moment, et combien de points a-t-elle ?"
- **Attendu :** Retourne le titre + le nombre de points de la première ligne. Aucun clic nécessaire.

### 3. Vérification de prix Amazon — Facile
- **Site :** amazon.com
- **Tâche :** "Cherche 'Hub USB-C' sur Amazon et dis-moi le prix du premier résultat sponsorisé."
- **Attendu :** Un texte saisi dans la barre de recherche, un Entrée, lire la première carte. Teste la détection de la barre de recherche et l'analyse SERP.

### 4. Création d'issue GitHub — Moyen
- **Site :** github.com (votre propre dépôt de test)
- **Tâche :** "Ouvre une nouvelle issue intitulée 'Test depuis DIV' avec le corps 'ignorez ceci' sur github.com/&lt;vous&gt;/&lt;dépôt&gt;."
- **Attendu :** L'agent navigue vers `/issues/new`, remplit le titre + le corps, clique sur Soumettre. Teste l'éditeur de corps contenteditable et le bouton "Submit new issue" en double.

### 5. Rédaction de brouillon Gmail — Moyen
- **Site :** mail.google.com
- **Tâche :** "Rédige un brouillon à test@example.com avec le sujet 'bonjour' et le corps 'ceci est un test'. N'envoie pas."
- **Attendu :** Clique sur Composer, remplit trois champs (avec autocomplétion sur À), ferme pour sauvegarder comme brouillon. Teste les portails React et les combobox d'autocomplétion.

### 6. Événement Google Calendar — Moyen
- **Site :** calendar.google.com
- **Tâche :** "Crée un événement de calendrier intitulé 'Déjeuner' demain à 12h30 pour 30 minutes."
- **Attendu :** Ouvre la boîte de dialogue de création, tape le titre, ajuste les sélecteurs de date/heure, sauvegarde. Teste les sélecteurs de date/heure.

### 7. Produit Stripe avec abonnement récurrent en CNY — Difficile
- **Site :** dashboard.stripe.com
- **Tâche :** "Crée un produit appelé 'MonProduit' au prix de 500 CNY, récurrent tous les 2 mois."
- **Attendu :** Une ligne dans le catalogue de produits avec nom=MonProduit, devise=CNY, intervalle=2 mois. Teste la combobox virtualisée + le dévoilement d'intervalle personnalisé.

### 8. Demande de connexion LinkedIn — Moyen
- **Site :** linkedin.com
- **Tâche :** "Va sur linkedin.com/in/&lt;profil&gt;, clique sur Connecter, ajoute une note 'Rencontré au Demo Day' et envoie."
- **Attendu :** Gère le menu de débordement "Plus" sur les profils où Connecter est caché. Teste la découverte de menu.

### 9. Filtre de recherche Airbnb — Difficile
- **Site :** airbnb.com
- **Tâche :** "Trouve des annonces à Istanbul du 10 au 15 juin, 2 voyageurs, max 150 $/nuit, avec une piscine."
- **Attendu :** Remplit l'autocomplétion de destination, le sélecteur de dates, le sélecteur de voyageurs, le curseur de prix, la case à cocher d'équipements. Teste les saisies à plages et le tiroir de filtres en plusieurs étapes.

### 10. Recherche Google Flights — Difficile
- **Site :** google.com/travel/flights
- **Tâche :** "Cherche des vols aller simple SFO → IST, départ le 20 mai 2026, économique, 1 adulte. Retourne l'option la moins chère et sa compagnie aérienne."
- **Attendu :** Autocomplétion d'aéroports (deux combobox), sélecteur de date, sélecteur de cabine, lit la première carte de résultat. Teste les transitions de route SPA.

### 11. Abonnement à un subreddit Reddit — Moyen
- **Site :** reddit.com
- **Tâche :** "Abonne-moi à r/chess et dis-moi combien de membres cela compte."
- **Attendu :** Clique sur Rejoindre, lit le nombre de membres dans la barre latérale. Nécessite un compte connecté ; teste la détection de changement d'état (Rejoindre → Membre).

### 12. Synthèse de recherche multi-onglets — Difficile
- **Site :** arxiv.org + scholar.google.com
- **Tâche :** "Ouvre arxiv.org/abs/1706.03762, puis cherche son nombre de citations sur Google Scholar et dis-moi le titre de l'article et son nombre de citations."
- **Attendu :** Utilise `tabs_create` / `switch_browser` sur deux onglets et retourne les deux données. Teste la gestion d'état entre onglets.

## Score

- **Réussite :** réponse correcte ou état de page final correct.
- **Partiel :** bonnes données mais mauvais champ, ou formulaire soumis avec un champ erroné.
- **Échec :** boucle infinie, mauvaise entité modifiée, ou achèvement halluciné.

## Options d'automatisation

Classées de la plus simple à la plus ambitieuse.

### 1. Traçage déjà existant (base de référence la moins coûteuse)
Le traçage est déjà intégré. Activez-le dans Paramètres → "Enregistrer les traces", exécutez chaque scénario manuellement une fois par modèle que vous souhaitez comparer, puis ouvrez la page Traces et comparez côte à côte. C'est ce que nous avons fait dans cette session. Peu coûteux à démarrer, mais la notation est manuelle.

### 2. Exécuteur de scénarios depuis le panneau latéral
Ajoutez un `tests.json` contenant des lignes `{ url, prompt, check }`. Construisez un petit onglet Exécuteur de tests (miroir de Traces) qui parcourt les entrées : pour chacune, ouvrez l'URL, insérez l'invite dans le champ de saisie du panneau latéral, attendez que l'agent termine, puis évaluez `check`. Trois variantes utiles de `check` :

- **Correspondance d'URL** — `window.location.href` final correspond à une regex. Capture "un brouillon a-t-il vraiment été créé ?" pour les pages qui redirigent lors de la sauvegarde.
- **Assertion DOM** — exécutez un petit snippet JS dans la page (`document.querySelector('[data-testid=product-row-name]')?.textContent === 'namaz'`). Capture les scénarios 4, 7, 11.
- **LLM comme juge** — fournissez le résumé `done` final + une capture d'écran à un modèle plus fort (Claude Sonnet) avec l'invite + la grille d'évaluation et obtenez réussite/partiel/échec. Capture les scénarios 1, 2, 3, 10, 12 où la réponse est une chaîne de caractères.

Vous avez déjà tout ce dont vous avez besoin : la boucle d'agent, le bus de messages, les captures d'écran, les traces. C'est environ 1 jour de travail.

### 3. Exécution sans tête via Puppeteer / Playwright
Lancez Chromium avec l'extension préinstallée (`--load-extension=chemin/vers/webbrain`), pilotez le panneau latéral via son DOM et exécutez la suite de manière non interactive — pendant la nuit, en CI, sur N fournisseurs. Vous pouvez paralléliser sur plusieurs profils Chrome pour le débit. Inconvénients : les scénarios nécessitant une connexion (Gmail, Reddit, LinkedIn) ont besoin de cookies préenregistrés par profil, et le tableau de bord Stripe est difficile avec les nouveaux navigateurs (captcha).

Le point idéal est un hybride : sans tête pour les sites anonymes (Wikipedia, HN, Amazon, arxiv), exécuteur depuis le panneau latéral pour les sites nécessitant une connexion.

### 4. Génération de scénarios à partir de navigation réelle
Enregistrez un humain effectuant la tâche une fois avec les outils de développement activés, sauvegardez les identifiants des éléments cliqués + l'état DOM final, et construisez automatiquement le `check`. Transforme chaque flux démontré manuellement en test de régression. Coût initial plus élevé ; rentabilisé une fois que vous avez 50+ scénarios.

### 5. Classement modèle contre modèle
Une fois (2) et (3) en place, balayez tous les fournisseurs configurés (llama.cpp 4B/12B/31B, Anthropic, OpenAI, OpenRouter) en exécutant la même suite chaque nuit. Persistez les scores dans IndexedDB, affichez un onglet de classement. C'est là que le traçage porte ses fruits — vous pouvez cliquer sur "pourquoi Gemma-4-31B a échoué sur Stripe ?" et obtenir la séquence d'étapes exacte sans réexécuter.

### Recommandation
Construisez d'abord l'option 2. L'infrastructure de traçage signifie que vous êtes déjà à environ 60 % du chemin — ce qui manque est la boucle scriptée et un petit juge réussite/échec. Cela vous donnera des chiffres reproductibles pour justifier des changements comme la `v3.6.8`. Ajoutez l'option 3 une fois que la suite dépasse environ 20 scénarios et que le coût par exécution compte.
