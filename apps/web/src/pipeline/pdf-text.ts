const PDF_HEADER = "%PDF-";
const MAX_DECOMPRESSED_STREAM_BYTES = 20_000_000;

interface PdfObject {
  body: string;
  stream: Uint8Array | null;
}

interface PdfToken {
  kind: "array-end" | "array-start" | "hex" | "literal" | "name" | "word";
  bytes?: Uint8Array;
  value?: string;
}

/**
 * Extract text from ordinary, text-based PDFs without shipping a large PDF
 * runtime in the judge bundle. Flate-compressed content streams and embedded
 * ToUnicode maps are supported; scanned/image-only PDFs deliberately fail with
 * an actionable message because OCR would invent a very different dependency.
 */
export async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  const raw = new TextDecoder("latin1").decode(bytes);
  if (!raw.startsWith(PDF_HEADER)) {
    throw new Error("This file does not appear to be a valid PDF.");
  }
  if (/\/Encrypt\b/.test(raw)) {
    throw new Error("Password-protected PDFs are not supported. Upload an unlocked copy.");
  }

  const objects = await readObjects(raw, bytes);
  const unicodeByObject = new Map<string, Map<string, string>>();
  for (const [id, object] of objects) {
    if (!object.stream) continue;
    const streamText = new TextDecoder("latin1").decode(object.stream);
    if (streamText.includes("begincmap")) {
      unicodeByObject.set(id, parseCmap(streamText));
    }
  }

  const cmapByFontObject = new Map<string, Map<string, string>>();
  for (const [id, object] of objects) {
    const match = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(object.body);
    const cmap = match?.[1] ? unicodeByObject.get(match[1]) : undefined;
    if (cmap) cmapByFontObject.set(id, cmap);
  }

  const cmapByAlias = new Map<string, Map<string, string>>();
  for (const object of objects.values()) {
    for (const match of object.body.matchAll(/\/(\w+)\s+(\d+)\s+\d+\s+R/g)) {
      const alias = match[1];
      const fontObject = match[2];
      const cmap = fontObject ? cmapByFontObject.get(fontObject) : undefined;
      if (alias && cmap) cmapByAlias.set(alias, cmap);
    }
  }

  const blocks: string[] = [];
  for (const object of objects.values()) {
    if (!object.stream) continue;
    const streamText = new TextDecoder("latin1").decode(object.stream);
    for (const match of streamText.matchAll(/BT([\s\S]*?)ET/g)) {
      const text = extractTextBlock(match[1] ?? "", cmapByAlias);
      if (text) blocks.push(text);
    }
  }

  const result = blocks
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (result.length < 8) {
    throw new Error(
      "No readable text was found. This may be a scanned PDF; run OCR on it before uploading.",
    );
  }
  return result;
}

async function readObjects(raw: string, bytes: Uint8Array): Promise<Map<string, PdfObject>> {
  const objects = new Map<string, PdfObject>();
  const objectPattern = /(\d+)\s+\d+\s+obj\b/g;
  const matches = [...raw.matchAll(objectPattern)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const id = match?.[1];
    const start = match?.index;
    if (!id || start === undefined) continue;
    const bodyStart = start + match[0].length;
    const nextStart = matches[index + 1]?.index ?? raw.length;
    const endObject = raw.lastIndexOf("endobj", nextStart);
    const bodyEnd = endObject >= bodyStart ? endObject : nextStart;
    const body = raw.slice(bodyStart, bodyEnd);
    objects.set(id, { body, stream: await decodeStream(body, bodyStart, bytes) });
  }
  return objects;
}

