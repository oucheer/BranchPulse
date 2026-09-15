import path from 'node:path'
import type http from 'node:http'
import { bootstrap } from './services'
import { createServer, type BranchPulseServer } from './http'
import { logger } from '../src-node/utils/logger'
import { appRoot, dataDir } from '../src-node/utils/paths'

const DEV = process.argv.includes('--dev') || process.env.BRANCHPULSE_DEV === '1'
const PORT = Number(process.env.BRANCHPULSE_PORT ?? 4173)
const HOST = process.env.BRANCHPULSE_HOST ?? '127.0.0.1'

type Middleware = (req: http.IncomingMessage, res: http.ServerResponse, next: (err?: unknown) => void) => void

async function main(): Promise<void> {
  let staticDir: string | undefined
  let rendererMiddleware: Middleware | undefined
  let viteServer: { close: () => Promise<void> } | null = null
  let server: BranchPulseServer | null = null

  if (DEV) {
    // Dev keeps a single origin: Vite runs in middleware mode so HMR and the
    // API/SSE endpoints share one port, exactly like the packaged build.
    const { createServer: createViteServer } = await import('vite')
    const vite = await createViteServer({
      root: appRoot(),
      server: { middlewareMode: true, hmr: { port: PORT + 1 } },
      appType: 'custom'
    })
    viteServer = vite
    rendererMiddleware = (req, res, next) => {
      vite.middlewares(req, res, next)
    }
  } else {
    staticDir = path.join(appRoot(), 'dist', 'renderer')
  }

  const runtime = await bootstrap({
    onProgress: (progress) => server?.broadcastProgress(progress)
  })

  server = createServer({
    api: runtime.api,
    ...(staticDir ? { staticDir } : {}),
    ...(rendererMiddleware ? { rendererMiddleware } : {})
  })

  const address = await server.listen(PORT, HOST)
  const url = `http://${address.host === '0.0.0.0' ? 'localhost' : address.host}:${address.port}`
  logger.info(`BranchPulse web UI available at ${url}`)
  logger.info(`Data directory: ${dataDir()}`)
  if (!DEV) logger.info(`Serving renderer assets from ${staticDir}`)

  const active = server
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down.`)
    await active.close()
    runtime.shutdown()
    if (viteServer) await viteServer.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

void main().catch((err) => {
  logger.error('BranchPulse web backend failed to start', err)
  process.exit(1)
})
