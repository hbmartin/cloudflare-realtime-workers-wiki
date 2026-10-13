export function normalizedTitle(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}
export function titleTrigrams(value: string) {
  const characters = Array.from(normalizedTitle(value));
  return [...new Set(characters.slice(0, -2).map((_, index) => characters.slice(index, index + 3).join("")))];
}
export function titleTrigramMatch(query: string) {
  const grams = titleTrigrams(query).slice(0, 60);
  return grams.length ? grams.map((gram) => `"${gram.replaceAll('"', '""')}"`).join(" OR ") : null;
}
export function titleSimilarity(query: string, title: string) {
  const queryGrams = new Set(titleTrigrams(query));
  const titleGrams = new Set(titleTrigrams(title));
  let intersection = 0;
  for (const gram of queryGrams) if (titleGrams.has(gram)) intersection++;
  return queryGrams.size && titleGrams.size ? (2 * intersection) / (queryGrams.size + titleGrams.size) : 0;
}
