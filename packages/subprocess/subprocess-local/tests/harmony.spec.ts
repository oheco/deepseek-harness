/** Native HarmonyOS child-output and PTY behavior through the local providers. */
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type * as NodePty from 'node-pty'
import { spawnSubprocess } from '../src/spawn.ts'
import { createProcessInspector } from '../src/process-inspector.ts'
import { LocalTerminalHandle } from '../src/terminal.ts'

const hostPlatform: string = process.platform

describe.runIf(hostPlatform === 'openharmony')('HarmonyOS native subprocess providers', () => {
  it('retains complete UTF-8 output in a private exclusive spill during child exit', async ({ onTestFinished }) => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-harmony-output-'))
    onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
    const payload = 'native-output-中文\n'.repeat(8192)
    const failures: unknown[] = []
    const handle = spawnSubprocess({
      argv: [process.execPath, '-e', 'process.stdout.write("native-output-中文\\n".repeat(8192))'],
      cwd: dir,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 128, spill: { maxBytes: Buffer.byteLength(payload) } },
        stderr: { maxBytes: 128 },
      },
      graceMs: 200,
    }, { spillDir: dir, onSpillFailure: (error) => { failures.push(error) } })
    try {
      await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
      await handle.waitForExit()
      const result = handle.collected.stdout!.readFrom(0)
      expect(result.lossy).toBe(true)
      expect(result.nextOffset).toBe(Buffer.byteLength(payload))
      expect(result.spillPath).toBeTypeOf('string')
      expect(readFileSync(result.spillPath!, 'utf8')).toBe(payload)
      expect(statSync(result.spillPath!).mode & 0o777).toBe(0o600)
      expect(failures).toEqual([])
    } finally {
      handle.terminate()
      await handle.waitForExit()
    }
  }, 30_000)

  it('queries the real terminal foreground group and exchanges resized PTY input', async ({ onTestFinished }) => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-harmony-terminal-'))
    onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
    const nodePty = createRequire(import.meta.url)('node-pty') as typeof NodePty
    const pty = nodePty.spawn('/usr/bin/zsh', ['-f', '-c', 'printf "READY\\n"; read -r answer; printf "REPLY:%s\\n" "$answer"'], {
      cwd: dir,
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(key))),
    })
    const handle = new LocalTerminalHandle(pty, createProcessInspector(), 200)
    let output = ''
    handle.output.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    try {
      await vi.waitFor(() => { expect(output).toContain('READY') }, { timeout: 5_000 })
      await expect(handle.inspectForeground()).resolves.toEqual({ processGroupId: pty.pid, inputWaiting: false })
      await handle.resize(100, 40)
      await handle.write('accepted\r')
      await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
      expect(output).toContain('REPLY:accepted')
    } finally {
      await handle.terminate()
      handle.output.destroy()
    }
  }, 30_000)
})
