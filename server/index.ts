import path from 'node:path'
import type http from 'node:http'
import { bootstrap } from './services'
import { createServer, type GitManagerServer } from './http'
import { logger } from '../src-node/utils/logger'
import { appRoot, dataDir } from '../src-node/utils/paths'

const DEV = process.argv.includes('--dev') || process.env.GITMANAGER_DEV === '1'
const PORT = Number(process.env.GITMANAGER_PORT ?? 4173)
const HOST = process.env.GITMANAGER_HOST ?? '127.0.0.1'

type Middleware = (req: http.IncomingMessage, res: http.ServerResponse, next: (err?: unknown) => void) => void

async function main(): Promise<void> {
  let staticDir: string | undefined
  let rendererMiddleware: Middleware | undefined
  let viteServer: { close: () => Promise<void> } | null = null
  // Assigned before `bootstrap` so the progress callback always has a target,
  // even for a scan triggered while the socket is still binding.
  const serverRef: { current: GitManagerServer | null } = { current: null }

  if (DEV) {
    // Dev keeps a single origin: Vite runs in middleware mode so HMR and the
    // API/SSE endpoints share one port, exactly like the packaged build.
    //
    // `appType: 'spa'` is required, not cosmetic: with `custom` Vite installs
    // neither the HTML fallback nor the index-HTML middleware, so `GET /` would
    // fall through to the 404 handler and the page would never load. The `spa`
    // type makes Vite serve and transform `index.html` (injecting the HMR
    // client) for every non-API navigation, mirroring `handleStatic` below.
    const { createServer: createViteServer } = await import('vite')
    const vite = await createViteServer({
      root: appRoot(),
      server: { middlewareMode: true, hmr: { port: PORT + 1 } },
      appType: 'spa'
    })
    viteServer = vite
    rendererMiddleware = (req, res, next) => {
      vite.middlewares(req, res, next)
    }
  } else {
    staticDir = path.join(appRoot(), 'dist', 'renderer')
  }

  const runtime = await bootstrap({
    onProgress: (progress) => serverRef.current?.broadcastProgress(progress)
  })

  const server = createServer({
    api: runtime.api,
    ...(staticDir ? { staticDir } : {}),
    ...(rendererMiddleware ? { rendererMiddleware } : {})
  })
  serverRef.current = server

  const address = await server.listen(PORT, HOST)
  logger.info(`GitManager web UI listening on http://${address.host}:${address.port}`)
  if (address.host === '0.0.0.0' || address.host === '::') {
    // Logging `0.0.0.0` alone reads like a placeholder; say what it means and
    // what to open locally, otherwise a correct bind looks like a broken URL.
    logger.info(`Reachable from other machines at http://<this-host>:${address.port} (open http://localhost:${address.port} locally)`)
  } else {
    // The default is loopback-only, which is the usual reason a browser on
    // another machine cannot connect: name the fix instead of leaving the user
    // to guess.
    logger.info('Listening on loopback only; set GITMANAGER_HOST=0.0.0.0 to serve other machines.')
  }
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
  logger.error('GitManager web backend failed to start', err)
  process.exit(1)
})
