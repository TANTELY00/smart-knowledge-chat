# Guide — Test RAG CashOffice (agent RAG Gemma + Supabase)

Inspiré de https://docs.langchain.com/oss/python/deepagents/rag : un **agent** dispose d'un outil
`retrieve_context` qu'il appelle (une ou plusieurs fois, en reformulant) avant de répondre avec des sources.

## 1. Préparer Supabase (une seule fois)
1. Ouvrez https://supabase.com/dashboard/project/czdmzinjcthltkmpikeb → **SQL Editor**.
2. Collez le contenu de `supabase/setup.sql` et cliquez **Run**.
   Cela crée : la table `rag_documents` avec index plein texte,
   et 3 fonctions : `insert_document`, `match_documents`, `list_sources`.

## 2. Indexer des documents (pipeline d'ingestion)
Dans l'app, colonne de gauche : choisissez un fichier texte (.pdf, .txt, .md, .csv…) ou collez du texte, puis **Indexer**.
- PDF : extraction du texte normal, puis OCR en français et anglais de chaque image intégrée. Les PDF entièrement scannés sont acceptés.
- Le texte OCR est ajouté au contenu avec son numéro de page et d’image, puis découpé comme le reste du document. Il est donc indexé et retrouvé par la recherche plein texte.
- L’OCR est exécuté localement dans le navigateur ; le moteur et les langues sont servis par l’application. La progression et le nombre de caractères reconnus sont affichés.
- Découpage : fragments de ~1000 caractères, chevauchement 200 (comme `RecursiveCharacterTextSplitter`).
- Recherche : plein texte PostgreSQL dans Supabase (aucune IA Lovable). Réponses : modèle Gemma `gemma4:e4b` sur http://159.195.68.117:11434.
- Stockage : chaque fragment + vecteur + métadonnées (`source`, `chunk`) dans `rag_documents`.

Les documents indexés avant l’ajout de l’OCR doivent être réindexés pour rendre le texte de leurs images recherchable.

## 3. Poser des questions (agent)
Tapez une question à droite. L'agent :
1. décide de chercher → appelle `retrieve_context(query)` ;
2. `match_rag_documents` renvoie les 4 passages les plus pertinents (recherche plein texte) ;
3. il peut relancer une recherche (max 5 étapes) puis répond en citant `[source]`.
Sous chaque réponse : les requêtes de recherche utilisées (🔎) et les sources avec leur score.

### Choix du modèle
Les réponses sont générées par **Ollama · gemma4:e4b** (serveur http://159.195.68.117:11434).
La recherche ne dépend d’aucun service d’IA ; seules les réponses utilisent Gemma.

### Réponses au format scénario JSON

Pour une demande de scénario ou de cas de test, l’agent renvoie un objet JSON avec `id`, `titre`,
`prerequis` et `etapes`. Les réponses sont validées côté serveur : les actions, cibles, valeurs et
conditions requises sont vérifiées, les variables `${NOM}` deviennent `{{NOM}}`, puis l’étape
`launch` avec `CashOffice.exe` est ajoutée automatiquement. Les demandes hors périmètre restent
au format JSON avec `statut` et `message`. Les réponses aux autres questions gardent leur format habituel.

## 4. Architecture
| Élément | Fichier |
|---|---|
| Schéma SQL | `supabase/setup.sql` |
| Ingestion, recherche, boucle agent | `src/lib/rag.functions.ts` |
| Interface | `src/routes/index.tsx` |

## 5. Sécurité — à savoir
- La clé *publishable* n'accède pas directement à la table (RLS activé) ; elle passe par les fonctions SQL.
- Mais n'importe qui possédant l'URL de l'app peut indexer et interroger. Pour un usage privé, ajoutez une
  authentification et restreignez `insert_document` aux utilisateurs connectés.

## 6. Dépannage
- « Base Supabase non configurée » (ou erreur PGRST202) → le script SQL n'a pas été exécuté entièrement. Collez TOUT le fichier dans SQL Editor, cliquez Run, vérifiez « Success. No rows returned ».
- `Crédits IA épuisés` → (non applicable : Gemma tourne sur votre serveur).
- Pour vider la base : `truncate rag_documents;` dans le SQL Editor.

## 7. Corriger les réponses (table `chat`)
1. Exécutez une fois `supabase/chat.sql` dans Supabase > SQL Editor.
2. À côté de chaque réponse de l'IA, cliquez **✎ Modifier**, corrigez le texte puis **Enregistrer** : la question et la bonne réponse sont stockées dans `chat` (`questions`, `bonne_reponse`).
3. À chaque nouvelle question, l'agent consulte d'abord `chat` puis les documents (RAG) ; une réponse validée est prioritaire et apparaît comme source « Réponse validée ».
