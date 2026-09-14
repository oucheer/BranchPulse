/**
 * Asar content check (round 6 verification helper).
 *
 * Confirms that the packaged archive really contains the fixes that were made
 * in the source tree: the localized tray labels, the `isQuitting` guard and the
 * unified Chinese terminology. Reading the archive beats trusting the build
 * timestamp, because it proves what actually shipped inside the exe.
 *
 * Usage:
 *   node scripts/asar-check.cjs [asar-path]
 */
const path = require('node:path')
const asar = require('@electron/asar')

const archive =
  process.argv[2] || path.join(__dirname, '..', 'release', 'win-unpacked', 'resources', 'app.asar')

const needles = [
  '打开仪表盘',
  '立即检查',
  '暂停监控',
  '恢复监控',
  '退出',
  'isQuitting',
  '对分支不合规处进行处理',
  '宽限期内',
  '分支创始人',
  '已停更的分支',
  'table-layout:fixed'
]

const forbidden = ['过期', '已合并', '到期', '陈旧']

const countOf = (haystack, needle) => haystack.split(needle).length - 1

const main = asar.extractFile(archive, path.join('out', 'main', 'index.js')).toString('utf8')

let failed = false
for (const needle of needles) {
  const count = countOf(main, needle)
  const ok = count > 0
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'}  main/index.js contains ${needle} -> ${count}`)
}
for (const needle of forbidden) {
  const count = countOf(main, needle)
  const ok = count === 0
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'}  main/index.js is free of ${needle} -> ${count}`)
}

// `renderers` also matches inside node_modules/three, so anchor the prefix.
const rendererEntries = asar
  .listPackage(archive)
  .filter((entry) => entry.startsWith('\\out\\renderer') && entry.endsWith('.js'))
if (rendererEntries.length === 0) throw new Error('renderer bundle not found in archive')
const renderer = rendererEntries
  .map((entry) => asar.extractFile(archive, entry.replace(/^\\/, '')).toString('utf8'))
  .join('\n')
for (const needle of ['仪表盘', '宽限期内', '命名不规范']) {
  const count = countOf(renderer, needle)
  const ok = count > 0
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'}  renderer bundle contains ${needle} -> ${count}`)
}

console.log(failed ? '\nASAR CHECK FAILED' : '\nASAR CHECK PASSED')
process.exit(failed ? 1 : 0)
