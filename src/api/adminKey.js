/**
 * src/api/adminKey.js
 *
 * Exports the master admin key used to create orgs and provision API keys.
 * The server refuses to start if STATEKEEP_ADMIN_KEY is not set.
 */

const ADMIN_KEY = process.env.STATEKEEP_ADMIN_KEY;

if (!ADMIN_KEY) {
  console.error(
    '[server] FATAL: STATEKEEP_ADMIN_KEY env var is required. ' +
    'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
  process.exit(1);
}

export { ADMIN_KEY };
