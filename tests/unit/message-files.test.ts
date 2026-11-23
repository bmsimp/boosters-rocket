import { describe, it, expect } from "vitest";
import { checkUpload, fileTypeOf, keptName } from "@/lib/messages/files";
import { fixedFileName, MESSAGE_FILE_MAX_BYTES, MESSAGE_FILE_MIME, MESSAGE_FILE_TYPES } from "@/lib/messages/file-types";
import { DOC, DOCX, EXE, GIF, HTML, JPEG, oleOf, PDF, pdfOfSize, PNG, PPT, PPTX, SVG, WEBP, XLS, XLSX, ZIP, zipOf } from "../helpers/message-files";

/** A message's files are known by their bytes alone (club messages, spec section 7). */
describe("the type of a message's file, read from its bytes", () => {
  it.each([
    ["jpeg", JPEG], ["png", PNG], ["gif", GIF], ["webp", WEBP], ["pdf", PDF],
    ["docx", DOCX], ["xlsx", XLSX], ["pptx", PPTX], ["doc", DOC], ["xls", XLS], ["ppt", PPT],
  ] as const)("knows a %s", (type, b) => {
    expect(fileTypeOf(b)).toBe(type);
    const r = checkUpload(`file.${type}`, b);
    expect(r).toEqual({ ok: true, type, name: `file.${type}` });
  });

  it("covers every type the schema allows, each with its MIME type and fixed name", () => {
    expect(MESSAGE_FILE_TYPES.length).toBe(11);
    for (const t of MESSAGE_FILE_TYPES) {
      expect(MESSAGE_FILE_MIME[t]).toMatch(/^(image|application)\//);
      expect(fixedFileName(t)).toMatch(/^attachment\.[a-z]{3,4}$/);
    }
    expect(fixedFileName("jpeg")).toBe("attachment.jpg");
  });

  it.each([
    ["a renamed program", "minutes.pdf", EXE],
    ["an SVG", "logo.svg", SVG],
    ["an SVG named as a picture", "logo.png", SVG],
    ["an HTML page named .pdf", "form.pdf", HTML],
    ["a plain ZIP named .docx", "letter.docx", ZIP],
    ["a ZIP with the Office part but no content types", "letter.docx", zipOf(["word/document.xml"])],
    ["an OLE file of no Office program", "old.doc", oleOf(["SummaryInformation"])],
    ["a cut-off OLE header", "old.xls", XLS.subarray(0, 100)],
    ["a cut-off ZIP", "new.xlsx", XLSX.subarray(0, XLSX.length - 10)],
    ["an empty file", "empty.pdf", new Uint8Array(0)],
  ])("refuses %s, by its bytes whatever its name", (_, name, b) => {
    const r = checkUpload(name, b);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(name);
  });

  it("reads only the streams at the top of an OLE file, not those of an object embedded in it", () => {
    expect(fileTypeOf(oleOf(["Workbook"], ["WordDocument"]))).toBe("xls");
    expect(fileTypeOf(oleOf(["WordDocument"], ["Workbook"]))).toBe("doc");
    expect(fileTypeOf(oleOf([], ["WordDocument"]))).toBeNull();
  });

  it("takes a file of exactly 10 MB and refuses one byte more, and an 11 MB file", () => {
    expect(checkUpload("big.pdf", pdfOfSize(MESSAGE_FILE_MAX_BYTES))).toMatchObject({ ok: true, type: "pdf" });
    expect(checkUpload("big.pdf", pdfOfSize(MESSAGE_FILE_MAX_BYTES + 1))).toEqual({ ok: false, error: "big.pdf is over 10 MB. Make it smaller, or share it another way." });
    expect(checkUpload("bigger.pdf", pdfOfSize(11 * 1024 * 1024)).ok).toBe(false);
  });

  it("keeps a name's last part, without control characters, at most 200 characters, never empty", () => {
    expect(keptName("C:\\Users\\coach\\Schedule.pdf")).toBe("Schedule.pdf");
    expect(keptName("../../etc/passwd")).toBe("passwd");
    expect(keptName("new\nline\u0000.pdf")).toBe("newline.pdf");
    expect(keptName("   ")).toBe("file");
    expect(keptName("a".repeat(300))).toHaveLength(200);
  });
});