async function decodeStream(
  body: string,
  bodyOffset: number,
  allBytes: Uint8Array,
): Promise<Uint8Array | null> {
  const marker = /stream\r?\n/.exec(body);
  if (!marker?.index) return null;
  const streamStart = bodyOffset + marker.index + marker[0].length;
  const streamEndRelative = body.lastIndexOf("endstream");
  if (streamEndRelative < marker.index) return null;
  let streamEnd = bodyOffset + streamEndRelative;
  while (streamEnd > streamStart && (allBytes[streamEnd - 1] === 10 || allBytes[streamEnd - 1] === 13)) {
    streamEnd -= 1;
  }
  let stream = allBytes.slice(streamStart, streamEnd);
  const dictionary = body.slice(0, marker.index);
  if (/\/ASCII85Decode/.test(dictionary)) stream = decodeAscii85(stream);
  if (!/\/FlateDecode/.test(dictionary)) return stream;
  try {
    const decompressed = new Blob([stream]).stream().pipeThrough(new DecompressionStream("deflate"));
    return await readLimitedStream(decompressed);
  } catch {
    return null;
  }
}

async function readLimitedStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DECOMPRESSED_STREAM_BYTES) {
      await reader.cancel();
      throw new Error("PDF content stream exceeds the safe extraction limit.");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function decodeAscii85(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const input = new TextDecoder("ascii")
    .decode(bytes)
    .replace(/\s/g, "")
    .replace(/^<~/, "")
    .replace(/~>$/, "");
  const output: number[] = [];
  let group: number[] = [];
  const flush = (partial: boolean) => {
    const originalLength = group.length;
    while (group.length < 5) group.push(84);
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    const decoded = [
      Math.floor(value / 16_777_216) & 0xff,
      Math.floor(value / 65_536) & 0xff,
      Math.floor(value / 256) & 0xff,
      value & 0xff,
    ];
    output.push(...decoded.slice(0, partial ? Math.max(0, originalLength - 1) : 4));
    group = [];
  };
  for (const character of input) {
    if (character === "z" && group.length === 0) {
      output.push(0, 0, 0, 0);
      continue;
    }
    const value = character.charCodeAt(0) - 33;
    if (value < 0 || value > 84) continue;
    group.push(value);
    if (group.length === 5) flush(false);
  }
  if (group.length > 1) flush(true);
  return Uint8Array.from(output);
}

function parseCmap(raw: string): Map<string, string> {
  const cmap = new Map<string, string>();
  for (const match of raw.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
    const source = match[1];
    const target = match[2];
    if (source && target) cmap.set(source.toUpperCase(), decodeUnicodeHex(target));
  }
  for (const match of raw.matchAll(
    /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g,
  )) {
    const startHex = match[1];
    const endHex = match[2];
    const targetHex = match[3];
    if (!startHex || !endHex || !targetHex) continue;
    const start = Number.parseInt(startHex, 16);
    const end = Number.parseInt(endHex, 16);
    const target = Number.parseInt(targetHex, 16);
    if (end - start > 512) continue;
    for (let value = start; value <= end; value += 1) {
      const source = value.toString(16).padStart(startHex.length, "0").toUpperCase();
      const unicode = (target + value - start).toString(16).padStart(targetHex.length, "0");
      cmap.set(source, decodeUnicodeHex(unicode));
    }
  }
  return cmap;
}

function decodeUnicodeHex(hex: string): string {
  const values: number[] = [];
  for (let index = 0; index + 3 < hex.length; index += 4) {
    values.push(Number.parseInt(hex.slice(index, index + 4), 16));
  }
  return String.fromCharCode(...values).replace(/^\uFEFF/, "");
}

function extractTextBlock(
  block: string,
  cmapByAlias: Map<string, Map<string, string>>,
): string {
  const tokens = tokenize(block);
  const operands: PdfToken[] = [];
  const fragments: string[] = [];
  let font = "";

  for (const token of tokens) {
    if (token.kind !== "word") {
      operands.push(token);
      continue;
    }
    const operator = token.value;
    if (operator === "Tf") {
      const name = [...operands].reverse().find((item) => item.kind === "name");
      font = name?.value ?? font;
    } else if (operator === "Tj" || operator === "'" || operator === '"') {
      const value = [...operands].reverse().find(
        (item) => item.kind === "literal" || item.kind === "hex",
      );
      if (value?.bytes) fragments.push(decodeText(value.bytes, cmapByAlias.get(font)));
      if (operator !== "Tj") fragments.push("\n");
    } else if (operator === "TJ") {
      for (const value of operands) {
        if ((value.kind === "literal" || value.kind === "hex") && value.bytes) {
          fragments.push(decodeText(value.bytes, cmapByAlias.get(font)));
        }
      }
    } else if (operator === "T*" || operator === "Td" || operator === "TD") {
      fragments.push("\n");
    }
    operands.length = 0;
  }
  return fragments.join("").replace(/\s*\n\s*/g, "\n").trim();
}

function decodeText(bytes: Uint8Array, cmap?: Map<string, string>): string {
  if (!cmap?.size) return new TextDecoder("windows-1252").decode(bytes);
  const lengths = [...new Set([...cmap.keys()].map((key) => key.length / 2))].sort((a, b) => b - a);
  let output = "";
  for (let index = 0; index < bytes.length;) {
    let matched = false;
    for (const length of lengths) {
      if (index + length > bytes.length) continue;
      const key = [...bytes.slice(index, index + length)]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();
      const value = cmap.get(key);
      if (value !== undefined) {
        output += value;
        index += length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      output += String.fromCharCode(bytes[index] ?? 32);
      index += 1;
    }
  }
  return output;
}

function tokenize(input: string): PdfToken[] {
  const tokens: PdfToken[] = [];
  let index = 0;
  while (index < input.length) {
    const character = input[index];
    if (!character) break;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "%") {
      index = input.indexOf("\n", index);
      if (index < 0) break;
      continue;
    }
    if (character === "[") {
      tokens.push({ kind: "array-start" });
      index += 1;
      continue;
    }
    if (character === "]") {
      tokens.push({ kind: "array-end" });
      index += 1;
      continue;
    }
    if (character === "/") {
      const end = readUntilDelimiter(input, index + 1);
      tokens.push({ kind: "name", value: input.slice(index + 1, end) });
      index = end;
      continue;
    }
    if (character === "(") {
      const parsed = readLiteral(input, index + 1);
      tokens.push({ kind: "literal", bytes: parsed.bytes });
      index = parsed.end;
      continue;
    }
    if (character === "<" && input[index + 1] !== "<") {
      const end = input.indexOf(">", index + 1);
      if (end < 0) break;
      const hex = input.slice(index + 1, end).replace(/\s/g, "");
      tokens.push({ kind: "hex", bytes: hexToBytes(hex) });
      index = end + 1;
      continue;
    }
    const end = readUntilDelimiter(input, index);
    tokens.push({ kind: "word", value: input.slice(index, end) });
    index = end === index ? index + 1 : end;
  }
  return tokens;
}

function readUntilDelimiter(input: string, start: number): number {
  let index = start;
  while (index < input.length && !/[\s()[\]<>/%]/.test(input[index] ?? "")) index += 1;
  return index;
}

function readLiteral(input: string, start: number): { bytes: Uint8Array; end: number } {
  const bytes: number[] = [];
  let depth = 1;
  let index = start;
  while (index < input.length && depth > 0) {
    const character = input[index] ?? "";
    if (character === "\\") {
      const next = input[index + 1] ?? "";
      if (/[0-7]/.test(next)) {
        const octal = input.slice(index + 1).match(/^[0-7]{1,3}/)?.[0] ?? "";
        bytes.push(Number.parseInt(octal, 8));
        index += octal.length + 1;
        continue;
      }
      const escaped: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
      if (next === "\n" || next === "\r") {
        index += next === "\r" && input[index + 2] === "\n" ? 3 : 2;
        continue;
      }
      bytes.push(escaped[next] ?? next.charCodeAt(0));
      index += 2;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        index += 1;
        break;
      }
    }
    bytes.push(character.charCodeAt(0) & 0xff);
    index += 1;
  }
  return { bytes: new Uint8Array(bytes), end: index };
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.length % 2 === 0 ? hex : hex + "0";
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return bytes;
}
