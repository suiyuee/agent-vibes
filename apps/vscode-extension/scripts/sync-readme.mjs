import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const extensionRoot = path.resolve(__dirname, "..")
const repoRoot = path.resolve(extensionRoot, "..", "..")
const extensionPkgPath = path.join(extensionRoot, "package.json")
const readmeEnPath = path.join(repoRoot, "README.md")
const readmeZhPath = path.join(repoRoot, "README_zh.md")
const extensionReadmePath = path.join(extensionRoot, "README.md")

const extensionPkg = JSON.parse(fs.readFileSync(extensionPkgPath, "utf8"))
const version = extensionPkg.version
const cursorVersion = extensionPkg.agentVibes?.cursorVersion
const tag = `v${version}`
const releaseBase = `https://github.com/funny-vibes/agent-vibes/releases/download/${tag}`

if (!version) {
  throw new Error(`Version not found in ${extensionPkgPath}`)
}

if (!cursorVersion) {
  throw new Error(`Cursor version not found in ${extensionPkgPath}`)
}

const installBlocks = {
  darwinArm64: `#### macOS Apple Silicon\n\n\`\`\`bash\n# Download\ncurl -L -o agent-vibes-darwin-arm64-${version}.vsix ${releaseBase}/agent-vibes-darwin-arm64-${version}.vsix\n\n# Install\ncursor --install-extension agent-vibes-darwin-arm64-${version}.vsix --force\n\`\`\``,
  darwinX64: `#### macOS Intel\n\n\`\`\`bash\n# Download\ncurl -L -o agent-vibes-darwin-x64-${version}.vsix ${releaseBase}/agent-vibes-darwin-x64-${version}.vsix\n\n# Install\ncursor --install-extension agent-vibes-darwin-x64-${version}.vsix --force\n\`\`\``,
  linuxX64: `#### Linux x64\n\n\`\`\`bash\n# Download\ncurl -L -o agent-vibes-linux-x64-${version}.vsix ${releaseBase}/agent-vibes-linux-x64-${version}.vsix\n\n# Install\ncursor --install-extension agent-vibes-linux-x64-${version}.vsix --force\n\`\`\``,
  win32X64: `#### Windows x64\n\n\`\`\`powershell\n# Download\nInvoke-WebRequest -Uri "${releaseBase}/agent-vibes-win32-x64-${version}.vsix" -OutFile "agent-vibes-win32-x64-${version}.vsix"\n\n# Install\ncursor --install-extension agent-vibes-win32-x64-${version}.vsix --force\n\`\`\``,
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function replacePlatformBlock(content, platform, block) {
  const pattern = new RegExp(
    "#### " +
      escapeRegex(platform) +
      "\\n\\n```(?:bash|powershell)\\n[\\s\\S]*?\\n```",
    "g"
  )
  return content.replace(pattern, block)
}

function replaceCompatibilityLine(content, anchor, line, existingPattern) {
  let next = content
  next = next.replace(existingPattern, "")

  return next.replace(anchor, `${anchor}\n${line}`)
}

function collapseDuplicateCommands(content, version) {
  const unixTargets = [
    `agent-vibes-darwin-arm64-${version}.vsix`,
    `agent-vibes-darwin-x64-${version}.vsix`,
    `agent-vibes-linux-x64-${version}.vsix`,
  ]

  for (const filename of unixTargets) {
    const pair = [
      `curl -L -o ${filename} ${releaseBase}/${filename}`,
      `cursor --install-extension ${filename} --force`,
    ].join("\\n")
    const pairPattern = new RegExp(`(?:${escapeRegex(pair)}\\n?){2,}`, "g")
    content = content.replace(pairPattern, `${pair}\\n`)
  }

  const winPair = [
    `Invoke-WebRequest -Uri \"${releaseBase}/agent-vibes-win32-x64-${version}.vsix\" -OutFile \"agent-vibes-win32-x64-${version}.vsix\"`,
    `cursor --install-extension agent-vibes-win32-x64-${version}.vsix --force`,
  ].join("\\n")
  const winPairPattern = new RegExp(`(?:${escapeRegex(winPair)}\\n?){2,}`, "g")
  return content.replace(winPairPattern, `${winPair}\\n`)
}

function updateReadme(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`README not found: ${filePath}`)
  }

  let content = fs.readFileSync(filePath, "utf8")
  content = collapseDuplicateCommands(content, version)
  content = replaceCompatibilityLine(
    content,
    "One-click download + install from [GitHub Releases](https://github.com/funny-vibes/agent-vibes/releases):",
    `Compatible Cursor version: \`${cursorVersion}\`.`,
    /Compatible Cursor version: `[^`]+`\.\n/g
  )
  content = replaceCompatibilityLine(
    content,
    "从 [GitHub Releases](https://github.com/funny-vibes/agent-vibes/releases) 一键下载并安装：",
    `兼容 Cursor 版本：\`${cursorVersion}\`。`,
    /兼容 Cursor 版本：`[^`]+`。\n/g
  )
  content = replacePlatformBlock(
    content,
    "macOS Apple Silicon",
    installBlocks.darwinArm64
  )
  content = replacePlatformBlock(
    content,
    "macOS Intel",
    installBlocks.darwinX64
  )
  content = replacePlatformBlock(content, "Linux x64", installBlocks.linuxX64)
  content = replacePlatformBlock(content, "Windows x64", installBlocks.win32X64)
  fs.writeFileSync(filePath, content)
}

updateReadme(readmeEnPath)
updateReadme(readmeZhPath)
fs.copyFileSync(readmeEnPath, extensionReadmePath)

console.log(`Updated install commands to ${tag} in README.md and README_zh.md`)
console.log(`Pinned release compatibility to Cursor ${cursorVersion}`)
console.log(
  `Synced README.md → ${path.relative(repoRoot, extensionReadmePath)}`
)
