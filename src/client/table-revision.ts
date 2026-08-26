export function mergeMutationRevision(knownRevision: number | null, committedRevision: number) {
  return knownRevision === null ? null : Math.max(knownRevision, committedRevision);
}
