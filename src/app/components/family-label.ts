/**
 * How a staff page names a family by its QuickBooks customer when the roster cache has no name for that customer
 * (familyNames(), src/lib/parents/directory.ts): the Parents pages, which still list a person's guardian rows and the
 * held addresses' decisions by the family customers they hold. Staff pages about one family are addressed by the app's
 * family id since stage 3's third slice; this is a name, never an address. Never shown to a parent: their pages name a
 * family from the app's own record (src/lib/parents/my-family-names.ts), in words when the portal knows no name.
 */
export const familyLabel = (familyQboId: string) => `Family account ${familyQboId}`;
