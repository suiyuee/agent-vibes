const BOOLEAN_KEYS = ["USE_HTTP2", "LOG_DEBUG", "ENFORCE_DOC_PROHIBITION"]

const INTEGER_KEYS: Record<string, { min: number; max?: number }> = {
  PORT: { min: 1, max: 65535 },
  CLOUD_CODE_DEFAULT_OUTPUT_TOKENS: { min: 256, max: 128_000 },
  CLOUD_CODE_MAX_OUTPUT_TOKENS: { min: 256, max: 128_000 },
  CLOUD_CODE_MIN_OUTPUT_TOKENS: { min: 1, max: 65_536 },
  MAX_PROMPT_SHRINK_RETRIES: { min: 0, max: 10 },
  CONVERSATION_SESSION_TTL_MS: { min: 60_000 },
  CONVERSATION_SESSION_MAX_SIZE: { min: 10, max: 100_000 },
}

function isBooleanLike(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return ["true", "false", "1", "0"].includes(normalized)
}

function isIntegerLike(value: string): boolean {
  return /^-?\d+$/.test(value.trim())
}

function toStringSafe(value: unknown): string | null {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value)
  }
  return null
}

/**
 * Basic environment validation to fail fast on invalid runtime config.
 */
export function validateEnv(
  rawEnv: Record<string, unknown>
): Record<string, unknown> {
  const env = { ...rawEnv }
  const errors: string[] = []

  if (!env.PORT) env.PORT = "2026"
  if (!env.USE_HTTP2) env.USE_HTTP2 = "true"

  // Codex env vars are optional strings; no validation needed beyond presence.
  // CODEX_API_KEY, CODEX_ACCESS_TOKEN, CODEX_BASE_URL, CODEX_PROXY_URL

  for (const key of BOOLEAN_KEYS) {
    const raw = env[key]
    if (raw === undefined || raw === null || raw === "") continue

    const value = toStringSafe(raw)
    if (value === null) {
      errors.push(`${key} must be one of: true, false, 1, 0`)
      continue
    }

    if (!isBooleanLike(value)) {
      errors.push(`${key} must be one of: true, false, 1, 0`)
    }
  }

  for (const [key, range] of Object.entries(INTEGER_KEYS)) {
    const raw = env[key]
    if (raw === undefined || raw === null || raw === "") continue

    const value = toStringSafe(raw)
    if (value === null) {
      errors.push(`${key} must be an integer`)
      continue
    }

    if (!isIntegerLike(value)) {
      errors.push(`${key} must be an integer`)
      continue
    }

    const numberValue = Number.parseInt(value, 10)
    if (numberValue < range.min) {
      errors.push(`${key} must be >= ${range.min}`)
      continue
    }
    if (range.max !== undefined && numberValue > range.max) {
      errors.push(`${key} must be <= ${range.max}`)
    }
  }

  if (errors.length > 0) {
    throw new Error(`Environment validation failed:\n- ${errors.join("\n- ")}`)
  }

  return env
}
