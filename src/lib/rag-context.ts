export function contextualizeCashOfficeQuery(query: string): string {
  const clean = query.trim();
  if (!clean || /\bcashoffice\b/i.test(clean)) return clean;
  return `CashOffice ${clean}`;
}

export function combineCashOfficeQuery(question: string, searchTerms: string): string {
  return contextualizeCashOfficeQuery(`${question.trim()} ${searchTerms.trim()}`);
}

export function normalizeCashOfficeSearchTerms(query: string): string {
  return query
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function isCashOfficeBoilerplate(answer: string): boolean {
  return /je suis prêt à répondre à vos questions|veuillez (?:poser|fournir) votre question|please (?:provide|ask) your question/i.test(
    answer,
  );
}

export function isCashOfficeFollowUp(question: string): boolean {
  return /^(?:et\b|ensuite\b|dans ce cas\b|pour cela\b|à ce sujet\b|ce mode\b|cette étape\b|cette procédure\b|cette option\b|ça\b|cela\b)/i.test(
    question.trim(),
  );
}
