import { describe, expect, it } from "vitest";

import { composePageText } from "@/lib/pdf-ocr";

describe("PDF image OCR indexing", () => {
  it("keeps text read from an image in the page content sent for chunking", () => {
    const result = composePageText(7, "Texte normal du PDF", [
      { image: 2, text: "CODE CAISSE : OXALIS-427" },
    ]);

    expect(result).toContain("Texte normal du PDF");
    expect(result).toContain("[Texte OCR de l’image 2, page 7]");
    expect(result).toContain("CODE CAISSE : OXALIS-427");
  });

  it("returns OCR text even when the scanned page has no native text", () => {
    const result = composePageText(3, "  \n", [{ image: 1, text: "Facture scannée" }]);

    expect(result).toBe("[Texte OCR de l’image 1, page 3]\nFacture scannée");
  });

  it("does not create empty OCR sections for decorative images", () => {
    expect(composePageText(1, "Introduction", [{ image: 1, text: "  \n" }])).toBe("Introduction");
  });
});
