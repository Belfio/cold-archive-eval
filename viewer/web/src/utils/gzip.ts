export async function decompressGzipText(input: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length === 0) {
    return "";
  }

  // Check gzip magic header 0x1f 0x8b
  const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isGzip) {
    return new TextDecoder("utf-8").decode(bytes);
  }

  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  const writePromise = writer.write(bytes as unknown as BufferSource).then(() => writer.close());

  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
      totalLength += value.byteLength;
    }
  }

  await writePromise;

  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder("utf-8").decode(merged);
}
