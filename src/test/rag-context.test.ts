import { describe, expect, it } from "vitest";

import {
  combineCashOfficeQuery,
  contextualizeCashOfficeQuery,
  isCashOfficeBoilerplate,
  isCashOfficeFollowUp,
  normalizeCashOfficeSearchTerms,
} from "@/lib/rag-context";

describe("CashOffice RAG context", () => {
  it("adds CashOffice context without removing the user's topic", () => {
    expect(contextualizeCashOfficeQuery("tailles et couleurs d'un article")).toBe(
      "CashOffice tailles et couleurs d'un article",
    );
    expect(
      combineCashOfficeQuery(
        "Comment configurer des tailles et couleurs ?",
        "article déclinaisons variantes",
      ),
    ).toContain("Comment configurer des tailles et couleurs ?");
    expect(contextualizeCashOfficeQuery("CashOffice stock")).toBe("CashOffice stock");
  });

  it("detects generic responses that ask the user to repeat their question", () => {
    expect(isCashOfficeBoilerplate("Veuillez poser votre question concernant CashOffice.")).toBe(
      true,
    );
    expect(isCashOfficeBoilerplate("Je suis prêt à répondre à vos questions.")).toBe(true);
    expect(isCashOfficeBoilerplate("Dans CashOffice, ouvrez le catalogue.")).toBe(false);
  });

  it("normalizes search terms so repeated model searches can be skipped", () => {
    expect(normalizeCashOfficeSearchTerms("Tailles et couleurs d’un article")).toBe(
      "tailles et couleurs d un article",
    );
    expect(normalizeCashOfficeSearchTerms("tailles et couleurs d’un article")).toBe(
      normalizeCashOfficeSearchTerms("Tailles et couleurs d’un article"),
    );
  });

  it("keeps context only for explicit follow-up questions", () => {
    expect(isCashOfficeFollowUp("Et ensuite, comment valider ?")).toBe(true);
    expect(isCashOfficeFollowUp("Dans ce cas, quel menu ouvrir ?")).toBe(true);
    expect(isCashOfficeFollowUp("Comment modifier les modes de règlement ?")).toBe(false);
  });
});
