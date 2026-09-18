import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { URL } from 'node:url'
import type { ScanProgress } from '@shared/types'
import type { GitManagerApi } from '../src-node/api'
import { readReportFile, listFoldersForWeb } from '../src-node/api'
import { logger } from '../src-node/utils/logger'
import { dataDir, reportsDir, userDataDir } from '../src-node/utils/paths'
import { invoke } from './rpc'

const MAX_BODY_BYTES = 32 * 1024 * 1024

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8'
}

export interface ServerOptions {
  api: GitManagerApi
  /** Static asset directory. Omitted in dev, where Vite serves the renderer. */
  staticDir?: string
  /** Vite middleware used in dev so the renderer and API share one origin. */
  rendererMiddleware?: (req: http.IncomingMessage, res: http.ServerResponse, next: (err?: unknown) => void) => void
}

export interface GitManagerServer {
  listen(port: number, host: string): Promise<{ port: number; host: string }>
  close(): Promise<void>
  /** Broadcasts a scan progress event to every connected browser tab. */
  broadcastProgress(progress: ScanProgress): void
  /** Broadcasts a navigation request (the web replacement for the tray menu). */
  broadcastNavigate(route: string): void
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? null)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  })
  res.end(payload)
}

function sendText(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(message)
}

function resolveStaticPath(root: string, pathname: string): string | null {
  const decoded = decodeURIComponent(pathname)
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '')
  const target = path.join(root, normalized)
  const resolved = path.resolve(target)
  return resolved.startsWith(path.resolve(root)) ? resolved : null
}

/**
 * HTTP + SSE server exposing the transport-agnostic API to the browser.
 *
 * The renderer talks to `/api/rpc/<method>` with a positional argument array,
 * mirroring the old `ipcRenderer.invoke` calls one-to-one.
 */
export function createServer(options: ServerOptions): GitManagerServer {
  const { api } = options
  const clients = new Set<http.ServerResponse>()
  let server: http.Server | null = null

  function broadcast(event: string, payload: unknown): void {
    if (clients.size === 0) return
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
    for (const client of [...clients]) {
      try {
        client.write(frame)
      } catch {
        clients.delete(client)
      }
    }
  }

  async function handleRpc(req: http.IncomingMessage, res: http.ServerResponse, method: string): Promise<void> {
    let args: unknown[] = []
    try {
      const raw = await readBody(req)
      if (raw.trim()) {
        const parsed = JSON.parse(raw) as unknown
        if (!Array.isArray(parsed)) {
          sendJson(res, 400, { error: 'Request body must be a JSON array of arguments.' })
          return
        }
        args = parsed
      }
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
      return
    }
    const { status, body } = await invoke(api, method, args)
    sendJson(res, status, body)
  }

  function handleEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    res.write(': connected\n\n')
    clients.add(res)
    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        clearInterval(keepAlive)
        clients.delete(res)
      }
    }, 25_000)
    req.on('close', () => {
      clearInterval(keepAlive)
      clients.delete(res)
    })
    api.setProgressSink((progress) => broadcast('scan-progress', progress))
  }

  function handleFolders(res: http.ServerResponse, url: URL): void {
    const target = url.searchParams.get('path') ?? ''
    const includeFiles = url.searchParams.get('files') === '1'
    const extensions = (url.searchParams.get('ext') ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase().replace(/^\./, ''))
      .filter(Boolean)
    try {
      sendJson(res, 200, listFoldersForWeb(target, { includeFiles, extensions }))
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  function handleReportDownload(res: http.ServerResponse, id: string): void {
    void (async () => {
      const reports = await api.listReports()
      const record = reports.find((report) => report.id === id)
      if (!record) {
        sendText(res, 404, 'Report not found.')
        return
      }
      const file = readReportFile(record.path)
      if (!file) {
        sendText(res, 404, `Report file is missing: ${record.path}`)
        return
      }
      const extension = path.extname(file.name).slice(1).toLowerCase()
      res.writeHead(200, {
        'content-type': MIME[`.${extension}`] ?? 'application/octet-stream',
        'content-length': file.content.length,
        'content-disposition': `attachment; filename="${encodeURIComponent(file.name)}"`
      })
      res.end(file.content)
    })()
  }

  function handleStatic(res: http.ServerResponse, pathname: string): void {
    const root = options.staticDir
    if (!root) {
      sendText(res, 404, 'Renderer assets are served by the Vite dev server.')
      return
    }
    const candidate = resolveStaticPath(root, pathname === '/' ? '/index.html' : pathname)
    const fallback = path.join(root, 'index.html')
    const target = candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : fallback
    if (!fs.existsSync(target)) {
      sendText(res, 404, 'Not found.')
      return
    }
    const mime = MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream'
    res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' })
    fs.createReadStream(target).pipe(res)
  }

  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const pathname = url.pathname
    try {
      if (pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          dataDir: dataDir(),
          reportsDir: reportsDir(),
          userDataDir: userDataDir()
        })
        return
      }
      if (pathname === '/api/events') {
        handleEvents(req, res)
        return
      }
      if (pathname === '/api/fs/folders') {
        handleFolders(res, url)
        return
      }
      if (pathname.startsWith('/api/reports/') && pathname.endsWith('/download')) {
        const id = decodeURIComponent(pathname.slice('/api/reports/'.length, -'/download'.length))
        handleReportDownload(res, id)
        return
      }
      if (pathname.startsWith('/api/rpc/')) {
        const method = decodeURIComponent(pathname.slice('/api/rpc/'.length))
        void handleRpc(req, res, method)
        return
      }
      if (pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: `Unknown endpoint: ${pathname}` })
        return
      }
      if (options.rendererMiddleware) {
        options.rendererMiddleware(req, res, (err) => {
          if (err) {
            logger.error('Renderer middleware failed', err)
            if (!res.headersSent) sendJson(res, 500, { error: 'Renderer middleware failed.' })
            return
          }
          sendText(res, 404, 'Not found.')
        })
        return
      }
      handleStatic(res, pathname)
    } catch (err) {
      logger.error(`Request failed: ${req.method} ${req.url}`, err)
      if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  return {
    async listen(port, host) {
      server = http.createServer(handler)
      server.keepAliveTimeout = 65_000
      await new Promise<void>((resolve, reject) => {
        server?.once('error', reject)
        server?.listen(port, host, () => resolve())
      })
      const address = server.address()
      const actualPort = typeof address === 'object' && address ? address.port : port
      return { port: actualPort, host }
    },
    async close() {
      for (const client of [...clients]) {
        try {
          client.end()
        } catch {
          /* noop */
        }
        clients.delete(client)
      }
      const current = server
      server = null
      if (!current) return
      // Browsers keep connections alive and `close()` waits for every open
      // socket, so an idle tab would otherwise stall shutdown for the whole
      // keep-alive window (65s here). A single `closeIdleConnections()` call is
      // not enough: a socket that has just finished a response is not marked
      // idle until the server processes it, so the call can miss it entirely.
      // Polling catches those and keeps the shutdown prompt without ever
      // cutting off a request that is still being served.
      const idleSweep = setInterval(() => current.closeIdleConnections(), 50)
      idleSweep.unref()
      await new Promise<void>((resolve) => {
        current.close(() => {
          clearInterval(idleSweep)
          resolve()
        })
      })
    },
    broadcastProgress: (progress) => broadcast('scan-progress', progress),
    broadcastNavigate: (route) => broadcast('navigate', route)
  }
}
