/** Advisory matches only. A suggestion is never an edit target. */
export function closestMarkdownMatch(markdown: string, needle: string): string | undefined {
  if (needle.length < 4 || needle.length > 1000) return undefined;
  const maximum = Math.floor(needle.length / 3);
  let best = maximum + 1;
  let suggestion: string | undefined;
  let work = 0;
  // ponytail: bounded diagnostic scan; selections still match the complete document exactly.
  const source = markdown.slice(0, 128_000);
  const candidates = new Set<string>(source.split(/\n\s*\n/).filter((part) => part.length <= 1200));
  for (const line of source.split("\n")) {
    if (line.length <= 1200) candidates.add(line);
    for (const match of line.matchAll(/\S+/g)) {
      const start = match.index;
      const end = start + needle.length;
      if (end > line.length + maximum) break;
      for (const delta of [-2, -1, 0, 1, 2]) {
        const candidate = line.slice(start, Math.max(start, end + delta));
        if (candidate.length) candidates.add(candidate);
      }
      if (candidates.size >= 500) break;
    }
    if (candidates.size >= 500) break;
  }
  for (const candidate of candidates) {
    if (Math.abs(candidate.length - needle.length) > maximum) continue;
    const cost = candidate.length * needle.length;
    if (work + cost > 2_000_000) break;
    work += cost;
    let previous = Array.from({ length: candidate.length + 1 }, (_, index) => index);
    for (let row = 1; row <= needle.length; row++) {
      const current = [row];
      for (let column = 1; column <= candidate.length; column++) {
        current[column] = Math.min(
          current[column - 1]! + 1,
          previous[column]! + 1,
          previous[column - 1]! + (needle[row - 1] === candidate[column - 1] ? 0 : 1),
        );
      }
      previous = current;
    }
    const distance = previous[candidate.length]!;
    if (distance < best) {
      best = distance;
      suggestion = candidate;
    }
  }
  return suggestion;
}
