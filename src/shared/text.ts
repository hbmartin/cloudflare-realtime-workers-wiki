export function collapseWhitespace(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}
export function sanitizeXmlText(value: string) {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return (
        code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 32 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        (code >= 0x10000 && code <= 0x10ffff)
      );
    })
    .join("");
}

// URL policies vary by format; they all reject ASCII control characters.
export function hasUrlControls(value: string) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
