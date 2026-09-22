const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UTF8_FLAG = 0x0800;
const MAX_ZIP_ENTRIES = 5_000;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;

export type ZipEntry = { path: string; bytes: Uint8Array };

export class ZipValidationError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid" | "limit",
  ) {
    super(message);
    this.name = "ZipValidationError";
  }
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function safeArchivePath(path: string) {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const directory = normalized.endsWith("/");
  const segments = normalized.slice(0, directory ? -1 : undefined).split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes("\0") ||
    segments.some((segment) => segment === ".." || segment === "")
  ) {
    throw new ZipValidationError("The archive contains an unsafe path.", "invalid");
  }
  return normalized;
}

function header(size: number) {
  const bytes = new Uint8Array(size);
  return { bytes, view: new DataView(bytes.buffer) };
}

export function createZip(entries: ZipEntry[]) {
  if (entries.length > MAX_ZIP_ENTRIES) throw new ZipValidationError("The archive contains too many files.", "limit");
  const encoder = new TextEncoder();
  const files = entries.map((entry) => {
    const path = safeArchivePath(entry.path);
    return { ...entry, path, name: encoder.encode(path) };
  });
  if (files.reduce((total, entry) => total + entry.bytes.byteLength, 0) > MAX_EXPANDED_BYTES) {
    throw new ZipValidationError("The archive expands beyond the supported size.", "limit");
  }
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const file of files) {
    if (file.bytes.byteLength > 0xffffffff || file.name.byteLength > 0xffff) {
      throw new ZipValidationError("The archive file is too large.", "limit");
    }
    const checksum = crc32(file.bytes);
    const local = header(30);
    local.view.setUint32(0, LOCAL_FILE_HEADER, true);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(6, UTF8_FLAG, true);
    local.view.setUint32(14, checksum, true);
    local.view.setUint32(18, file.bytes.byteLength, true);
    local.view.setUint32(22, file.bytes.byteLength, true);
    local.view.setUint16(26, file.name.byteLength, true);
    localParts.push(local.bytes, file.name, file.bytes);

    const central = header(46);
    central.view.setUint32(0, CENTRAL_DIRECTORY_HEADER, true);
    central.view.setUint16(4, 20, true);
    central.view.setUint16(6, 20, true);
    central.view.setUint16(8, UTF8_FLAG, true);
    central.view.setUint32(16, checksum, true);
    central.view.setUint32(20, file.bytes.byteLength, true);
    central.view.setUint32(24, file.bytes.byteLength, true);
    central.view.setUint16(28, file.name.byteLength, true);
    central.view.setUint32(42, localOffset, true);
    centralParts.push(central.bytes, file.name);
    localOffset += local.bytes.byteLength + file.name.byteLength + file.bytes.byteLength;
  }
  const central = concatBytes(centralParts);
  const end = header(22);
  end.view.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
  end.view.setUint16(8, files.length, true);
  end.view.setUint16(10, files.length, true);
  end.view.setUint32(12, central.byteLength, true);
  end.view.setUint32(16, localOffset, true);
  return concatBytes([...localParts, central, end.bytes]);
}

// The pre-decompression guards can only weigh the sizes the archive declares, so a
// entry that lies about them would otherwise be buffered in full before the integrity
// check rejects it. Both ceilings are enforced as the output is produced so a
// dishonest declaration cannot consume the rest of the archive budget.
async function inflateRaw(bytes: Uint8Array, declaredSize: number, remainingArchiveBudget: number) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > remainingArchiveBudget) {
        throw new ZipValidationError("The archive expands beyond the supported size.", "limit");
      }
      if (total > declaredSize) {
        throw new ZipValidationError("The ZIP entry failed its integrity check.", "invalid");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function findEnd(view: DataView) {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new ZipValidationError("The ZIP central directory is missing.", "invalid");
}

export async function readZip(
  bytes: Uint8Array,
  limits: { maxEntries?: number; maxExpandedBytes?: number } = {},
): Promise<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEnd(view);
  if (view.getUint16(endOffset + 4, true) !== 0 || view.getUint16(endOffset + 6, true) !== 0) {
    throw new ZipValidationError("Multi-disk ZIP archives are not supported.", "invalid");
  }
  const entries = view.getUint16(endOffset + 10, true);
  const maxEntries = Math.min(MAX_ZIP_ENTRIES, limits.maxEntries ?? MAX_ZIP_ENTRIES);
  const maxExpandedBytes = Math.min(MAX_EXPANDED_BYTES, limits.maxExpandedBytes ?? MAX_EXPANDED_BYTES);
  if (entries > maxEntries) throw new ZipValidationError("The archive contains too many files.", "limit");
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (centralOffset + centralSize > endOffset)
    throw new ZipValidationError("The ZIP central directory is invalid.", "invalid");
  const decoder = new TextDecoder();
  const output: ZipEntry[] = [];
  let offset = centralOffset;
  let expanded = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > endOffset || view.getUint32(offset, true) !== CENTRAL_DIRECTORY_HEADER) {
      throw new ZipValidationError("The ZIP central directory is invalid.", "invalid");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const checksum = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    if (flags & 1) throw new ZipValidationError("Encrypted ZIP entries are not supported.", "invalid");
    if (method !== 0 && method !== 8)
      throw new ZipValidationError("The ZIP uses an unsupported compression method.", "invalid");
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > endOffset) throw new ZipValidationError("The ZIP entry name is truncated.", "invalid");
    const path = safeArchivePath(decoder.decode(bytes.subarray(offset + 46, nameEnd)));
    offset = nameEnd + extraLength + commentLength;
    if (offset > endOffset) throw new ZipValidationError("The ZIP central directory is truncated.", "invalid");
    if (path.endsWith("/")) continue;
    if (method === 0 && compressedSize !== uncompressedSize) {
      throw new ZipValidationError("The ZIP entry failed its integrity check.", "invalid");
    }
    const expandedBefore = expanded;
    const remainingArchiveBudget = maxExpandedBytes - expandedBefore;
    if (uncompressedSize > remainingArchiveBudget || (compressedSize > 0 && uncompressedSize / compressedSize > 200)) {
      throw new ZipValidationError("The archive expands beyond the supported size.", "limit");
    }
    expanded += uncompressedSize;
    if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== LOCAL_FILE_HEADER) {
      throw new ZipValidationError("The ZIP local header is invalid.", "invalid");
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > centralOffset)
      throw new ZipValidationError("The ZIP entry data is truncated.", "invalid");
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    let contents: Uint8Array;
    try {
      if (method === 0) {
        if (compressedSize > remainingArchiveBudget) {
          throw new ZipValidationError("The archive expands beyond the supported size.", "limit");
        }
        contents = compressed.slice();
      } else {
        contents = await inflateRaw(compressed, uncompressedSize, remainingArchiveBudget);
      }
    } catch (error) {
      if (error instanceof ZipValidationError) throw error;
      throw new ZipValidationError("The ZIP entry could not be decompressed.", "invalid");
    }
    if (contents.byteLength > remainingArchiveBudget) {
      throw new ZipValidationError("The archive expands beyond the supported size.", "limit");
    }
    if (contents.byteLength !== uncompressedSize || crc32(contents) !== checksum) {
      throw new ZipValidationError("The ZIP entry failed its integrity check.", "invalid");
    }
    output.push({ path, bytes: contents });
  }
  return output;
}
