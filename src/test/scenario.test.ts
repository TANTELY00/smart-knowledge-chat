import { describe, expect, it } from "vitest";

import { formatScenarioAnswer, isProcedureAnswer, isScenarioRequest } from "@/lib/scenario";

describe("scenario response formatting", () => {
  it("normalizes valid scenarios, variables, and the standard launch action", () => {
    const answer = formatScenarioAnswer(
      `\`\`\`json
      {
        "titre": "Création facture",
        "prerequis": ["Utilisateur connecté", "Les règles sont obligatoires"],
        "etapes": [
          { "action": "attach", "cible": "ancienne fenêtre" },
          { "action": "set", "cible": "edtMotDePasse", "valeur": "\${TEST_PASSWORD}" },
          { "action": "assert", "cible": "lblTotal", "condition": "contient", "valeur": "120,00" }
        ]
      }
      \`\`\``,
      true,
    );

    const scenario = JSON.parse(answer) as Record<string, unknown>;
    expect(scenario["id"]).toMatch(/^CASH-\d{3}$/);
    expect(scenario).toEqual({
      id: scenario["id"],
      titre: "Création facture",
      prerequis: ["Utilisateur connecté"],
      etapes: [
        { action: "launch", cible: "CashOffice.exe" },
        { action: "set", cible: "edtMotDePasse", valeur: "{{TEST_PASSWORD}}" },
        { action: "assert", cible: "lblTotal", condition: "contient", valeur: "120,00" },
      ],
    });
  });

  it("returns structured validation errors for malformed scenario answers", () => {
    const result = JSON.parse(formatScenarioAnswer('{"titre":"Sans étapes","etapes":[]}', true));

    expect(result["statut"]).toBe("scenario_invalide");
    expect(result["erreurs"]).toContain("etapes manquantes ou vides");
  });

  it("accepts select steps when their selected value is provided", () => {
    const result = JSON.parse(
      formatScenarioAnswer(
        '{"titre":"Sélection article","etapes":[{"action":"select","cible":"Liste articles","valeur":"Article A"}]}',
        true,
      ),
    );

    expect(result["etapes"][1]).toEqual({
      action: "select",
      cible: "Liste articles",
      valeur: "Article A",
    });
  });

  it("keeps parseable invalid input as a formatted JSON object in brut", () => {
    const raw =
      '{"titre":"Consultation du stock","etapes":[{"action":"select","cible":"fiche article"}]}';
    const result = JSON.parse(formatScenarioAnswer(raw, true));

    expect(result["brut"]).toEqual(JSON.parse(raw));
    expect(JSON.stringify(result, null, 2)).toContain('\n        "action": "select"');
  });

  it("keeps a top-level array as formatted JSON in brut rather than an escaped string", () => {
    const raw =
      '[{"titre":"Création taille","prerequis":[],"etapes":[]} , {"titre":"Création article","prerequis":[],"etapes":[]}]';
    const result = JSON.parse(formatScenarioAnswer(raw, true));

    expect(result["brut"]).toEqual(JSON.parse(raw));
    expect(Array.isArray(result["brut"])).toBe(true);
    expect(JSON.stringify(result, null, 2)).toContain('\n      "titre": "Création taille"');
  });

  it("leaves ordinary answers unchanged and formats out-of-scope responses", () => {
    expect(formatScenarioAnswer("Voici la réponse.", false)).toBe("Voici la réponse.");
    expect(formatScenarioAnswer('{"statut":"hors_perimetre","message":"Autre sujet"}', false)).toBe(
      '{\n  "statut": "hors_perimetre",\n  "message": "Autre sujet"\n}',
    );
  });

  it("recognizes French and English scenario requests", () => {
    expect(isScenarioRequest("Créer un scénario de connexion")).toBe(true);
    expect(isScenarioRequest("Génère des scénarios de facturation")).toBe(true);
    expect(isScenarioRequest("Write a test case for login")).toBe(true);
    expect(isScenarioRequest("Comment fonctionne la caisse ?")).toBe(false);
  });

  it("recognizes numbered procedure responses without classifying unrelated prose", () => {
    expect(isProcedureAnswer("1. Cliquer sur Article\n2. Ouvrir Quantités")).toBe(true);
    expect(isProcedureAnswer("Voici la réponse :\n- Vérifier le stock")).toBe(false);
    expect(isProcedureAnswer("Le stock est consultable depuis l'encaissement.")).toBe(false);
  });
});
