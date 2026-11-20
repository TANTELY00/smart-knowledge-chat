import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  formatScenarioAnswer,
  isInvalidScenarioAnswer,
  isProcedureAnswer,
  isScenarioRequest,
} from "@/lib/scenario";

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
  return rpc<Match[]>("match_rag_documents", { query_text: query, match_count: k });
}

type ChatMatch = { questions: string; bonne_reponse: string; similarity: number };

async function retrieveChat(query: string, k = 3): Promise<ChatMatch[]> {
  try {
    return await rpc<ChatMatch[]>("match_chat", { query_text: query, match_count: k });
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

const SYSTEM = `Tu es un assistant de recherche (agent RAG). Pour toute question sur les documents, appelle l'outil retrieve_context avec des mots-clés précis, éventuellement plusieurs fois avec des mots-clés reformulés ou des synonymes.

Réponds uniquement à partir du contexte récupéré, dans la langue de l'utilisateur. N'invente aucune information ni référence; cite les sources avec leur nom exact entre crochets [source], près de l'information concernée. Si une information est absente du contexte, dis-le clairement.

Fais des réponses claires, concises et directement exploitables. Commence par répondre directement à la question. Pour une procédure, utilise un titre, des étapes numérotées avec des intitulés courts et des sous-puces seulement pour les détails utiles. Pour une explication, préfère des paragraphes courts et des puces si elles améliorent la lecture. Mets en gras les éléments importants sans en abuser.

Utilise du Markdown standard (titres avec #, listes avec 1. ou -, gras avec **). N'utilise jamais de syntaxe LaTeX ou de délimiteurs mathématiques; pour un chemin de menus, écris par exemple « Vente > Fidélisation client > Remboursement » ou « Vente, puis Fidélisation client ». Évite de répéter la même citation à chaque phrase d'une étape.

Base de connaissance validée : certains passages sont marqués [Réponse validée]. Ce sont des réponses corrigées par un humain. Si une réponse validée correspond à la question, ses informations sont PRIORITAIRES sur les documents et doivent être utilisées sans les contredire ; cite-la comme [Réponse validée]. En cas de contradiction avec un document, suis la réponse validée. Tu peux restructurer une procédure validée au format demandé sans en changer les informations.`;

const SCENARIO_INSTRUCTIONS = `
Pour une demande de scénario de test, de cas de test ou de test automatisé, réponds uniquement avec un objet JSON valide, sans Markdown ni texte avant/après. Le format est :
{"titre":"...","prerequis":[],"etapes":[{"action":"...","cible":"...","valeur":"...","condition":"..."}]}
Applique également ce format quand la réponse est une procédure d'utilisation de CashOffice avec des actions à effectuer dans l'interface, même si la question ne mentionne pas un scénario ou un test. Mappe les verbes toucher, cliquer et sélectionner aux actions correspondantes ; pour attendre l'affichage d'un écran ou d'un contrôle, utilise wait avec la condition visible. La cible doit être l'identifiant UIA connu ou, s'il n'est pas fourni, le libellé visible exact. N'invente pas d'identifiants techniques.
Les propriétés inutilisées d'une étape doivent être omises. Actions autorisées : launch, attach, click, set, select, key, wait, assert, screenshot, export_uia_tree, close. Conditions autorisées : existe, n_existe_pas, visible, active, texte_egale, contient, commence_par, expression_reguliere, valeur_numeric_egale, coche, decoche, ligne_selectionnee, message_erreur_visible. wait et assert nécessitent une condition ; set, select et key nécessitent une valeur. N'utilise select que pour choisir une option précise et renseigne alors valeur ; pour sélectionner une fiche ou un élément visible, utilise click si aucune valeur à sélectionner n'est indiquée. N'ajoute pas de condition à click ou key. Ne transforme pas une description comme « effectuer la consultation » en faux nom de bouton ; omets-la si les actions précédentes couvrent déjà la tâche. Pour fermer, choisis une seule option explicitement mentionnée (bouton connu ou touche). N'invente pas de cibles ni d'informations absentes des documents ou de la demande. N'inclus pas launch ni attach : l'application CashOffice.exe sera ajoutée automatiquement. Pour une demande hors périmètre, réponds uniquement {"statut":"hors_perimetre","message":"..."}.
Pour les autres questions, conserve le format de réponse habituel.`;

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
      description: "Recherche par mots-clés dans la base de documents. Renvoie les passages les plus pertinents.",
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
  const msgs: any[] = [{ role: "system", content: system }, ...messages];
  const steps: string[] = [];
  const done = async (answer: string) => {
    const requiresScenarioFormat = scenarioRequested || isProcedureAnswer(answer);
    let candidate = answer;
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
  for (let turn = 0; turn < 5; turn++) {
    let res: Response;
    try {
      res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: OLLAMA_MODEL, messages: msgs, tools: TOOLS, stream: false }),
      });
    } catch {
      throw new Error(`Serveur Gemma injoignable (${OLLAMA_URL}).`);
    }
    if (!res.ok) throw new Error(`Gemma ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    const msg = json.message ?? {};
    const calls = msg.tool_calls ?? [];
    if (!calls.length) return done(msg.content || "(pas de réponse)");
    msgs.push(msg);
    for (const call of calls) {
      const args = typeof call.function.arguments === "string" ? JSON.parse(call.function.arguments) : call.function.arguments;
      const query = String(args?.query ?? "");
      steps.push(query);
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
