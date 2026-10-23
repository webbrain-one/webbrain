# RAG hors ligne et corpus d'urgence

Le pipeline de génération augmentée par récupération (RAG) hors ligne de
DIV permet à l'extension de répondre à des questions en utilisant des
documents de référence stockés localement, sans aucune connexion réseau. Il
s'appuie sur les archives Wikipedia du mode Apocalypse et ajoute un nouveau
corpus de textes Emergency Box — une collection de documents de référence
publics couvrant des domaines médicaux, de survie, d'éducation et de
communication.

Le chat WebGPU autonome n'a aucun outil. Les passages récupérés sont d'abord
injectés dans le prompt ; le modèle de texte WebGPU sélectionné (Compass Tiny
v2.1 par défaut, ou un préréglage Ternary Bonsai 2) répond à partir de ces
preuves ou indique qu'il ne peut pas.

## Nouveautés

- **Corpus de textes Emergency Box.** Un ZIP vérifié d'environ 502 Mo contenant
  environ 570 documents en texte brut du domaine public (environ 304 Mo de
  texte source) distribué depuis le dépôt `webbrain-one/emergency-box-corpus`.
  Les documents sont des références dérivées de PDF dans plusieurs langues. Les
  PDF Emergency Box installés forment une étagère de lecture séparée et **ne
  sont pas** recherchés par ce chemin RAG.
- **Deux moteurs de récupération, pas un.** Wikipedia utilise l'index de
  **titres** Kiwix/ZIM installé (`title-only`). Emergency Box utilise un index
  SQLite **FTS5 BM25** préconstruit livré dans le ZIP du corpus. Wikipedia n'est
  pas FTS5. Le worker Xapian GPL est vendored et sert la recherche full-text
  lorsqu'une archive a un index.
