import { MESSAGE_FILE_MAX_BYTES, type MessageFileType } from "./file-types";

/**
 * What a file uploaded for a club message is, read from its bytes alone (spec section 7): the magic numbers of each
 * allowed type; for the Office formats, a ZIP whose central directory names the Office part, or the OLE compound file
 * header for the older ones, whose directory names the stream that says which program wrote it. Never the file's name
 * or the browser's word: a renamed program, an SVG or an HTML page named `.pdf` matches nothing and is refused. Pure.
 */
export function fileTypeOf(b: Uint8Array): MessageFileType | null {
  if (starts(b, [0xff, 0xd8, 0xff])) return "jpeg";
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsText(b, "GIF87a") || startsText(b, "GIF89a")) return "gif";
  if (startsText(b, "RIFF") && textAt(b, 8, "WEBP")) return "webp";
  if (startsText(b, "%PDF-")) return "pdf";
  if (starts(b, [0x50, 0x4b, 0x03, 0x04])) return officeZip(b);
  if (starts(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return officeOle(b);
  return null;
}

export type FileCheck = { ok: true; type: MessageFileType; name: string } | { ok: false; error: string };

/**
 * Whether an upload may be kept: at most MESSAGE_FILE_MAX_BYTES, of an allowed type by its bytes. The error names the
 * file in a plain sentence; `name` is the name kept, cut to 200 characters with any folder and control characters gone.
 */
export function checkUpload(rawName: string, bytes: Uint8Array): FileCheck {
  const name = keptName(rawName);
  if (bytes.byteLength > MESSAGE_FILE_MAX_BYTES) return { ok: false, error: `${name} is over 10 MB. Make it smaller, or share it another way.` };
  if (bytes.byteLength === 0) return { ok: false, error: `${name} is empty.` };
  const type = fileTypeOf(bytes);
  if (!type) return { ok: false, error: `${name} isn't a picture (JPEG, PNG, GIF or WebP), a PDF, or a Word, Excel or PowerPoint file, so it can't be added.` };
  return { ok: true, type, name };
}

/** The original name as it is kept: its last part only, no control characters, at most 200 characters, never empty. */
export function keptName(raw: string): string {
  const last = String(raw).split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  return [...(last || "file")].slice(0, 200).join("");
}

// --- the bytes -------------------------------------------------------------------------------------------------

const starts = (b: Uint8Array, sig: number[]) => b.length >= sig.length && sig.every((x, i) => b[i] === x);
const textAt = (b: Uint8Array, at: number, s: string) => b.length >= at + s.length && [...s].every((c, i) => b[at + i] === c.charCodeAt(0));
const startsText = (b: Uint8Array, s: string) => textAt(b, 0, s);
const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

/** The Office part each newer format's ZIP must name. */
const ZIP_PARTS: [string, MessageFileType][] = [["word/document.xml", "docx"], ["xl/workbook.xml", "xlsx"], ["ppt/presentation.xml", "pptx"]];

/** A ZIP's entry names from its central directory (found from the end record), or null when it can't be read. */
function zipNames(b: Uint8Array): string[] | null {
  const EOCD = 0x06054b50, CEN = 0x02014b50;
  // The end record is 22 bytes plus a comment of at most 65,535.
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) if (u32(b, i) === EOCD) { end = i; break; }
  if (end < 0) return null;
  const count = u16(b, end + 10), offset = u32(b, end + 16);
  if (count === 0xffff || offset === 0xffffffff) return null; // ZIP64: not an Office file under 10 MB
  const names: string[] = [];
  let at = offset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > b.length || u32(b, at) !== CEN) return null;
    const nameLen = u16(b, at + 28), extraLen = u16(b, at + 30), commentLen = u16(b, at + 32);
    if (at + 46 + nameLen > b.length) return null;
    names.push(new TextDecoder().decode(b.subarray(at + 46, at + 46 + nameLen)));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function officeZip(b: Uint8Array): MessageFileType | null {
  const names = zipNames(b);
  if (!names || !names.includes("[Content_Types].xml")) return null;
  return ZIP_PARTS.find(([part]) => names.includes(part))?.[1] ?? null;
}

/** The stream each older format's compound file must hold. */
const OLE_STREAMS: [string, MessageFileType][] = [["WordDocument", "doc"], ["Workbook", "xls"], ["Book", "xls"], ["PowerPoint Document", "ppt"]];

/**
 * The names of the streams at the top of an OLE compound file (the root storage's own children, not those of an object
 * embedded in it), read by its header, its FAT (through the DIFAT) and the directory's chain of sectors; null when the
 * structure can't be read. Every loop is bounded by the file's size.
 */
function oleStreams(b: Uint8Array): string[] | null {
  if (b.length < 512) return null;
  const shift = u16(b, 0x1e);
  if (shift !== 9 && shift !== 12) return null;
  const size = 1 << shift, per = size / 4;
  const sectors = Math.floor((b.length - size) / size);
  const sector = (n: number) => size + n * size;
  const END = 0xfffffffe, FREE = 0xffffffff, NONE = 0xffffffff;
  // The FAT's own sectors: 109 in the header, the rest in the DIFAT chain.
  const fatSectors: number[] = [];
  const fatCount = u32(b, 0x2c);
  if (fatCount > sectors) return null;
  for (let i = 0; i < 109 && fatSectors.length < fatCount; i++) fatSectors.push(u32(b, 0x4c + i * 4));
  let difat = u32(b, 0x44);
  for (let guard = 0; fatSectors.length < fatCount && difat !== END && difat !== FREE; guard++) {
    if (guard > sectors || difat >= sectors) return null;
    const at = sector(difat);
    for (let i = 0; i < per - 1 && fatSectors.length < fatCount; i++) fatSectors.push(u32(b, at + i * 4));
    difat = u32(b, at + (per - 1) * 4);
  }
  const next = (n: number): number | null => {
    const fs = fatSectors[Math.floor(n / per)];
    if (fs === undefined || fs >= sectors) return null;
    return u32(b, sector(fs) + (n % per) * 4);
  };
  type Entry = { name: string; kind: number; left: number; right: number; child: number };
  const entries: Entry[] = [];
  let dir = u32(b, 0x30);
  for (let guard = 0; dir !== END; guard++) {
    if (guard > sectors || dir >= sectors) return null;
    const at = sector(dir);
    for (let e = 0; e < size / 128; e++) {
      const entry = at + e * 128;
      const len = Math.min(u16(b, entry + 0x40), 64);
      let name = "";
      for (let i = 0; i < len - 2; i += 2) name +=String.fromCharCode(u16(b, entry + i));
      entries.push({ name, kind: b[entry + 0x42]!, left: u32(b, entry + 0x44), right: u32(b, entry + 0x48), child: u32(b, entry + 0x4c) });
    }
    const n = next(dir);
    if (n === null) return null;
    dir = n;
  }
  if (entries[0]?.kind !== 5) return null; // 5: the root storage
  // The root's children are a tree joined by their left and right siblings.
  const names: string[] = [];
  const seen = new Set<number>();
  const todo = [entries[0].child];
  while (todo.length) {
    const id = todo.pop()!;
    if (id === NONE || seen.has(id) || !entries[id]) continue;
    seen.add(id);
    const e = entries[id];
    if (e.kind === 2) names.push(e.name); // 2: a stream
    todo.push(e.left, e.right);
  }
  return names;
}

function officeOle(b: Uint8Array): MessageFileType | null {
  const names = oleStreams(b);
  if (!names) return null;
  return OLE_STREAMS.find(([stream]) => names.includes(stream))?.[1] ?? null;
}
