import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  formatScenarioAnswer,
  isInvalidScenarioAnswer,
  isProcedureAnswer,
  isScenarioRequest,
} from "@/lib/scenario";
import {
  combineCashOfficeQuery,
  contextualizeCashOfficeQuery,
  isCashOfficeBoilerplate,
  isCashOfficeFollowUp,
  normalizeCashOfficeSearchTerms,
} from "@/lib/rag-context";

const SUPABASE_URL = "https://czdmzinjcthltkmpikeb.supabase.co";
const SUPABASE_KEY = "sb_publishable_2mMcgSPrJlYJTr-YOFGbqg_jTz12zok";

// IA 100 % hors Lovable : modèle Gemma sur votre propre serveur Ollama.
// La recherche utilise le plein texte PostgreSQL de Supabase (ce serveur Ollama ne fournit pas d'embeddings).
const OLLAMA_URL = process.env["OLLAMA_URL"] || "http://159.195.68.117:11434";
const OLLAMA_MODEL = process.env["OLLAMA_MODEL"] || "gemma4:e4b";

async function rpc<T>(fn: string, body: unknown): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    if (t.includes("PGRST202"))
      throw new Error("Base Supabase non configurée : exécutez le script supabase/setup.sql dans Supabase > SQL Editor (voir le guide), puis réessayez.");
    throw new Error(`Supabase ${fn}: ${res.status} ${t}`);
  }
  return res.json();
}

// Découpage récursif simple (équivalent RecursiveCharacterTextSplitter, 1000 / overlap 200)
export function chunkText(text: string, size = 1000, overlap = 200): string[] {
  const clean = text.replace(/\r/g, "").trim();
  const chunks: string[] = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + size, clean.length);
    if (end < clean.length) {
      const slice = clean.slice(i, end);
      const cut = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "));
      if (cut > size * 0.5) end = i + cut + 1;
    }
    const c = clean.slice(i, end).trim();
    if (c) chunks.push(c);
    if (end >= clean.length) break;
    i = Math.max(end - overlap, i + 1);
  }
  return chunks;
}

export const ingestDocument = createServerFn({ method: "POST" })
  .inputValidator(z.object({ source: z.string().min(1).max(200), text: z.string().min(1).max(2_000_000) }))
  .handler(async ({ data }) => {
    const chunks = chunkText(data.text);
    for (let b = 0; b < chunks.length; b += 32) {
      const batch = chunks.slice(b, b + 32);
      await Promise.all(
        batch.map((content, j) =>
          rpc("insert_document", { p_content: content, p_metadata: { source: data.source, chunk: b + j } }),
        ),
      );
    }
    return { chunks: chunks.length };
  });

export const listSources = createServerFn({ method: "GET" }).handler(async () =>
  rpc<{ source: string; chunks: number }[]>("list_sources", {}),
);

type Match = { content: string; metadata: { source?: string }; similarity: number };

async function retrieve(query: string, k = 4) {
  return rpc<Match[]>("match_rag_documents", {
    query_text: contextualizeCashOfficeQuery(query),
    match_count: k,
  });
}

type ChatMatch = { questions: string; bonne_reponse: string; similarity: number };

async function retrieveChat(query: string, k = 3): Promise<ChatMatch[]> {
  try {
    return await rpc<ChatMatch[]>("match_chat", {
      query_text: contextualizeCashOfficeQuery(query),
      match_count: k,
    });
  } catch (e: any) {
    // Table chat pas encore créée : on continue avec les documents seuls.
    if (String(e?.message ?? "").includes("non configurée")) return [];
    throw e;
  }
}

function formatChat(matches: ChatMatch[]) {
  return matches
    .map((m) => `[Réponse validée] (score ${m.similarity.toFixed(2)})\nQuestion : ${m.questions}\nBonne réponse : ${m.bonne_reponse}`)
    .join("\n\n---\n\n");
}

function noCashOfficeInformation(question: string): string {
  const isFrench =
    /[àâçéèêëîïôûùüÿœæ]/i.test(question) ||
    /\b(le|la|les|un|une|dans|comment|pour|est|des)\b/i.test(question);
  return isFrench
    ? "Je n'ai pas trouvé dans la documentation indexée d'information suffisante pour répondre à cette question sur CashOffice."
    : "I couldn't find enough information in the indexed documentation to answer this CashOffice question.";
}

