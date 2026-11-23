/**
 * The kinds of file a club message may carry (spec section 7), read from the file's bytes, never from its name or the
 * browser's word, and the size each may be. Pure, with no database import: the schema and the upload rules both read it.
 */
export const MESSAGE_FILE_TYPES = ["jpeg", "png", "gif", "webp", "pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt"] as const;
export type MessageFileType = (typeof MESSAGE_FILE_TYPES)[number];
/** At most this many bytes in one file of a message (10 MB); the schema's check holds the same number. */
export const MESSAGE_FILE_MAX_BYTES = 10 * 1024 * 1024;
