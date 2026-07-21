/**
 * test/globalSetup.js
 *
 * Runs once before the test webServer starts.
 * Pre-seeds STATEKEEP_API_KEY into statekeep-test.db so Playwright's
 * isolated test server accepts the same key the user passes on the CLI.
 *
 * Also ensures the 'default' org exists and the seeded key belongs to it.
 */

// Open-source mode: auth is removed, no key seeding needed.
export default async function globalSetup() {}