export const saveCorrection = createServerFn({ method: "POST" })
  .inputValidator(z.object({ question: z.string().trim().min(1).max(4000), bonne_reponse: z.string().trim().min(1).max(8000) }))
  .handler(async ({ data }) => {
    try {
      const id = await rpc<string>("insert_chat", { p_question: data.question, p_reponse: data.bonne_reponse });
      return { id };
    } catch (e: any) {
      if (String(e?.message ?? "").includes("non configurée"))
        throw new Error("Table chat absente : exécutez le script supabase/chat.sql dans Supabase > SQL Editor, puis réessayez.");
      throw e;
    }
  });

const SYSTEM = `Tu es l'assistant de recherche CashOffice. Toutes les questions posées dans cette application concernent CashOffice par défaut, même si l'utilisateur ne répète pas le nom du logiciel. Interprète donc les questions générales (par exemple « comment configurer les tailles et couleurs d'un article ? ») comme portant sur la configuration correspondante dans CashOffice. Réponds uniquement à la question la plus récente de l'utilisateur ; n'essaie pas de répondre aux anciennes questions qui apparaissent dans l'historique. Ne demande jamais à l'utilisateur de préciser « dans CashOffice » et ne réponds jamais par une formule générique lui demandant de poser sa question : réponds à la question déjà écrite.

Avant ta réponse finale, appelle retrieve_context au moins une fois avec le sujet précis de la question, même si elle ne contient pas « CashOffice ». Tu peux faire jusqu'à trois recherches au total : conserve les mots-clés du sujet initial et essaie des synonymes proches si nécessaire. Ne recherche pas à nouveau après chaque résultat : dès que les passages sont suffisants, arrête les appels d'outil et rédige directement la réponse. Chaque nouvelle recherche doit rester sur le même sujet ; ne pars pas vers une fonction différente (par exemple « retour article » si la question porte sur les tailles et couleurs). Réponds uniquement à partir du contexte récupéré, dans la langue de l'utilisateur. N'invente aucune information ni référence; cite les sources avec leur nom exact entre crochets [source], près de l'information concernée. Si les recherches ne trouvent pas l'information, indique clairement ce qui manque au contexte au lieu d'improviser ou de demander de reformuler la question.

Fais des réponses claires, concises et directement exploitables. Commence par répondre directement à la question. Pour une procédure, utilise un titre, des étapes numérotées avec des intitulés courts et des sous-puces seulement pour les détails utiles. Pour une explication, préfère des paragraphes courts et des puces si elles améliorent la lecture. Mets en gras les éléments importants sans en abuser.

Utilise du Markdown standard (titres avec #, listes avec 1. ou -, gras avec **). N'utilise jamais de syntaxe LaTeX ou de délimiteurs mathématiques; pour un chemin de menus, écris par exemple « Vente > Fidélisation client > Remboursement » ou « Vente, puis Fidélisation client ». Évite de répéter la même citation à chaque phrase d'une étape.

Base de connaissance validée : certains passages sont marqués [Réponse validée]. Ce sont des réponses corrigées par un humain. Si une réponse validée correspond à la question, ses informations sont PRIORITAIRES sur les documents et doivent être utilisées sans les contredire ; cite-la comme [Réponse validée]. En cas de contradiction avec un document, suis la réponse validée. Tu peux restructurer une procédure validée au format demandé sans en changer les informations.`;

const SCENARIO_INSTRUCTIONS = `
Pour une demande de scénario de test, de cas de test ou de test automatisé, réponds uniquement avec un seul objet JSON valide à la racine, jamais un tableau, sans Markdown ni texte avant/après. Le format est :
{"titre":"...","prerequis":[],"etapes":[{"action":"...","cible":"...","valeur":"...","condition":"..."}]}
Applique également ce format quand la réponse est une procédure d'utilisation de CashOffice avec des actions à effectuer dans l'interface, même si la question ne mentionne pas un scénario ou un test. Mappe les verbes toucher, cliquer et sélectionner aux actions correspondantes ; pour attendre l'affichage d'un écran ou d'un contrôle, utilise wait avec la condition visible. La cible doit être l'identifiant UIA connu ou, s'il n'est pas fourni, le libellé visible exact. N'invente pas d'identifiants techniques.
Les propriétés inutilisées d'une étape doivent être omises. Actions autorisées : launch, attach, click, set, select, key, wait, assert, screenshot, export_uia_tree, close. Conditions autorisées : existe, n_existe_pas, visible, active, texte_egale, contient, commence_par, expression_reguliere, valeur_numeric_egale, coche, decoche, ligne_selectionnee, message_erreur_visible. wait et assert nécessitent une condition ; set, select et key nécessitent une valeur. N'utilise select que pour choisir une option précise et renseigne alors valeur ; pour sélectionner une fiche ou un élément visible, utilise click si aucune valeur à sélectionner n'est indiquée. N'ajoute pas de condition à click ou key. Ne transforme pas une description comme « effectuer la consultation » en faux nom de bouton ; omets-la si les actions précédentes couvrent déjà la tâche. Pour fermer, choisis une seule option explicitement mentionnée (bouton connu ou touche). N'invente pas de cibles ni d'informations absentes des documents ou de la demande. N'inclus pas launch ni attach : l'application CashOffice.exe sera ajoutée automatiquement. Pour une demande hors périmètre, réponds uniquement {"statut":"hors_perimetre","message":"..."}.
Pour les autres questions, conserve le format de réponse habituel.`;

