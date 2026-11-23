/**
 * The kinds of file a club message may carry (spec section 7), read from the file's bytes, never from its name or the
 * browser's word, and the size each may be. Pure, with no database import: the schema and the upload rules both read it.
 */
export const MESSAGE_FILE_TYPES = ["jpeg", "png", "gif", "webp", "pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt"] as const;
export type MessageFileType = (typeof MESSAGE_FILE_TYPES)[number];
/** At most this many bytes in one file of a message (10 MB); the schema's check holds the same number. */
export const MESSAGE_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** At most this many files in one version of a message, its pictures in the body included. */
export const MESSAGE_FILES_MAX = 10;

/** The pictures, which may sit in the body and are sent inline; every other type is sent as an attachment. */
export const PICTURE_TYPES: readonly MessageFileType[] = ["jpeg", "png", "gif", "webp"];
export const isPicture = (t: MessageFileType): boolean => PICTURE_TYPES.includes(t);

/** The MIME type a file route sends for each type: built from the stored type, never from anything staff typed. */
export const MESSAGE_FILE_MIME: Readonly<Record<MessageFileType, string>> = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
};

/** The fixed name a file route sends: `attachment.<ext>`, so nothing typed by staff reaches a header. */
export const fixedFileName = (t: MessageFileType): string => `attachment.${t === "jpeg" ? "jpg" : t}`;

/** A file's kind in words, for the list of files on a page. */
export const MESSAGE_FILE_WORDS: Readonly<Record<MessageFileType, string>> = {
  jpeg: "Picture", png: "Picture", gif: "Picture", webp: "Picture", pdf: "PDF",
  docx: "Word", doc: "Word", xlsx: "Excel", xls: "Excel", pptx: "PowerPoint", ppt: "PowerPoint",
};

/** A size in words: "820 KB", "2.4 MB". */
export function fileSizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
