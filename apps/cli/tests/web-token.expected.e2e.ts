/** Real CLI token exchange over shipped Web rows, without model or frontend build inputs. */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request, type IncomingHttpHeaders } from 'node:http'
import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, initProfile, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { resolveExampleLaunch, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const runtimeFixture = new URL('./fixtures/web-token/runtime.ts', import.meta.url).href

interface RunningWeb {
  child: ChildProcess
  url: string
  completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  output: () => string
}

function redact(text: string): string {
  return text.replace(/([?&]token=)[^\s)]+/gu, '$1<redacted>')
}

async function prepare(root: string): Promise<string> {
  const home = join(root, 'home')
  const profile = join(home, 'profiles/web')
  initProfile(profile, [])
  const selected = new Set(['web-startup', 'webserver', 'web-runtime', 'connection'])
  const rows = composeEntries([loadOverlayPatches('web-token-test', join(repoRoot, 'packages/bundle/web-app/cordis.patch.yml'))])
    .filter(row => selected.has(row.id!))
    .map(row => row.id === 'web-runtime' ? { ...row, name: runtimeFixture } : row)
  expect(rows).toHaveLength(selected.size)
  await writeFile(join(profile, 'cordis.patch.yml'), yaml.dump([{ insert: [
    { id: 'credentials', name: '@deepseek-ai/dsh-credentials-local', config: { watch: false } },
    ...rows,
  ] }], { schema: entryListSchema }))
  return home
}

async function start(root: string, home: string, flags: string[]): Promise<RunningWeb> {
  const launch = resolveExampleLaunch({
    srcBin: join(repoRoot, 'apps/cli/src/bin.ts'), sourceImport: 'tsx/esm',
    tsconfigPath: join(repoRoot, 'tsconfig.json'),
    configArgs: ['web', '--no-open', '--port', '0', ...flags],
    env: {
      DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents'), DSH_TELEMETRY_DISABLED: '1',
      NODE_OPTIONS: undefined, NODE_PATH: undefined, SSH_CONNECTION: '', SSH_TTY: '',
    },
  })
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)))
  const child = spawn(launch.command, launch.args, {
    cwd: root, env: { ...env, ...launch.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let output = ''
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => { resolve({ code, signal }) })
  })
  const running: RunningWeb = { child, url: '', completion, output: () => output }
  try {
    running.url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { finish(new Error('Web CLI readiness timed out')) }, 30_000)
      const finish = (error?: Error, url?: string): void => {
        clearTimeout(timer)
        child.off('error', failed)
        child.off('close', closed)
        if (error !== undefined) reject(error)
        else resolve(url!)
      }
      const failed = (error: Error): void => { finish(error) }
      const closed = (): void => { finish(new Error('Web CLI closed before readiness')) }
      const append = (chunk: Buffer): void => {
        output += chunk.toString()
        const url = /dsh web: (http:\/\/[^\s]+)/u.exec(output)?.[1]
        if (url !== undefined) finish(undefined, url)
      }
      child.on('error', failed)
      child.on('close', closed)
      child.stdout!.on('data', append)
      child.stderr!.on('data', append)
    })
    return running
  } catch (error) {
    await stop(running)
    throw new Error(`${String(error)}\n${redact(output)}`, { cause: error })
  }
}

async function stop(running: RunningWeb): Promise<void> {
  if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill('SIGTERM')
  const force = setTimeout(() => { running.child.kill('SIGKILL') }, 10_000)
  try {
    const result = await running.completion
    expect(result, redact(running.output())).toEqual({ code: 0, signal: null })
  } finally { clearTimeout(force) }
}

async function reload(running: RunningWeb): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { finish(new Error('Connection reload timed out')) }, 15_000)
    const finish = (error?: Error, url?: string): void => {
      clearTimeout(timer)
      running.child.off('message', received)
      running.child.off('close', closed)
      if (error !== undefined) reject(error)
      else resolve(url!)
    }
    const closed = (): void => { finish(new Error('Web CLI closed during reload')) }
    const received = (message: { command?: string; url?: string; error?: string }): void => {
      if (message.command !== 'reload') return
      if (message.error !== undefined || message.url === undefined) finish(new Error(message.error ?? 'missing reload URL'))
      else finish(undefined, message.url)
    }
    running.child.on('message', received)
    running.child.on('close', closed)
    running.child.send('reload', (error) => { if (error !== null) finish(error) })
  })
}

async function get(url: URL, headers: Record<string, string> = {}): Promise<{
  status: number; headers: IncomingHttpHeaders; body: string
}> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('error', reject)
      res.on('end', () => { resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }) })
    })
    req.on('error', reject)
    req.end()
  })
}

async function withForwardedPort<T>(port: number, inspect: (port: number) => Promise<T>): Promise<T> {
  const sockets = new Set<Socket>()
  const server = createServer((downstream) => {
    const upstream = createConnection({ host: '127.0.0.1', port })
    for (const socket of [downstream, upstream]) {
      sockets.add(socket)
      socket.on('close', () => { sockets.delete(socket) })
    }
    downstream.on('error', () => { upstream.destroy() })
    upstream.on('error', () => { downstream.destroy() })
    downstream.pipe(upstream).pipe(downstream)
  })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    return await inspect((server.address() as AddressInfo).port)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => { server.close(error => error === undefined ? resolve() : reject(error)) })
  }
}

function cookieOf(result: { headers: IncomingHttpHeaders }): string {
  const cookie = result.headers['set-cookie']?.[0]
  if (cookie === undefined) throw new Error('token exchange omitted Set-Cookie')
  expect(cookie).toContain('; Max-Age=2592000; Path=/;')
  expect(cookie).toContain('; HttpOnly; SameSite=Strict')
  expect(cookie).not.toMatch(/Secure|Domain=/u)
  return cookie.split(';', 1)[0]!
}

