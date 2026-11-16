/**
 * Runs in a worker before each unit test file (vitest.config.mts, setupFiles). Unit tests run beside the integration
 * tests and have no database: DATABASE_URL names an address nothing listens on, so a unit test that reaches for the
 * database fails at once instead of reading a table another worker's test is in the middle of filling.
 */

import { NO_DATABASE_URL } from "./database-url";

process.env.DATABASE_URL = NO_DATABASE_URL;
