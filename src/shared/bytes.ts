export const UPDATE_CHUNK_BYTES = 1024 * 1024;

export function splitBytes(bytes: Uint8Array, chunkSize = UPDATE_CHUNK_BYTES) {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error("chunkSize must be positive");
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    chunks.push(bytes.slice(offset, offset + chunkSize));
  }
  return chunks;
}

export function joinBytes(chunks: Uint8Array[]) {
  const joined = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