async function recoverCashOfficeAnswer(question: string, context: string): Promise<string> {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [
        {
          role: "system",
          content: `Tu es l'assistant documentaire CashOffice. La question de l'utilisateur est déjà fournie : réponds directement, sans demander de la poser ou de préciser CashOffice. Utilise uniquement les passages de contexte ci-dessous et réponds dans la langue de la question. Si le contexte ne contient pas la réponse, dis précisément que l'information n'a pas été trouvée dans la documentation CashOffice. N'écris jamais de message d'accueil ou de réponse générique.`,
        },
        {
          role: "user",
          content: `Question :\n${question}\n\nPassages récupérés :\n${context || "Aucun passage pertinent récupéré."}`,
        },
      ],
      stream: false,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Erreur de récupération de réponse CashOffice par Gemma ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }
  const result = (await response.json()) as { message?: { content?: string } };
  return result.message?.content ?? "";
}

async function convertScenarioAnswer(
  source: string,
  previousAttempt: string,
  errors: string[],
): Promise<string> {
  const correction = errors.length
    ? `\n\nErreurs à corriger :\n${errors.map((error) => `- ${error}`).join("\n")}\n\nProposition invalide :\n${previousAttempt}`
    : "";
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [
        {
          role: "system",
          content: `${SCENARIO_INSTRUCTIONS}\n\nTransforme le texte source en scénario JSON sans inventer d'informations. Préserve les actions explicites et corrige toute erreur de validation.`,
        },
        { role: "user", content: `${source}${correction}` },
      ],
      stream: false,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Erreur de conversion du scénario par Gemma ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }
  const result = (await response.json()) as { message?: { content?: string } };
  return result.message?.content ?? "";
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "retrieve_context",
      description:
        "Recherche par mots-clés dans les documents CashOffice. Garde le sujet et les mots-clés initiaux, ajoute seulement des synonymes proches si utile et ne pars jamais vers une autre fonctionnalité. CashOffice est ajouté automatiquement. Renvoie les passages les plus pertinents.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Mots-clés de recherche" } },
        required: ["query"],
      },
    },
  },
];

export const askAgent = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) })).max(30),
    }),
  )
  .handler(async ({ data }) => ollamaAgent(data.messages));

