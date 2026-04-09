const fs = require("node:fs")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const { cursorBinaryPath } = require("./platform")

function normalizeCursorVersion(rawValue) {
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

function readCursorVersionFromMacInfoPlist(binaryPath) {
  if (process.platform !== "darwin" || !binaryPath) {
    return null
  }

  const plistPath = path.join(path.dirname(binaryPath), "..", "Info.plist")
  if (!fs.existsSync(plistPath)) {
    return null
  }

  const plist = fs.readFileSync(plistPath, "utf8")
  const match = plist.match(
    /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/
  )

  return normalizeCursorVersion(match?.[1])
}

function readCursorVersionFromBinary(binaryPath) {
  if (!binaryPath) {
    return null
  }

  const result = spawnSync(binaryPath, ["--version"], {
    encoding: "utf8",
  })

  if (result.error || result.status !== 0) {
    return null
  }

  return normalizeCursorVersion(result.stdout)
}

function readCursorVersionFromResources(binaryPath) {
  if (!binaryPath) {
    return null
  }

  const candidates =
    process.platform === "darwin"
      ? [
          path.join(
            path.dirname(binaryPath),
            "..",
            "Resources",
            "app",
            "package.json"
          ),
        ]
      : [
          path.join(
            path.dirname(binaryPath),
            "resources",
            "app",
            "package.json"
          ),
          path.join(
            path.dirname(binaryPath),
            "..",
            "resources",
            "app",
            "package.json"
          ),
        ]

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue
    }

    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"))
      const version = normalizeCursorVersion(pkg.version)
      if (version) {
        return version
      }
    } catch {
      // Best-effort metadata detection.
    }
  }

  return null
}

function detectCursorVersion() {
  const binaryPath = cursorBinaryPath()

  return (
    readCursorVersionFromMacInfoPlist(binaryPath) ||
    readCursorVersionFromBinary(binaryPath) ||
    readCursorVersionFromResources(binaryPath) ||
    null
  )
}

module.exports = {
  detectCursorVersion,
}
