export function errorMessageKey(message: string) {
  const trimmed = message.trim();
  return trimmed.replace(/[\s.!?…]+$/, "") || trimmed;
}
