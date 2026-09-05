const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UTF8_FLAG = 0x0800;
const MAX_ZIP_ENTRIES = 5_000;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;

export type ZipEntry = { path: string; bytes: Uint8Array };

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
    throw new Error("The archive contains an unsafe path.");
  }
  return normalized;
}

function header(size: number) {
  const bytes = new Uint8Array(size);
  return { bytes, view: new DataView(bytes.buffer) };
}

export function createZip(entries: ZipEntry[]) {
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error("The archive contains too many files.");
  const encoder = new TextEncoder();
  const files = entries.map((entry) => ({ ...entry, path: safeArchivePath(entry.path), name: encoder.encode(entry.path) }));
  if (files.reduce((total, entry) => total + entry.bytes.byteLength, 0) > MAX_EXPANDED_BYTES) {
    throw new Error("The archive expands beyond the supported size.");
  }
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const file of files) {
    if (file.bytes.byteLength > 0xffffffff || file.name.byteLength > 0xffff) {
      throw new Error("The archive file is too large.");
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

async function inflateRaw(bytes: Uint8Array) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function findEnd(view: DataView) {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error("The ZIP central directory is missing.");
}

export async function readZip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEnd(view);
  if (view.getUint16(endOffset + 4, true) !== 0 || view.getUint16(endOffset + 6, true) !== 0) {
    throw new Error("Multi-disk ZIP archives are not supported.");
  }
  const entries = view.getUint16(endOffset + 10, true);
  if (entries > MAX_ZIP_ENTRIES) throw new Error("The archive contains too many files.");
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (centralOffset + centralSize > endOffset) throw new Error("The ZIP central directory is invalid.");
  const decoder = new TextDecoder();
  const output: ZipEntry[] = [];
  let offset = centralOffset;
  let expanded = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > endOffset || view.getUint32(offset, true) !== CENTRAL_DIRECTORY_HEADER) {
      throw new Error("The ZIP central directory is invalid.");
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
    if (flags & 1) throw new Error("Encrypted ZIP entries are not supported.");
    if (method !== 0 && method !== 8) throw new Error("The ZIP uses an unsupported compression method.");
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > endOffset) throw new Error("The ZIP entry name is truncated.");
    const path = safeArchivePath(decoder.decode(bytes.subarray(offset + 46, nameEnd)));
    offset = nameEnd + extraLength + commentLength;
    if (offset > endOffset) throw new Error("The ZIP central directory is truncated.");
    if (path.endsWith("/")) continue;
    expanded += uncompressedSize;
    if (expanded > MAX_EXPANDED_BYTES || (compressedSize > 0 && uncompressedSize / compressedSize > 200)) {
      throw new Error("The archive expands beyond the supported size.");
    }
    if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== LOCAL_FILE_HEADER) {
      throw new Error("The ZIP local header is invalid.");
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > centralOffset) throw new Error("The ZIP entry data is truncated.");
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    const contents = method === 0 ? compressed.slice() : await inflateRaw(compressed);
    if (contents.byteLength !== uncompressedSize || crc32(contents) !== checksum) {
      throw new Error("The ZIP entry failed its integrity check.");
    }
    output.push({ path, bytes: contents });
  }
  return output;
}
