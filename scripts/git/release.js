#!/usr/bin/env node

const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")
const { detectCursorVersion } = require("../lib/cursor-version")

const ROOT = path.resolve(__dirname, "..", "..")
const EXT_PKG = path.join(ROOT, "apps", "vscode-extension", "package.json")

function parseArgs(argv) {
  const parsed = {
    source: "dev",
    target: "main",
    remote: "origin",
    bump: "patch", // patch | minor | major | current
    cursorVersion: "",
    noTag: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") {
      parsed.help = true
      continue
    }
    if ((arg === "--source" || arg === "-s") && argv[i + 1]) {
      parsed.source = argv[++i]
      continue
    }
    if ((arg === "--target" || arg === "-t") && argv[i + 1]) {
      parsed.target = argv[++i]
      continue
    }
    if ((arg === "--remote" || arg === "-r") && argv[i + 1]) {
      parsed.remote = argv[++i]
      continue
    }
    if ((arg === "--cursor-version" || arg === "-c") && argv[i + 1]) {
      parsed.cursorVersion = argv[++i]
      continue
    }
    if (arg === "--patch") {
      parsed.bump = "patch"
      continue
    }
    if (arg === "--minor") {
      parsed.bump = "minor"
      continue
    }
    if (arg === "--major") {
      parsed.bump = "major"
      continue
    }
    if (arg === "--current") {
      parsed.bump = "current"
      continue
    }
    if (arg === "--no-tag") {
      parsed.noTag = true
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return parsed
}

function printHelp() {
  console.log(`Usage: npm run release [-- options]

Steps:
  1. Bump version in apps/vscode-extension/package.json
  2. Commit version bump on source branch and push
  3. Merge source into target and push
  4. Create and push version tag (triggers release CI)
  5. Switch back to source branch

Options:
  --patch     Bump patch version (default)  e.g. 0.1.0 → 0.1.1
  --minor     Bump minor version            e.g. 0.1.0 → 0.2.0
  --major     Bump major version            e.g. 0.1.0 → 1.0.0
  --current   Use current version as-is, no bump
  --no-tag    Merge only, skip version bump and tag
  --source    Source branch (default: dev)
  --target    Target branch (default: main)
  --remote    Git remote (default: origin)
  --cursor-version, -c
              Cursor compatibility version to publish in release metadata
              (default: auto-detect from installed Cursor)`)
}

function runGit(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    if (options.allowFailure) {
      return {
        ok: false,
        stdout: result.stdout || "",
        stderr: result.stderr || "",
      }
    }

    const detail =
      (result.stderr || result.stdout || "").trim() ||
      `git ${args.join(" ")} exited with code ${result.status}`
    throw new Error(detail)
  }

  return {
    ok: true,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  }
}

function gitOutput(args) {
  return runGit(args, { capture: true }).stdout.trim()
}

function runGh(args, options = {}) {
  const result = spawnSync("gh", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    if (options.allowFailure) {
      return {
        ok: false,
        stdout: result.stdout || "",
        stderr: result.stderr || "",
      }
    }

    const detail =
      (result.stderr || result.stdout || "").trim() ||
      `gh ${args.join(" ")} exited with code ${result.status}`
    throw new Error(detail)
  }

  return {
    ok: true,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  }
}

function currentBranch() {
  return gitOutput(["branch", "--show-current"])
}

function hasMergeInProgress() {
  return runGit(["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
    capture: true,
    allowFailure: true,
  }).ok
}

function ensureCleanWorktree() {
  const status = gitOutput(["status", "--porcelain"])
  if (status) {
    throw new Error(
      "Working tree is not clean. Commit or stash your changes before running merge:main."
    )
  }
}

function step(message) {
  console.log(`\n> ${message}`)
}

