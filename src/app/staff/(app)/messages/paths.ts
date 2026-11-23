/** Where staff fetch a message's file: the staff file route (src/app/staff/(app)/messages/files/[id]/route.ts). */
export const staffFileHref = (id: string): string => `/staff/messages/files/${id}`;
/** Where the form uploads a file: the staff upload route (src/app/staff/(app)/messages/files/route.ts). */
export const STAFF_UPLOAD_HREF = "/staff/messages/files";
/** The file's id in an address staffFileHref() made, or null for any other address. */
export const staffFileIdOf = (href: string): string | null => /^\/staff\/messages\/files\/([0-9a-f-]{36})$/.exec(href)?.[1] ?? null;