async function ollamaAgent(messages: { role: "user" | "assistant"; content: string }[]) {
  const sources = new Map<string, number>();
  // Vérifie d'abord la table chat (réponses validées) pour la dernière question.
  const lastQuestion = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const scenarioRequested = isScenarioRequest(lastQuestion);
  const validated = lastQuestion ? await retrieveChat(lastQuestion) : [];
  for (const v of validated) sources.set("Réponse validée", Math.max(sources.get("Réponse validée") ?? 0, v.similarity));
  const system = validated.length
    ? `${SYSTEM}\n\nRéponses validées trouvées pour la question actuelle :\n\n${formatChat(validated)}\n\n${SCENARIO_INSTRUCTIONS}`
    : `${SYSTEM}\n\n${SCENARIO_INSTRUCTIONS}`;
  const relevantMessages = isCashOfficeFollowUp(lastQuestion)
    ? messages.slice(-4)
    : [{ role: "user" as const, content: lastQuestion }];
  const msgs: any[] = [{ role: "system", content: system }, ...relevantMessages];
  const steps: string[] = [];
  const searchedQueries = new Set<string>();
  const maxSearchRounds = 3;
  const done = async (answer: string) => {
    let responseText = answer;
    if (isCashOfficeBoilerplate(responseText)) {
      const fallbackMatches = await retrieve(lastQuestion, 6);
      for (const match of fallbackMatches) {
        const source = match.metadata?.source ?? "?";
        sources.set(source, Math.max(sources.get(source) ?? 0, match.similarity));
      }
      const toolContext = msgs
        .filter((message: any) => message.role === "tool" && typeof message.content === "string")
        .map((message: any) => message.content)
        .join("\n\n");
      const fallbackContext = fallbackMatches
        .map((match) => `[${match.metadata?.source ?? "?"}]\n${match.content}`)
        .join("\n\n---\n\n");
      const validatedContext = validated.length ? formatChat(validated) : "";
      const context = [validatedContext, toolContext, fallbackContext].filter(Boolean).join("\n\n---\n\n");
      responseText = await recoverCashOfficeAnswer(lastQuestion, context);

      if (!responseText.trim() || isCashOfficeBoilerplate(responseText)) {
        responseText = noCashOfficeInformation(lastQuestion);
      }
    }

    const requiresScenarioFormat = scenarioRequested || isProcedureAnswer(responseText);
    let candidate = responseText;
    let formattedAnswer = formatScenarioAnswer(candidate, requiresScenarioFormat);
    let attempts = 0;

    while (requiresScenarioFormat && isInvalidScenarioAnswer(formattedAnswer) && attempts < 2) {
      const invalid = JSON.parse(formattedAnswer) as { erreurs?: string[] };
      candidate = await convertScenarioAnswer(
        answer,
        candidate,
        Array.isArray(invalid.erreurs) ? invalid.erreurs : [],
      );
      formattedAnswer = formatScenarioAnswer(candidate, true);
      attempts++;
    }

    return {
      answer: formattedAnswer,
      steps,
      sources: [...sources.entries()].map(([s, sim]) => ({ source: s, similarity: sim })),
    };
  };
  for (let turn = 0; turn <= maxSearchRounds; turn++) {
    const canSearch = turn < maxSearchRounds;
    let res: Response;
    try {
      res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages: msgs,
          tools: canSearch ? TOOLS : [],
          stream: false,
        }),
      });
    } catch {
      throw new Error(`Serveur Gemma injoignable (${OLLAMA_URL}).`);
    }
    if (!res.ok) throw new Error(`Gemma ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    const msg = json.message ?? {};
    const calls = msg.tool_calls ?? [];
    if (!canSearch || !calls.length) {
      const finalAnswer =
        typeof msg.content === "string" && msg.content.trim()
          ? msg.content
          : noCashOfficeInformation(lastQuestion);
      return done(finalAnswer);
    }
    msgs.push(msg);
    for (const call of calls) {
      const args = typeof call.function.arguments === "string" ? JSON.parse(call.function.arguments) : call.function.arguments;
      const searchTerms = String(args?.query ?? "").trim() || lastQuestion;
      const displayQuery = contextualizeCashOfficeQuery(searchTerms);
      const queryKey = normalizeCashOfficeSearchTerms(displayQuery);
      if (searchedQueries.size >= maxSearchRounds) {
        msgs.push({
          role: "tool",
          tool_name: call.function.name,
          content: "Limite de recherches atteinte. Utilise les résultats déjà récupérés et réponds maintenant.",
        });
        continue;
      }
      if (searchedQueries.has(queryKey)) {
        msgs.push({
          role: "tool",
          tool_name: call.function.name,
          content: "Cette recherche a déjà été effectuée. Utilise les résultats précédents et réponds maintenant.",
        });
        continue;
      }
      searchedQueries.add(queryKey);
      const query = combineCashOfficeQuery(lastQuestion, searchTerms);
      steps.push(displayQuery);
      const [matches, chatMatches] = await Promise.all([retrieve(query), retrieveChat(query, 2)]);
      for (const c of chatMatches) sources.set("Réponse validée", Math.max(sources.get("Réponse validée") ?? 0, c.similarity));
      for (const m of matches) {
        const src = m.metadata?.source ?? "?";
        sources.set(src, Math.max(sources.get(src) ?? 0, m.similarity));
      }
      const docs = matches.length
        ? matches.map((m) => `[${m.metadata?.source}] (score ${m.similarity.toFixed(2)})\n${m.content}`).join("\n\n---\n\n")
        : "Aucun document trouvé.";
      const output = chatMatches.length ? `${formatChat(chatMatches)}\n\n===\n\n${docs}` : docs;
      msgs.push({ role: "tool", tool_name: call.function.name, content: output });
    }
  }
  return done("L'agent a atteint la limite d'étapes.");
}
