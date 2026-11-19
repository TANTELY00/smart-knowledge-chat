import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MarkdownResponse } from "@/components/markdown-response";

describe("MarkdownResponse", () => {
  it("renders headings, ordered steps, nested bullets, emphasis, citations, and arrows", () => {
    const { container } = render(
      <MarkdownResponse
        content={`### Procédure de remboursement

1. **Accès au module :**
   * Ouvrez **Vente** $\\rightarrow$ **Fidélisation client** [Manuel Cashoffice.pdf].
2. **Validation :**
   * Appuyez sur **F12**.

**⚠️ Point de vigilance :**
* Vérifiez le montant.`}
      />,
    );

    expect(container.querySelector("h3")?.textContent).toBe("Procédure de remboursement");
    expect(container.querySelector("ol")).toBeInTheDocument();
    expect(container.querySelector("ol ul")).toBeInTheDocument();
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
    expect(container.textContent).toContain("Vente → Fidélisation client [Manuel Cashoffice.pdf].");
    expect(container.querySelector("strong")?.textContent).toBe("Accès au module :");
  });

  it("displays model-provided HTML as text instead of rendering it", () => {
    const { container } = render(<MarkdownResponse content="<img src=x onerror=alert(1)>" />);

    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(container.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});
