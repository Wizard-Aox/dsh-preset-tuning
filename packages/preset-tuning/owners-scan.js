/**
 * 静态扫描已安装的插件包，推导「工具名 → 归属组」映射。
 *
 * 为什么需要：DSH 的工具注册表只保存 `名字 → 定义`，不记录来源；生成的
 * api-catalog 也只覆盖 Service/Event。所以运行期拿不到"这个工具是哪个插件
 * 注册的"，只能在安装目录里静态分析。
 *
 * 这个模块同时被两处使用：
 *   - tools/gen-owners.mjs   命令行入口（离线生成）
 *   - tuning-registry.js     运行期，发现未归类工具时自动补扫
 *
 * 产出只是候选。消费方应与实时工具清单比对，不存在的名字自动失效，
 * 因此这里的匹配规则可以放宽以提高召回。
 *
 * @module owners-scan
 */
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * 推导扫描根目录。
 *
 * `argv1` 只有在真正指向 dsh 入口时才有用（运行期如此，跑独立脚本时不是），
 * 所以每个候选都要存在性检查；额外的显式目录优先，用于命令行指定安装位置。
 *
 * @param {string} [dshHome] - $DSH_HOME。
 * @param {string} [argv1] - 入口脚本路径（默认 process.argv[1]）。
 * @param {string[]} [explicit] - 显式指定的 node_modules 根。
 * @returns {string[]} 真实存在的目录。
 */
export function defaultRoots(dshHome, argv1 = process.argv[1], explicit = []) {
  const candidates = [...explicit]
  if (typeof argv1 === 'string' && argv1.length > 0) {
    // <install>/node_modules/@deepseek-ai/dsh/lib/bin.js
    const dshDir = dirname(dirname(argv1))
    candidates.push(join(dshDir, 'node_modules', '@deepseek-ai'))
    candidates.push(join(dshDir, '..'))
  }
  if (typeof dshHome === 'string' && dshHome.length > 0) {
    candidates.push(join(dshHome, 'profiles', 'web', 'node_modules'))
  }
  const seen = new Set()
  return candidates.filter((root) => {
    if (seen.has(root) || !existsSync(root)) return false
    seen.add(root)
    return true
  })
}

/**
 * 从包名推导归属组 id。
 * `@deepseek-ai/dsh-tool-fs` → `tool-fs`
 * `@deepseek-ai/dsh-experimental-tool-worktree` → `tool-worktree`
 * @param {string} packageName - 完整包名。
 * @returns {string} 组 id。
 */
export function groupIdOf(packageName) {
  const bare = packageName.includes('/') ? packageName.slice(packageName.indexOf('/') + 1) : packageName
  return bare.replace(/^dsh-/, '').replace(/^experimental-/, '')
}

/**
 * 从包名推导候选工具名（仅用于 `dsh-tool-<x>` 这类命名）。
 * @param {string} packageName - 完整包名。
 * @returns {string | undefined} 候选工具名。
 */
function toolNameFromPackage(packageName) {
  const bare = packageName.includes('/') ? packageName.slice(packageName.indexOf('/') + 1) : packageName
  const match = /^dsh-(?:experimental-)?tool-([a-z0-9-]+)$/.exec(bare)
  if (match === null) return undefined
  return match[1].replace(/-/g, '_')
}

/**
 * 递归列出目录下的 .js 文件。
 * @param {string} dir - 目录。
 * @param {string[]} out - 收集数组。
 * @returns {Promise<string[]>} 文件绝对路径。
 */
async function listJsFiles(dir, out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      await listJsFiles(full, out)
      continue
    }
    if (entry.name.endsWith('.js') && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

/**
 * 列出目录里的包（含 @scope 一级）。
 * @param {string} root - 扫描根。
 * @returns {Promise<string[]>} 包目录绝对路径。
 */
async function listPackages(root) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const packages = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || !entry.isDirectory()) continue
    if (entry.name.startsWith('@')) {
      let scoped
      try {
        scoped = await readdir(join(root, entry.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of scoped) {
        if (child.isDirectory()) packages.push(join(root, entry.name, child.name))
      }
      continue
    }
    packages.push(join(root, entry.name))
  }
  return packages
}

