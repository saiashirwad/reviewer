/**
 * A streaming reader for the gzipped ustar archives GitHub serves from
 * `/repos/{owner}/{repo}/tarball/{ref}`. Every entry sits under one top-level
 * `{owner}-{repo}-{sha}/` directory, which is stripped.
 */

export type Entry =
  | { readonly path: string; readonly text: string; }
  | { readonly path: string; readonly skipped: "binary" | "too-large"; };

const BLOCK = 512;

const decoder = new TextDecoder();

const field = (header: Uint8Array, offset: number, length: number) => {
  const bytes = header.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
};

const octal = (header: Uint8Array, offset: number, length: number) =>
  Number.parseInt(field(header, offset, length).trim() || "0", 8);

/** Pax extended headers carry `length key=value\n` records; only `path` matters here. */
const paxPath = (bytes: Uint8Array): string | undefined => {
  const text = decoder.decode(bytes);
  let index = 0;
  while (index < text.length) {
    const space = text.indexOf(" ", index);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(index, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, index + length - 1);
    if (record.startsWith("path=")) return record.slice(5);
    index += length;
  }
  return undefined;
};

const stripRoot = (path: string) => path.slice(path.indexOf("/") + 1);

const toText = (bytes: Uint8Array): string | undefined => {
  if (bytes.subarray(0, 8_000).includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

/** Buffers just enough of a byte stream to read or skip exact lengths. */
const byteReader = (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);
  let done = false;

  const fill = async (length: number) => {
    while (buffer.length < length && !done) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        break;
      }
      const next = new Uint8Array(buffer.length + chunk.value.length);
      next.set(buffer);
      next.set(chunk.value, buffer.length);
      buffer = next;
    }
    return buffer.length >= length;
  };

  return {
    read: async (length: number): Promise<Uint8Array | undefined> => {
      if (!(await fill(length))) return undefined;
      const bytes = buffer.slice(0, length);
      buffer = buffer.subarray(length);
      return bytes;
    },
    skip: async (length: number): Promise<void> => {
      let remaining = length;
      while (remaining > 0) {
        if (buffer.length === 0 && !(await fill(1))) return;
        const step = Math.min(remaining, buffer.length);
        buffer = buffer.subarray(step);
        remaining -= step;
      }
    },
    cancel: () => reader.cancel(),
  };
};

export async function* entries(
  gzipped: ReadableStream<Uint8Array>,
  options: { readonly maxFileBytes: number; },
): AsyncGenerator<Entry> {
  const reader = byteReader(
    gzipped.pipeThrough(new DecompressionStream("gzip") as ReadableWritablePair<Uint8Array>),
  );
  let longPath: string | undefined;

  try {
    while (true) {
      const header = await reader.read(BLOCK);
      if (header === undefined || header.every((byte) => byte === 0)) return;

      const size = octal(header, 124, 12);
      const padded = Math.ceil(size / BLOCK) * BLOCK;
      const type = String.fromCharCode(header[156] ?? 0);

      // Metadata entries describe the entry that follows them.
      if (type === "x" || type === "L") {
        const body = await reader.read(padded);
        if (body === undefined) return;
        longPath = type === "x" ? paxPath(body.subarray(0, size)) : field(body, 0, size);
        continue;
      }

      const prefix = field(header, 345, 155);
      const name = field(header, 0, 100);
      const path = stripRoot(longPath ?? (prefix ? `${prefix}/${name}` : name));
      longPath = undefined;

      const isFile = type === "0" || type === "\0";
      if (!isFile || path === "" || size > options.maxFileBytes) {
        await reader.skip(padded);
        if (isFile && path !== "") yield { path, skipped: "too-large" };
        continue;
      }

      const body = await reader.read(padded);
      if (body === undefined) return;
      const text = toText(body.subarray(0, size));
      yield text === undefined ? { path, skipped: "binary" } : { path, text };
    }
  } finally {
    await reader.cancel();
  }
}