- **Recherche vectorielle sémantique (Emergency Box uniquement).** Un modèle E5
  multilingue quantifié en int8 (`Xenova/multilingual-e5-small`, téléchargement
  d'environ 140 Mo) offre une recherche par similarité cosinus sur des
  embeddings de passages également précalculés et livrés dans le ZIP.
- **Reclassement E5.** Lorsque l'index vectoriel préconstruit n'est pas
  disponible pour une source, les candidats BM25 peuvent être reclassés sur
  l'appareil avec le même modèle E5. Un E5 absent ou en timeout retombe sur
  BM25 et est signalé comme `lexical-fallback` (affiché dans le chat comme
  « keyword fallback »).
- **Fusion réciproque des classements.** Les résultats lexicaux et sémantiques
  sont combinés par fusion réciproque, puis diversifiés pour limiter la
  redondance (max 8 passages, max 2 par document). Le chat WebGPU sur
  l'appareil plafonne aussi les preuves injectées à environ 1 800 jetons pour que
  le modèle local puisse terminer sa réponse.
- **Lecteurs de citations locaux.** Les citations Wikipedia ouvrent
  `wikipedia-reader.html`. Les citations de passages Emergency Box ouvrent
  `emergency-text.html` après revérification du document en texte brut. Lorsque
  le PDF Emergency Box correspondant est installé, la même citation pointe
  aussi vers `emergency-pdf.html`. Aucune citation ne navigue vers une page web
  en direct.
- **Tableau de bord de disponibilité RAG.** Une grille à 4 cellules, repliée
  sous la Boîte d'urgence dans le mode Apocalypse et aussi dans le panneau
  latéral, affiche indépendamment la recherche Wikipedia, la recherche de la
  bibliothèque d'urgence, le classement sémantique et la génération de
  réponses locales. L'installation du corpus et du modèle sémantique se fait
  là, pas sur l'étagère PDF.
- **Filtres par source et par langue.** Des cases à cocher limitent la
  récupération aux sources et langues installées. Les filtres persistent entre
  les sessions. Le chat autonome route aussi par requête : les questions
  encyclopédiques restent sur Wikipedia lorsque les deux sources sont
  sélectionnées ; les questions de santé personnelle et de premiers secours
  peuvent utiliser les deux.
- **Mises à jour transactionnelles du corpus.** Le corpus précédent reste
  actif jusqu'à ce que chaque somme de contrôle de document et l'index soient
  vérifiés. L'activation atomique signifie qu'une mise à jour échouée ne vous
  laisse jamais sans corpus fonctionnel.

## Comment une requête autonome est répondue

1. **Normaliser la requête.** Les préfixes de question sont retirés, puis les
   mots vides multilingues (listes [ranks.nl](https://www.ranks.nl/stopwords),
   empaquetées dans `offline-query-stopwords.js`) sont supprimés. Une requête
   réduite à des mots vides ne retombe pas sur la phrase brute.
2. **Choisir les sources pour ce tour.** Le routage n'est pas collant. Avec
   Wikipedia et Emergency Box sélectionnés, les questions encyclopédiques
   cherchent uniquement Wikipedia. Les questions de santé personnelle et de
   premiers secours cherchent les deux lorsqu'ils sont prêts. Un suivi par
   pronom tel que « fix it » après un article d'histoire ne réutilise pas le
   sujet précédent lorsque le nouveau message a ses propres termes distinctifs.
3. **Chercher.** Les résultats Wikipedia viennent de Xapian si l'archive a un
   index, sinon de l'index de titres ZIM. Les
   résultats Emergency Box utilisent toujours FTS5 lorsque le pack texte est
   `ready` ; les vecteurs E5 sont utilisés lorsque le modèle et l'index sont
   disponibles.
4. **Fusionner et budgéter.** Les résultats sont fusionnés, diversifiés et
   encapsulés comme preuves non fiables. La génération WebGPU est plafonnée
   (actuellement 2048 nouveaux jetons). LFM2.5 retire `<think>` de la réponse
   visible ; Bonsai 27B utilise un budget de raisonnement de 128 jetons pour
   que le raisonnement ne consomme pas tout le décodage. Si le modèle épuise
   ce budget dans son raisonnement, DIV réessaie avec un prompt de
   preuves plus court plutôt que d'inventer une réponse.
5. **Citer localement.** Chaque passage conservé reçoit un jeton stable
   (`[WB-E-…]` ou équivalent Wikipedia) et une URL de lecteur local. Les
   citations Emergency Box ajoutent un lien **Open PDF** seulement lorsque ce
   PDF du catalogue est installé.

## Sous le capot

### Architecture

```
agent.js (service worker)
  → offline-retrieval-offscreen.js (proxy MV3)
    → offscreen/offline-rag-host.js (document offscreen, possède le service de récupération)
      → offline-rag-index.js (client FTS5 + vecteur sur le thread principal)
        → offline-rag-worker.js (Web Worker dédié, possède SQLite Wasm + pool SAH OPFS)
```

La recherche Wikipedia ne passe pas par SQLite. Une archive indexée utilise le
worker Xapian vendored ; sinon l'index de titres ZIM du mode Apocalypse. Les
deux rejoignent le même pont de fusion et de citation.

Le document offscreen héberge également le worker de reclassement E5
(`offline-reranker-worker.js`). Le motif de proxy en couches existe parce que
les service workers Chrome MV3 ne peuvent pas détenir des handles d'accès
synchrone OPFS.

### Modules clés

| Module | Rôle |
| --- | --- |
| `offline-rag.js` | Primitives indépendantes du navigateur : découpage, tokenisation, jetons de citation, assemblage de preuves, fusion réciproque des classements, sélection de diversité |
| `offline-rag-index.js` | Définition du schéma FTS5, format binaire de l'index vectoriel (`WBVE5Q8`), constructeurs de requêtes, normalisation des résultats |
| `offline-rag-worker.js` | Web Worker dédié possédant le runtime SQLite Wasm et le pool SAH OPFS. Gère la construction d'index, la recherche FTS5, la similarité cosinus par force brute sur les vecteurs int8 |
| `offline-rag-prompt.js` | Pont de politique de prompt de confiance : assemble les preuves, construit les objets de référence de citation avec `readerUrl`, et attache une URL de lecteur PDF installé lorsqu'une correspondance existe |
| `offline-retrieval.js` | Orchestre la recherche par titre Wikipedia + lexicale d'urgence + vectorielle d'urgence + reclassement sémantique, puis la fusion et la diversification |
| `offline-reranker.js` | Client pour le worker de reclassement E5. Téléchargement/pause/arrêt du modèle, embedding de requête, reclassement des candidats |
| `offline-query-stopwords.js` | Listes de mots vides ranks.nl utilisées avant la recherche Wikipedia et Emergency |
| `emergency-corpus.js` | Cycle de vie transactionnel : téléchargements HTTP Range résumables, vérification SHA-256, extraction pilotée par manifeste, stockage OPFS, coordination Web Lock |
| `emergency-corpus-release.js` | Pointeur de version : URL épinglée, SHA-256, nombre d'octets, nombre de passages pour le corpus actuel |
| `zim-xapian.js` | Adaptateur de recherche full-text Wikipedia ZIM via le worker Xapian/libzim vendored |

### Disposition du stockage

- **OPFS** (Origin Private File System) :
  - `.webbrain-offline-rag-sahpool-v1/` — répertoire du pool SAH SQLite
  - `webbrain-offline-rag/emergency-box-text/downloads/` et `installs/` — fichiers du corpus d'urgence
- **IndexedDB** (`webbrain_offline_rag`) : état du cycle de vie du corpus, version active, manifeste, ID d'installation, chemin d'index, déclaration d'index vectoriel
- **IndexedDB** (`webbrain_emergency_box`) : enregistrements PDF/ressources installés utilisés pour les liens **Open PDF**
- **Cache hérité passage-vector** : plafonné à 256 Mo

### Schéma FTS5

FTS5 indexe **uniquement les passages Emergency Box**.

```sql
CREATE VIRTUAL TABLE passages USING fts5(
  passage_id UNINDEXED, document_id UNINDEXED, source_id UNINDEXED,
  title, language UNINDEXED, collection, source UNINDEXED, license UNINDEXED,
  locator, body, search_terms,
  passage_sha256 UNINDEXED, token_estimate UNINDEXED, ordinal UNINDEXED,
  reader_url UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
```

Poids de scoring BM25 : `body` 7, `search_terms` 1, `locator` 0,6,
`collection` 2, `title` 4.

### Format de l'index vectoriel

Format binaire personnalisé avec en-tête magique `WBVE5Q8` :
- En-tête de 4096 octets avec métadonnées JSON (ID du modèle, révision, type de données, nombre de passages, dimensions)
- Vecteurs de passages quantifiés int8 (384 dimensions chacun)
- Normes L2 Float32 pour la similarité cosinus
- Similarité cosinus par force brute dans le worker (251K passages est gérable)

### Découpage en passages

Les documents sont découpés en passages de 180 à 700 jetons (cible ~420) :
1. Découpage par retours à la ligne en paragraphes
2. Détection des titres (markdown `#`, motifs comme `Chapter`, sections numérotées, lignes EN MAJUSCULES)
3. Découpage des paragraphes trop grands par limites de phrases
4. Fusion des petits paragraphes adjacents jusqu'au nombre cible de jetons
5. Chaque passage obtient un `passageId` déterministe basé sur document + localisateur + hachage du contenu

### Modes de récupération

Ces modes s'appliquent au classement Emergency Box. Wikipedia utilise Xapian
quand l'archive a un index, sinon la recherche par titre.

| Mode | Description |
| --- | --- |
| `hybrid-full-vector` | Vecteurs E5 préconstruits utilisés directement (Emergency Box) |
| `semantic-reranked` | Reclassement E5 sur les candidats BM25 |
| `lexical-fallback` | BM25 uniquement (pas de modèle E5 disponible ou E5 en timeout) |

### Dégradation gracieuse

- Sans E5 : Emergency Box retombe sur la recherche lexicale BM25
- Sans Emergency Box : recherche uniquement dans les sources Wikipedia
- Sans les deux : signalisation de recherche hors ligne indisponible
- Recherche full-text Wikipedia Xapian : utilisée quand l'archive a un index ; sinon recherche par titre
- Récupération vide : le modèle local ne doit pas inventer de conseil médical

## Bibliothèques vendored

Toutes les bibliothèques vendored sont commitées en tant que fichiers vendored.
Aucun fetch runtime de code exécutable n'a lieu. Seuls les poids de modèle et
les données de corpus sont téléchargés par l'utilisateur.

| Bibliothèque | Version | Licence | Rôle |
| --- | --- | --- | --- |
| fflate | 0,8,3 | MIT | Décompression ZIP en streaming |
| SQLite Wasm | 3,53,0-build1 | Apache-2.0 | Recherche full-text FTS5 pour le corpus Emergency Box |
| Transformers.js | 4,2,0 | Apache-2.0 | Runtime d'inférence E5 |
| ONNX Runtime Web | 1,27,0 | MIT | Backend d'inférence WASM/GPU |
| Modèle E5 | multilingual-e5-small q8 | Apache-2.0 | Embeddings sémantiques (téléchargé séparément) |

## Licence

Le corpus Emergency Box, SQLite, fflate et Transformers.js sont tous sous
licences permissives et n'imposent pas eux-mêmes de copyleft. DIV 33.0.0
et les versions ultérieures sont néanmoins sous GPL-3.0-or-later, car
l'extension distribuée intègre le runtime Xapian/libzim sous GPL.

Le runtime Xapian/libzim pour la recherche full-text Wikipedia est vendored et
GPL. Voir [offline-rag-licensing.md](offline-rag-licensing.md) pour la décision,
le corresponding source, et la licence des artefacts de release.

## Pour aller plus loin

- [Mode Apocalypse](apocalypse-mode.md) — Gestion des archives Wikipedia
- [Téléchargements distants et sources de données](remote-downloads.md) — Origines, ordre d'exécution et vérification
- [Licence RAG hors ligne](offline-rag-licensing.md) — Registre de décision GPL
- [Checklist de sortie](offline-rag-release-checklist.md) — Portes de
  vérification et mesures
