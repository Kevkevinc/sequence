export function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Reads an optional setting, falling back to a built-in default.
 *
 * Unlike {@link getRequiredEnv} this never throws: the default is a working
 * value, so an unset variable is a valid configuration rather than a
 * misconfiguration. Used for things like model names, which have a sensible
 * default but need to be overridable without a code change — Gemini model
 * availability and quota differ per account and shift over time.
 */
export function getEnvWithDefault(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value : fallback;
}
