#!/usr/bin/env node
/**
 * 命令行入口：扫描已安装的插件包，生成「工具名 → 归属组」映射表。
 *
 * 扫描逻辑在 `packages/preset-tuning/owners-scan.js`，运行期由 registry 复用
 * （发现未归类工具时会自动补扫）。这个脚本只是手动的离线入口。
 *
 * 用法：
 *   node tools/gen-owners.mjs [<node_modules 根>]
 *
 * 产出：$DSH_HOME/preset-tuning/owners.generated.json
 */
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DSH_HOME =
  typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
const DATA_DIR = join(DSH_HOME, 'preset-tuning')
const OUT = join(DATA_DIR, 'owners.generated.json')

const here = import.meta.dirname
const scanModule = await import(pathToFileURL(join(here, '..', 'packages', 'preset-tuning', 'owners-scan.js')).href)

// 命令行跑的时候 argv[1] 是脚本自己，指不到 dsh 安装位置。
// 所以优先用显式参数，其次沿用上次生成文件里记录的根，最后才回落到推导结果。
const explicit = []
if (typeof process.argv[2] === 'string') explicit.push(process.argv[2])
if (typeof process.env.DSH_INSTALL_ROOT === 'string') explicit.push(process.env.DSH_INSTALL_ROOT)
try {
  const previous = JSON.parse(await readFile(OUT, 'utf8'))
  if (Array.isArray(previous.roots)) explicit.push(...previous.roots)
} catch {
  // 还没有生成过，忽略。
}

const roots = scanModule.defaultRoots(DSH_HOME, process.argv[1], explicit)
if (roots.length === 0) {
  console.error('找不到可扫描的插件目录。请显式传入：node tools/gen-owners.mjs <node_modules 根>')
  process.exit(1)
}

const { tools, packageCount } = await scanModule.scanOwners(roots)
const sorted = Object.fromEntries(Object.entries(tools).sort(([a], [b]) => a.localeCompare(b)))

await writeFile(
  OUT,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      note: '由 tools/gen-owners.mjs 或 registry 的自动补扫生成，不要手改。',
      roots,
      toolCount: Object.keys(sorted).length,
      packageCount,
      tools: sorted,
    },
    null,
    2,
  )}\n`,
  'utf8',
)

console.log(`扫描 ${packageCount} 个包，识别 ${Object.keys(sorted).length} 个工具`)
console.log(`已写入 ${OUT}`)
