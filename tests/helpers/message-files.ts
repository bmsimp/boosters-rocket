/**
 * Small files of each kind a club message may carry, and of kinds it must refuse, built byte by byte so the type rules
 * (src/lib/messages/files.ts) are tested on the structures they read: a ZIP's central directory and an OLE compound
 * file's directory, as well as the magic numbers.
 */
const bytes = (...parts: (number[] | string | Uint8Array)[]): Uint8Array => {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === "string") for (const c of p) out.push(c.charCodeAt(0));
    else out.push(...p);
  }
  return new Uint8Array(out);
};
const pad = (b: Uint8Array, size: number) => { const out = new Uint8Array(size); out.set(b.subarray(0, size)); return out; };

export const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], "JFIF", [0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
export const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13], "IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
export const GIF = bytes("GIF89a", [1, 0, 1, 0, 0, 0, 0, 0x3b]);
export const WEBP = bytes("RIFF", [26, 0, 0, 0], "WEBPVP8 ", [0, 0, 0, 0]);
export const PDF = bytes("%PDF-1.7\n%âãÏÓ\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
export const EXE = bytes("MZ", [0x90, 0, 3, 0, 0, 0, 4, 0], "This program cannot be run in DOS mode.");
export const SVG = bytes('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
export const HTML = bytes("<!doctype html><html><body><script>alert(1)</script></body></html>");

const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

/** A ZIP of empty stored entries with these names, its central directory and end record as a ZIP tool writes them. */
export function zipOf(names: string[]): Uint8Array {
  const local: number[] = [], central: number[] = [];
  for (const name of names) {
    const offset = local.length;
    const n = [...new TextEncoder().encode(name)];
    local.push(...le32(0x04034b50), ...le16(20), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(0), ...le32(0), ...le16(n.length), ...le16(0), ...n);
    central.push(...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(0), ...le32(0),
      ...le16(n.length), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(offset), ...n);
  }
  const end = [...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(names.length), ...le16(names.length), ...le32(central.length), ...le32(local.length), ...le16(0)];
  return new Uint8Array([...local, ...central, ...end]);
}
export const DOCX = zipOf(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
export const XLSX = zipOf(["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml"]);
export const PPTX = zipOf(["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml"]);
/** A ZIP that is no Office file: a plain archive of a program. */
export const ZIP = zipOf(["setup.exe", "readme.txt"]);

/**
 * An OLE compound file (512-byte sectors: the header, one FAT sector, one directory sector) whose root holds these
 * streams, and, given `nested`, a storage holding those streams in turn (an embedded object's).
 */
export function oleOf(streams: string[], nested: string[] = []): Uint8Array {
  const NONE = 0xffffffff;
  const header = pad(bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 512);
  const set = (b: Uint8Array, at: number, v: number[]) => b.set(v, at);
  set(header, 0x18, le16(0x3e)); set(header, 0x1a, le16(3)); set(header, 0x1c, le16(0xfffe)); set(header, 0x1e, le16(9)); set(header, 0x20, le16(6));
  set(header, 0x2c, le32(1)); set(header, 0x30, le32(1)); set(header, 0x38, le32(4096)); set(header, 0x3c, le32(0xfffffffe)); set(header, 0x44, le32(0xfffffffe));
  set(header, 0x4c, le32(0));
  for (let i = 1; i < 109; i++) set(header, 0x4c + i * 4, le32(NONE));
  const fat = new Uint8Array(512).fill(0xff);
  set(fat, 0, le32(0xfffffffd)); set(fat, 4, le32(0xfffffffe));
  type E = { name: string; kind: number; left: number; right: number; child: number };
  const entries: E[] = [{ name: "Root Entry", kind: 5, left: NONE, right: NONE, child: NONE }];
  const chain = (names: string[], kind = 2) => {
    const ids = names.map((name) => { entries.push({ name, kind, left: NONE, right: NONE, child: NONE }); return entries.length - 1; });
    ids.forEach((id, i) => { if (i + 1 < ids.length) entries[id]!.right = ids[i + 1]!; });
    return ids[0] ?? NONE;
  };
  entries[0]!.child = chain(streams);
  if (nested.length) {
    const storage = chain(["ObjectPool"], 1);
    entries[storage]!.child = chain(nested);
    // The storage joins the root's children at the end of their chain.
    let last = entries[0]!.child;
    if (last === NONE) entries[0]!.child = storage;
    else { while (entries[last]!.right !== NONE) last = entries[last]!.right; entries[last]!.right = storage; }
  }
  if (entries.length > 4) throw new Error("oleOf holds at most four directory entries");
  const dir = new Uint8Array(512);
  entries.forEach((e, i) => {
    const at = i * 128;
    const name = [...e.name].flatMap((c) => le16(c.charCodeAt(0)));
    set(dir, at, name);
    set(dir, at + 0x40, le16(name.length + 2));
    dir[at + 0x42] = e.kind;
    set(dir, at + 0x44, le32(e.left)); set(dir, at + 0x48, le32(e.right)); set(dir, at + 0x4c, le32(e.child));
  });
  for (let i = entries.length; i < 4; i++) { set(dir, i * 128 + 0x44, le32(NONE)); set(dir, i * 128 + 0x48, le32(NONE)); set(dir, i * 128 + 0x4c, le32(NONE)); }
  const out = new Uint8Array(512 * 3);
  out.set(header, 0); out.set(fat, 512); out.set(dir, 1024);
  return out;
}
export const DOC = oleOf(["WordDocument", "1Table"]);
export const XLS = oleOf(["Workbook"]);
export const PPT = oleOf(["PowerPoint Document", "Current User"]);

/** A file of `size` bytes that starts as a PDF does. */
export const pdfOfSize = (size: number): Uint8Array => { const b = new Uint8Array(size); b.set(PDF.subarray(0, Math.min(PDF.length, size))); return b; };
