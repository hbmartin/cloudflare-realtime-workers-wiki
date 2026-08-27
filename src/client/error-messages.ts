export function errorMessageKey(message: string) {
  return message.trim().replace(/[\s.!?…]+$/, "");
}
