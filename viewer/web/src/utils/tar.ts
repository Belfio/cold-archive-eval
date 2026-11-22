export type TarEntry = {
  name: string;
  size: number;
  data: Uint8Array;
  isJpeg: boolean;
};

function readNullTerminatedString(bytes: Uint8Array, start: number, length: number): string {
  let end = start;
  const limit = Math.min(bytes.length, start + length);
  while (end < limit && bytes[end] !== 0) {
    end++;
  }
  return new TextDecoder("utf-8").decode(bytes.subarray(start, end)).trim();
}

function parseOctalSize(bytes: Uint8Array, start: number, length: number): number {
  const raw = readNullTerminatedString(bytes, start, length).replace(/\s+/g, "");
  if (!raw) {
    return 0;
  }
  const parsed = Number.parseInt(raw, 8);
  return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
}

function isAllZeroBlock(bytes: Uint8Array, offset: number): boolean {
  const end = Math.min(bytes.length, offset + 512);
  for (let i = offset; i < end; i++) {
    if (bytes[i] !== 0) {
      return false;
    }
  }
  return true;
}

function parsePaxPath(data: Uint8Array): string | null {
  const text = new TextDecoder("utf-8").decode(data);
  for (const line of text.split("\n")) {
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx > 0) {
      const kv = line.slice(spaceIdx + 1);
      if (kv.startsWith("path=")) {
        return kv.slice(5);
      }
    }
  }
  return null;
}

export function parseTar(input: ArrayBuffer | Uint8Array): TarEntry[] {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingNameOverride: string | null = null;

  while (offset + 512 <= bytes.length) {
    if (isAllZeroBlock(bytes, offset)) {
      break;
    }

    const rawName = readNullTerminatedString(bytes, offset, 100);
    const size = parseOctalSize(bytes, offset + 124, 12);
    const typeFlagByte = bytes[offset + 156];
    const typeFlag = typeFlagByte === 0 ? "0" : String.fromCharCode(typeFlagByte);
    const prefix = readNullTerminatedString(bytes, offset + 345, 155);

    const dataStart = offset + 512;
    const dataEnd = Math.min(bytes.length, dataStart + size);
    const data = bytes.subarray(dataStart, dataEnd);
    const blocks = Math.ceil(size / 512);
    offset = dataStart + blocks * 512;

    if (typeFlag === "x" || typeFlag === "g") {
      const paxPath = parsePaxPath(data);
      if (paxPath) {
        pendingNameOverride = paxPath;
      }
      continue;
    }

    if (typeFlag === "L") {
      pendingNameOverride = readNullTerminatedString(data, 0, data.length);
      continue;
    }

    if (typeFlag !== "0") {
      pendingNameOverride = null;
      continue;
    }

    const combinedName = prefix ? `${prefix}/${rawName}` : rawName;
    const name = pendingNameOverride || combinedName;
    pendingNameOverride = null;

    if (!name) {
      continue;
    }

    const lower = name.toLowerCase();
    const hasJpegMagic = data.length >= 2 && data[0] === 0xff && data[1] === 0xd8;
    const isJpeg = lower.endsWith(".jpg") || lower.endsWith(".jpeg") || hasJpegMagic;

    entries.push({
      name,
      size,
      data,
      isJpeg,
    });
  }

  return entries;
}
