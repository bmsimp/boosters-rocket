/** True for a UUID, the form of the portal's own ids. Anything else would reach Postgres as a bad cast and throw, so it is refused first. */
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
