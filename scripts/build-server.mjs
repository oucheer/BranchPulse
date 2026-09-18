import { bundleServer, copySqlWasm, SERVER_OUTFILE } from './esbuild-server.mjs'

const outfile = await bundleServer()
copySqlWasm(outfile)
console.log(`Bundled GitManager web backend -> ${outfile}`)
console.log(`Backend output root: ${SERVER_OUTFILE}`)