function runNode(scriptPath) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "inherit",
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${scriptPath} exited with code ${result.status}`)
  }
}

function syncReleaseDocs() {
  runNode(path.join("apps", "vscode-extension", "scripts", "sync-readme.mjs"))
}

function readExtensionPackage() {
  return JSON.parse(fs.readFileSync(EXT_PKG, "utf8"))
}

function writeExtensionPackage(pkg) {
  fs.writeFileSync(EXT_PKG, JSON.stringify(pkg, null, 2) + "\n")
}

function resolveReleaseCursorVersion(explicitVersion) {
  const resolved = (explicitVersion || "").trim() || detectCursorVersion()
  if (!resolved) {
    throw new Error(
      "Failed to determine Cursor version. Pass --cursor-version <x.y.z> when running npm run release."
    )
  }

  return resolved
}

function syncCursorReleaseMetadata(cursorVersion) {
  const pkg = readExtensionPackage()
  if (pkg.agentVibes?.cursorVersion === cursorVersion) {
    return false
  }

  pkg.agentVibes = {
    ...(pkg.agentVibes || {}),
    cursorVersion,
  }
  writeExtensionPackage(pkg)
  return true
}

function cleanupExistingRelease(tag, remote) {
  step(`Cleaning up existing release/tag ${tag}`)
  runGh(["release", "delete", tag, "--yes"], { allowFailure: true })
  runGit(["tag", "-d", tag], { allowFailure: true })
  runGit(["push", remote, `:refs/tags/${tag}`], { allowFailure: true })
}

/**
 * Bump version in apps/vscode-extension/package.json.
 * Returns { oldVersion, newVersion }.
 */
function bumpVersion(type) {
  const pkg = readExtensionPackage()
  const old = pkg.version
  if (!old) {
    throw new Error("No version field in apps/vscode-extension/package.json")
  }

  const parts = old.split(".").map(Number)
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid version format: ${old}`)
  }

  let [major, minor, patch] = parts
  if (type === "major") {
    major++
    minor = 0
    patch = 0
  } else if (type === "minor") {
    minor++
    patch = 0
  } else {
    patch++
  }

  const next = `${major}.${minor}.${patch}`
  pkg.version = next
  writeExtensionPackage(pkg)

  return { oldVersion: old, newVersion: next }
}

function switchBranch(branch, options = {}) {
  runGit(["switch", branch], options)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const { source, target, remote } = args
  const startingBranch = currentBranch()

  if (!startingBranch) {
    throw new Error("Failed to determine the current branch.")
  }

  ensureCleanWorktree()

  try {
    step(`Fetching ${remote}/${source} and ${remote}/${target}`)
    runGit(["fetch", remote, source, target])

    if (currentBranch() !== source) {
      step(`Switching to ${source}`)
      switchBranch(source)
    }

    step(`Updating ${source}`)
    runGit(["pull", "--ff-only", remote, source])

    // ── Bump version on source branch ────────────────────────────────
    let tag
    let cursorVersion
    if (!args.noTag) {
      cursorVersion = resolveReleaseCursorVersion(args.cursorVersion)
      if (args.bump === "current") {
        // Use current version as-is, no bump
        const pkg = readExtensionPackage()
        tag = `v${pkg.version}`
        step(`Using current version ${pkg.version}`)
      } else {
        step(`Bumping ${args.bump} version`)
        const { oldVersion, newVersion } = bumpVersion(args.bump)
        tag = `v${newVersion}`
        console.log(`  ${oldVersion} → ${newVersion}`)
      }

      step(`Syncing Cursor compatibility metadata (${cursorVersion})`)
      syncCursorReleaseMetadata(cursorVersion)

      step("Syncing release docs")
      syncReleaseDocs()

      const statusAfterSync = gitOutput(["status", "--porcelain"])
      if (statusAfterSync) {
        runGit(["add", EXT_PKG, "README.md", "README_zh.md"])
        runGit(
          ["commit", "-m", `chore: release ${tag} for cursor ${cursorVersion}`],
          {
            capture: true,
          }
        )
      }
    }

    step(`Pushing ${source}`)
    runGit(["push", remote, source])

    step(`Switching to ${target}`)
    switchBranch(target)

    step(`Updating ${target}`)
    runGit(["pull", "--ff-only", remote, target])

    step(`Merging ${source} into ${target}`)
    runGit(["merge", source, "--no-edit"])

    step(`Pushing ${target}`)
    runGit(["push", remote, target])

    // ── Tag and push ─────────────────────────────────────────────────
    if (!args.noTag && tag) {
      if (args.bump === "current") {
        cleanupExistingRelease(tag, remote)
      }

      step(`Creating tag ${tag}`)
      runGit([
        "tag",
        "-a",
        tag,
        "-m",
        `Release ${tag} (Cursor ${cursorVersion})`,
      ])

      step(`Pushing tag ${tag} (triggers release workflow)`)
      runGit(["push", remote, tag])

      console.log(`\n✅ Released ${tag} — workflow will start shortly.`)
    }

    console.log(`\nDone. Merged ${source} → ${target}.`)
  } catch (error) {
    if (hasMergeInProgress()) {
      step("Merge failed, aborting in-progress merge")
      runGit(["merge", "--abort"], { allowFailure: true })
    }
    throw error
  } finally {
    const branchAfterRun = currentBranch()
    if (branchAfterRun && branchAfterRun !== startingBranch) {
      step(`Switching back to ${startingBranch}`)
      switchBranch(startingBranch, { allowFailure: true })
    }
  }
}

try {
  main()
} catch (error) {
  console.error(
    `\nrelease failed: ${error instanceof Error ? error.message : String(error)}`
  )
  process.exit(1)
}
