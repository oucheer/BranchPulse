import fs from 'node:fs'
import path from 'node:path'
import { logsDir } from './paths'

type Level = 'info' | 'warn' | 'error'

class Logger {
  private stream: fs.WriteStream | null = null

  init(): void {
    try {
      const dir = logsDir()
      const file = path.join(dir, `branchpulse-${new Date().toISOString().slice(0, 10)}.log`)
      this.stream = fs.createWriteStream(file, { flags: 'a' })
    } catch {
      this.stream = null
    }
  }

  private write(level: Level, msg: string): void {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.log(line)
    }
    try {
      this.stream?.write(line + '\n')
    } catch {
      /* noop */
    }
  }

  info(msg: string): void {
    this.write('info', msg)
  }

  warn(msg: string): void {
    this.write('warn', msg)
  }

  error(msg: string, err?: unknown): void {
    const detail = err instanceof Error ? ` ${err.message}` : ''
    this.write('error', msg + detail)
  }
}

export const logger = new Logger()