/**
 * 从一个源码文件里抓出工具名，累积到 names。
 * @param {string} source - 源码文本。
 * @param {Set<string>} names - 累积结果。
 */
function extractToolNames(source, names) {
  // ① register( 附近，且窗口里有 parameters
  const registerRe = /\.tools\.register\s*\(/g
  let match
  while ((match = registerRe.exec(source)) !== null) {
    const window = source.slice(match.index, match.index + 1200)
    if (!window.includes('parameters')) continue
    for (const found of window.matchAll(/name:\s*["']([a-z][a-zA-Z0-9_]*)["']/g)) names.add(found[1])
  }

  // ② 名字与注册分离的定义对象
  if (source.includes('.tools.register')) {
    for (const found of source.matchAll(/name:\s*["']([a-z][a-zA-Z0-9_]*)["'][\s\S]{0,400}?parameters\s*:/g)) {
      names.add(found[1])
    }
  }

  // ③ defineTool({ name: "..." })
  for (const found of source.matchAll(/defineTool\s*\(\s*\{[\s\S]{0,400}?name:\s*["']([a-z][a-zA-Z0-9_]*)["']/g)) {
    names.add(found[1])
  }

  const isToolFile = source.includes('.tools.register') || source.includes('defineTool')

  // ④ 常量形式：export const EXIT_PLAN_MODE = 'exit_plan_mode'
  if (isToolFile) {
    for (const found of source.matchAll(/const\s+[A-Z][A-Z0-9_]*\s*=\s*["']([a-z][a-z0-9_]{2,40})["']/g)) {
      names.add(found[1])
    }
  }

  // ⑤ 配置默认值：config.toolName ?? "subagent" / z.string().default("subagent")
  if (source.includes('.tools.register')) {
    for (const found of source.matchAll(/default\(\s*["']([a-z][a-z0-9_]{2,40})["']\s*\)/g)) names.add(found[1])
    for (const found of source.matchAll(/\?\?\s*["']([a-z][a-z0-9_]{2,40})["']/g)) names.add(found[1])
  }
}

/**
 * 扫一个包，返回它注册的工具名。
 * 工具定义不一定在入口文件里——例如 plugin_manager 在 lib/types/tools.js，
 * 所以必须扫整个 lib/。
 * @param {string} dir - 包目录。
 * @returns {Promise<{ name: string, tools: string[] } | undefined>} 结果。
 */
async function scanPackage(dir) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  if (typeof manifest.name !== 'string') return undefined

  const names = new Set()
  const files = await listJsFiles(join(dir, 'lib'))
  if (files.length === 0) {
    for (const candidate of ['index.js', 'client.js']) files.push(join(dir, candidate))
  }
  for (const file of files) {
    try {
      extractToolNames(await readFile(file, 'utf8'), names)
    } catch {
      // 读不了的文件忽略。
    }
  }
  return { name: manifest.name, tools: [...names] }
}

/**
 * 扫描全部根目录，产出「工具 → 组」映射。
 * @param {string[]} roots - 扫描根。
 * @returns {Promise<{ tools: Record<string, string>, packageCount: number }>} 结果。
 */
export async function scanOwners(roots) {
  const tools = {}
  const seen = new Set()
  const visitedRoots = new Set()
  let packageCount = 0

  // 广度优先：DSH 的依赖是嵌套安装的，包自己还带 node_modules/@deepseek-ai，
  // 那里才是绝大多数插件所在的位置，所以要顺着往下走。
  const queue = [...roots]
  while (queue.length > 0) {
    const root = queue.shift()
    if (visitedRoots.has(root)) continue
    visitedRoots.add(root)

    for (const dir of await listPackages(root)) {
      const pkg = await scanPackage(dir)
      if (pkg === undefined || seen.has(pkg.name)) continue
      seen.add(pkg.name)
      packageCount += 1

      const groupId = groupIdOf(pkg.name)
      for (const toolName of pkg.tools) tools[toolName] = groupId
      if (pkg.tools.length === 0) {
        const guess = toolNameFromPackage(pkg.name)
        if (guess !== undefined) tools[guess] = groupId
      }

      // 顺着嵌套依赖继续走
      queue.push(join(dir, 'node_modules', '@deepseek-ai'))
      queue.push(join(dir, 'node_modules'))
    }
  }

  return { tools, packageCount }
}
