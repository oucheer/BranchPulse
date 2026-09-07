import { copyFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

function resolveWasmSource() {
  try {
    return require.resolve('sql.js/dist/sql-wasm.wasm')
  } catch {
    return join(root, 'node_modules/sql.js/dist/sql-wasm.wasm')
  }
}

const source = resolveWasmSource()
const target = join(root, 'out/main/sql-wasm.wasm')

if (!existsSync(source)) {
  throw new Error(`sql.js WASM source not found: ${source}`)
}

copyFileSync(source, target)
console.log(`[branchpulse] copied sql.js WASM: ${source} -> ${target}`)
