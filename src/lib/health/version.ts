/**
 * The version this copy of the portal was built as, shown on the Health page as text. next.config.ts sets
 * BR_BUILD_VERSION while the portal is built (the package version and the commit), so it is fixed in the build and
 * can't drift from the code that is running. A copy that was never built (`next dev`, the tests) has none.
 */
export const BUILD_VERSION: string = process.env.BR_BUILD_VERSION || "a development copy that was never built";