async function inspectAuthentication(running: RunningWeb, token: string): Promise<{
  cookie: string; login: number; wrongToken: number; mappedApi: number
}> {
  const url = new URL(running.url)
  expect(url.searchParams.get('token')).toBe(token)
  const wrong = new URL(url)
  wrong.searchParams.set('token', `${token}-wrong`)
  const wrongToken = (await get(wrong)).status
  expect(wrongToken).toBe(401)
  const exchange = await get(url)
  expect(exchange.status).toBe(303)
  expect(exchange.headers.location).toBe('./')
  const cookie = cookieOf(exchange)
  expect((await get(new URL('/', url), { cookie })).body).toContain('authenticated page')
  expect((await get(new URL('/api/token-check', url), { cookie })).status).toBe(200)
  expect(new URL(await reload(running)).searchParams.get('token')).toBe(token)
  expect((await get(new URL('/api/token-check', url), { cookie })).status).toBe(200)

  const mappedApi = await withForwardedPort(Number(url.port), async (port) => {
    const mapped = new URL(url)
    mapped.port = String(port)
    const mappedCookie = cookieOf(await get(mapped))
    const endpoint = new URL('/api/token-check', mapped)
    const browserHeaders = { cookie: mappedCookie, origin: mapped.origin, 'sec-fetch-site': 'same-origin' }
    const authenticated = await get(endpoint, browserHeaders)
    expect(authenticated.body).toBe('authenticated')
    expect(authenticated.status).toBe(200)
    expect((await get(endpoint, { ...browserHeaders, host: url.host })).status).toBe(403)
    expect((await get(endpoint, { cookie: mappedCookie, host: url.host })).status).toBe(401)
    expect((await get(endpoint, { ...browserHeaders, host: 'untrusted.example' })).status).toBe(403)
    return authenticated.status
  })
  return { cookie, login: exchange.status, wrongToken, mappedApi }
}

describe('dsh web launch token through the CLI and shipped Cordis consumers', () => {
  it('documents the token flag and rejects empty or missing values before readiness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-token-usage-'))
    try {
      const home = await prepare(root)
      const run = (args: string[], expectedExitCode: number) => runLoaderSmoke({
        label: 'Web token usage', binScript: join(repoRoot, 'apps/cli/src/bin.ts'),
        binArgs: ['web', '--no-open', '--port', '0', ...args],
        configPath: join(home, 'profiles/web/cordis.patch.yml'),
        cwd: root, sourceImport: 'tsx/esm', tsconfigPath: join(repoRoot, 'tsconfig.json'),
        env: { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', NODE_OPTIONS: undefined },
        expectedExitCode,
      })
      const help = await run(['--help'], 0)
      expect(help.stdout).toContain('--token <token>')
      expect(help.stdout).not.toContain('dsh web: http://')
      const diagnostics: string[] = []
      for (const args of [['--token', ''], ['--token='], ['--token']]) {
        const result = await run(args, 1)
        expect(result.stdout).not.toContain('dsh web: http://')
        diagnostics.push(result.stderr.split('\n').find(line => line.startsWith('error:'))!)
      }
      expect(diagnostics).toMatchInlineSnapshot(`
        [
          "error: --token must not be empty",
          "error: --token must not be empty",
          "error: option '--token <token>' argument missing",
        ]
      `)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('reuses an encoded fixed token and authority-bound cookie after reload and restart without persisting the token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-token-'))
    let running: RunningWeb | undefined
    try {
      const home = await prepare(root)
      const token = 'fixed +/&?=%#令牌🔐'
      running = await start(root, home, ['--token', token])
      const { cookie } = await inspectAuthentication(running, token)
      const firstUrl = new URL(running.url)
      const credentials = await readFile(join(home, '.credentials.yaml'), 'utf8')
      expect(credentials).not.toContain(token)
      await stop(running)
      running = undefined
      running = await start(root, home, [`--token=${token}`])
      const restartedUrl = new URL(running.url)
      expect({ pathname: restartedUrl.pathname, search: restartedUrl.search })
        .toEqual({ pathname: firstUrl.pathname, search: firstUrl.search })
      // Cookie remains bound to browser authority while restart selects a fresh listening port.
      expect((await get(new URL('/api/token-check', restartedUrl), {
        cookie, host: firstUrl.host, origin: firstUrl.origin, 'sec-fetch-site': 'same-origin',
      })).status).toBe(200)
      const { login, wrongToken, mappedApi } = await inspectAuthentication(running, token)
      expect(await readFile(join(home, '.credentials.yaml'), 'utf8')).toBe(credentials)
      expect({ token: new URL(running.url).searchParams.get('token'), login, wrongToken, mappedApi })
        .toMatchInlineSnapshot(`
          {
            "login": 303,
            "mappedApi": 200,
            "token": "fixed +/&?=%#令牌🔐",
            "wrongToken": 401,
          }
        `)
    } finally {
      try { if (running !== undefined) await stop(running) }
      finally { await rm(root, { recursive: true, force: true }) }
    }
  })

  it('retains the random token on reload and changes it on restart when the flag is omitted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-token-random-'))
    let running: RunningWeb | undefined
    try {
      const home = await prepare(root)
      running = await start(root, home, [])
      const token = new URL(running.url).searchParams.get('token')!
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u)
      expect(new URL(await reload(running)).searchParams.get('token')).toBe(token)
      await stop(running)
      running = undefined
      running = await start(root, home, [])
      expect(new URL(running.url).searchParams.get('token')).not.toBe(token)
    } finally {
      try { if (running !== undefined) await stop(running) }
      finally { await rm(root, { recursive: true, force: true }) }
    }
  })
})
