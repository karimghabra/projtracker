/**
 * Which build this is.
 *
 * Stamped in by the bundlers from package.json, so the number is written down
 * once. Under vitest and tsx nothing defines it, hence the fallback — a test
 * asserting on a version string would only be asserting on its own fixture.
 *
 * It exists for the backup: when somebody says "the update broke my data", the
 * first useful question is which version wrote the backup they still have.
 */

declare const __APP_VERSION__: string | undefined;

export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
