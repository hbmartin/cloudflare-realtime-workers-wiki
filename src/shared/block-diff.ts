function blockIds(xml: string) {
  return new Set([...xml.matchAll(/(?:id|blockId)=['"]([^'"]+)/g)].map((match) => match[1]));
}

export function diffBlockIds(oldXml: string, currentXml: string) {
  const oldIds = blockIds(oldXml);
  const currentIds = blockIds(currentXml);
  return {
    added: [...currentIds].filter((id) => !oldIds.has(id)),
    removed: [...oldIds].filter((id) => !currentIds.has(id)),
    identical: oldXml === currentXml,
  };
}

export function plainVersion(xml: string) {
  return (
    xml
      .replace(/<[^>]*>/g, "\n")
      .replace(/\n{2,}/g, "\n")
      .trim() || "Empty document"
  );
}
