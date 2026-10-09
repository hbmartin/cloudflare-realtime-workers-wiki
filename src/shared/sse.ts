/** Parse SSE across arbitrary UTF-8/network boundaries, with bounded event memory. */
export async function* readSse(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    data: string[] = [],
    size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 1_048_576) throw new Error("Stream event exceeds its limit.");
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (line === "") {
          if (data.length) yield data.join("\n");
          data = [];
          size = 0;
        } else if (line.startsWith("data:")) {
          const value = line.slice(5).replace(/^ /, "");
          size += value.length;
          if (size > 1_048_576) throw new Error("Stream event exceeds its limit.");
          data.push(value);
        }
      }
      if (chunk.done) break;
    }
    // A terminal response event must end with a blank SSE line. Incomplete
    // transport frames are never treated as successful completion.
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
