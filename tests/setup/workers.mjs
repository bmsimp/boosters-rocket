/**
 * How many test files vitest runs at once. vitest.config.mts asks here, which is why this is a plain module it can
 * load as it stands. Each worker past the first has a database of its own (tests/setup/worker-databases.ts), so the
 * number is also how many databases a full run uses.
 */

/** The environment variable that sets the number of workers. 1 runs the files one at a time on the run's database, as the suite ran before it had workers. */
export const WORKERS_ENV = "BR_TEST_WORKERS";

/** No more than this many unless asked, however many cores there are: other runs share the machine and the database server. */
export const MOST_BY_DEFAULT = 6;
/** No more than this many when asked: a worker can hold ten database connections, and the server takes a hundred from everyone. */
export const MOST_WORKERS = 16;

/**
 * The number of workers: the variable when it is set, else half the machine's cores, at least 1 and at most 6. Half,
 * because each worker keeps a Postgres backend busy beside it, and because agents run their suites side by side.
 *
 * @param {string | undefined} value what BR_TEST_WORKERS holds
 * @param {number} cores how many cores the machine has
 * @returns {number}
 */
export function testWorkers(value, cores) {
  const asked = (value ?? "").trim();
  if (asked === "") return Math.max(1, Math.min(MOST_BY_DEFAULT, Math.floor(cores / 2)));
  if (!/^[1-9][0-9]?$/.test(asked) || Number(asked) > MOST_WORKERS) {
    throw new Error(`The tests refuse to run: ${WORKERS_ENV} must be a whole number from 1 to ${MOST_WORKERS} (it is "${asked}"). 1 runs the test files one at a time.`);
  }
  return Number(asked);
}
