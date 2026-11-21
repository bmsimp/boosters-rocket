/** Joins class names, dropping empty ones, so a primitive's class is exactly its parts ("btn btn-line"). */
export const cx = (...names: (string | false | null | undefined)[]): string => names.filter(Boolean).join(" ");
