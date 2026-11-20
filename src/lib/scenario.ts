const APP_EXE = "CashOffice.exe";

const ACTIONS = [
  "launch",
  "attach",
  "click",
  "set",
  "select",
  "key",
  "wait",
  "assert",
  "screenshot",
  "export_uia_tree",
  "close",
] as const;

const CONDITIONS = [
  "existe",
  "n_existe_pas",
  "visible",
  "active",
  "texte_egale",
  "contient",
  "commence_par",
  "expression_reguliere",
  "valeur_numeric_egale",
  "coche",
  "decoche",
  "ligne_selectionnee",
  "message_erreur_visible",
] as const;

const CONDITIONS_AVEC_VALEUR = [
  "texte_egale",
  "contient",
  "commence_par",
  "expression_reguliere",
  "valeur_numeric_egale",
] as const;

const ACTIONS_AVEC_CIBLE = [
  "launch",
  "attach",
  "click",
  "set",
  "select",
  "wait",
  "assert",
] as const;
const ACTIONS_AVEC_VALEUR = ["set", "select", "key"] as const;

type Action = (typeof ACTIONS)[number];
type Condition = (typeof CONDITIONS)[number];

type ScenarioStep = {
  action: Action;
  cible?: string;
  valeur?: string;
  condition?: Condition;
};

type Scenario = {
  id: string;
  titre: string;
  prerequis: string[];
  etapes: ScenarioStep[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isProvided(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function normalizeVariables(value: string): string {
  return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, "{{$1}}");
}

function hash3(value: string): string {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return String(hash % 1000).padStart(3, "0");
}

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  return JSON.parse(start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate);
}

function isScenarioShape(value: unknown): boolean {
  return isRecord(value) && ("etapes" in value || value["statut"] === "hors_perimetre");
}

function invalidResponse(raw: string, errors: string[]): string {
  let brut: unknown = raw;
  try {
    brut = extractJson(raw);
  } catch {
    // Keep unparseable model text available for diagnosis.
  }
  return JSON.stringify({ statut: "scenario_invalide", erreurs: errors, brut }, null, 2);
}

function validateScenario(data: Record<string, unknown>): {
  scenario: Scenario | null;
  errors: string[];
} {
  const errors: string[] = [];
  const titre = String(data["titre"] ?? "").trim();

  if (!titre) errors.push("titre manquant");
  if (!Array.isArray(data["etapes"]) || data["etapes"].length === 0) {
    errors.push("etapes manquantes ou vides");
  }

  const prerequis = Array.isArray(data["prerequis"])
    ? data["prerequis"]
        .filter(isProvided)
        .map((item) => normalizeVariables(String(item)).trim())
        .filter(
          (item) =>
            item &&
            !(
              /\b(est|sont)\s+obligatoires?\b/i.test(item) && !/^FEN[ÊE]TRES POSSIBLES/i.test(item)
            ),
        )
    : [];

  const steps: ScenarioStep[] = [];
  const sourceSteps = Array.isArray(data["etapes"]) ? data["etapes"] : [];

  sourceSteps.forEach((value, index) => {
    const name = `étape ${index + 1}`;
    if (!isRecord(value)) {
      errors.push(`${name} : étape invalide`);
      return;
    }

    const action = String(value["action"] ?? "").trim();
    if (!(ACTIONS as readonly string[]).includes(action)) {
      errors.push(`${name} : action inconnue « ${action} »`);
      return;
    }

    const step: ScenarioStep = { action: action as Action };
    if (isProvided(value["cible"])) step.cible = normalizeVariables(String(value["cible"])).trim();
    if (isProvided(value["valeur"])) step.valeur = normalizeVariables(String(value["valeur"]));
    if ((ACTIONS_AVEC_CIBLE as readonly string[]).includes(action) && !step.cible) {
      errors.push(`${name} : cible manquante (${action})`);
    }
    if ((ACTIONS_AVEC_VALEUR as readonly string[]).includes(action) && step.valeur === undefined) {
      errors.push(`${name} : valeur manquante (${action})`);
    }

    if (isProvided(value["condition"])) {
      const condition = String(value["condition"]).trim();
      if (!(CONDITIONS as readonly string[]).includes(condition)) {
        errors.push(`${name} : condition inconnue « ${condition} »`);
      } else {
        step.condition = condition as Condition;
      }
      if (
        (CONDITIONS_AVEC_VALEUR as readonly string[]).includes(condition) &&
        step.valeur === undefined
      ) {
        errors.push(`${name} : valeur manquante pour la condition ${condition}`);
      }
    } else if (action === "wait" || action === "assert") {
      errors.push(`${name} : condition manquante (${action})`);
    }

    steps.push(step);
  });

  const normalizedSteps = steps.filter(
    (step) => step.action !== "launch" && step.action !== "attach",
  );
  if (normalizedSteps.length > 0) {
    normalizedSteps.unshift({ action: "launch", cible: APP_EXE });
  } else {
    errors.push("aucune étape d’action après normalisation");
  }

  if (errors.length > 0) return { scenario: null, errors };

  return {
    scenario: {
      id: `CASH-${hash3(titre)}`,
      titre,
      prerequis,
      etapes: normalizedSteps,
    },
    errors,
  };
}

export function isScenarioRequest(question: string): boolean {
  return /\b(scénarios?|scenarios?|cas de tests?|test cases?|tests? automatisés?|automatisations?)\b/i.test(
    question,
  );
}

export function isProcedureAnswer(answer: string): boolean {
  return /(?:^|\n)\s*\d+[.)]\s+\S/m.test(answer);
}

export function isInvalidScenarioAnswer(answer: string): boolean {
  try {
    const data: unknown = JSON.parse(answer);
    return isRecord(data) && data["statut"] === "scenario_invalide";
  } catch {
    return false;
  }
}

export function formatScenarioAnswer(raw: string, scenarioRequested: boolean): string {
  let data: unknown;
  try {
    data = extractJson(raw);
  } catch (error) {
    if (!scenarioRequested) return raw;
    return invalidResponse(raw, [
      `Réponse non JSON : ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  if (!isScenarioShape(data)) {
    return scenarioRequested
      ? invalidResponse(raw, ["La réponse de l’agent doit être un objet JSON de scénario."])
      : raw;
  }

  if (!isRecord(data)) {
    return invalidResponse(raw, ["La réponse de l’agent doit être un objet JSON."]);
  }

  if (data["statut"] === "hors_perimetre") {
    return JSON.stringify(
      { statut: "hors_perimetre", message: String(data["message"] ?? "") },
      null,
      2,
    );
  }

  const { scenario, errors } = validateScenario(data);
  return scenario ? JSON.stringify(scenario, null, 2) : invalidResponse(raw, errors);
}
