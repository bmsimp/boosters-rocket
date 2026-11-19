/**
 * How a staff page names a family the roster cache has no name for (familyNames(), src/lib/parents/directory.ts), while
 * staff pages are still addressed by QuickBooks id. Never shown to a parent: their pages name a family from the app's
 * own record (src/lib/parents/my-family-names.ts), in words when the portal knows no name.
 */
export const familyLabel = (familyQboId: string) => `Family account ${familyQboId}`;
