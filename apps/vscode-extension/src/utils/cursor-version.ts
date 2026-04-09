import * as fs from "fs"
import * as path from "path"

function normalizeCursorVersion(rawValue: unknown): string | null {
  const raw = String(rawValue || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)

  if (!raw) {
    return null
  }

  const match = raw.match(/(?:Version:\s*)?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i)
  return match?.[1] || raw
}

function readVersionFromPackageJson(packageJsonPath: string): string | null {
  if (!fs.existsSync(packageJsonPath)) {
    return null
  }

  try {
    const raw = fs.readFileSync(packageJsonPath, "utf8")
    const parsed = JSON.parse(raw) as { version?: unknown }
    return normalizeCursorVersion(parsed.version)
  } catch {
    return null
  }
}

function readVersionFromInfoPlist(infoPlistPath: string): string | null {
  if (!fs.existsSync(infoPlistPath)) {
    return null
  }

  try {
    const plist = fs.readFileSync(infoPlistPath, "utf8")
    const match = plist.match(
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/
    )
    return normalizeCursorVersion(match?.[1])
  } catch {
    return null
  }
}

export function detectCurrentCursorVersion(): string | null {
  const visited = new Set<string>()
  let current = path.dirname(process.execPath)

  for (let depth = 0; depth < 8; depth += 1) {
    const parent = path.dirname(current)
    const candidates = [
      path.join(current, "resources", "app", "package.json"),
      path.join(current, "Resources", "app", "package.json"),
      path.join(parent, "resources", "app", "package.json"),
      path.join(parent, "Resources", "app", "package.json"),
    ]

    for (const candidate of candidates) {
      if (visited.has(candidate)) {
        continue
      }
      visited.add(candidate)

      const version = readVersionFromPackageJson(candidate)
      if (version) {
        return version
      }
    }

    if (path.basename(current) === "Contents") {
      const version = readVersionFromInfoPlist(path.join(current, "Info.plist"))
      if (version) {
        return version
      }
    }

    if (parent === current) {
      break
    }
    current = parent
  }

  return null
}
