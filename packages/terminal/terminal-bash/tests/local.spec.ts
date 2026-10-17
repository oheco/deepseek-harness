import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { provideWorkingDirectoryFixture, unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import TerminalSessionService from '@deepseek-ai/dsh-terminal'
import type { TerminalSendOperation } from '@deepseek-ai/dsh-terminal'
import SandboxProvider from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local/src/resolve.ts'
import * as ptyLocal from '@deepseek-ai/dsh-terminal-bash'

describe.skipIf(!existsSync('/usr/bin/zsh'))('terminal-bash real zsh', () => {
  it('starts with a completion marker, preserves shell state, and joins cleanup', async () => {
    const { ctx, root, agent } = await harness('danger-full-access', { timeoutMs: 10_000 }, 'zsh')
    const created = await ctx.terminals.spawn(agent, { type: 'shell', name: 'zsh', cwd: root })
    expect(created.motd).toContain('dsh> ')
    const first = await ctx.terminals.startSend(agent, created.sessionId, {
      text: 'typeset -a values=(alpha beta); export KEEP=ok; cd /; false', submit: true,
    }).done
    expect(first.waitReason).toBe('stdin_read')
    const second = await ctx.terminals.startSend(agent, created.sessionId, {
      text: 'printf "cwd=%s keep=%s first=%s\\n" "$PWD" "$KEEP" "$values[1]"', submit: true,
    }).done
    expect(second.viewport).toContain('cwd=/ keep=ok first=alpha')
    expect(second.waitReason).toBe('stdin_read')
    expect(await ctx.terminals.kill(agent, created.sessionId)).toBe(true)
    expect(ctx.terminals.list(agent)).toEqual([])
  }, 20_000)
})

const roots: string[] = []
const contexts: Context[] = []
const fixturePidFiles: string[] = []

afterEach(async () => {
  const disposed = await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  const stopped = await Promise.allSettled(fixturePidFiles.splice(0).map(async (pidFile) => {
    if (!existsSync(pidFile)) return
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(Number.isSafeInteger(pid) && pid > 0, `invalid fixture PID in ${pidFile}`).toBe(true)
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    await expect.poll(() => processIsRunning(pid), { timeout: 2_000 }).toBe(false)
  }))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  const failures: unknown[] = []
  for (const result of [...disposed, ...stopped]) {
    if (result.status === 'rejected') failures.push(result.reason)
  }
  if (failures.length > 0) throw new AggregateError(failures, 'terminal fixture cleanup failed')
})

class PassthroughSandbox extends SandboxProvider {
  calls: { argv: readonly string[]; policy: SandboxPolicy }[] = []

  async confine(argv: readonly string[], policy: SandboxPolicy): Promise<ConfinedArgv> {
    this.calls.push({ argv, policy })
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

function stubAgent(ctx: Context, rawId: string): Agent {
  const id = SessionId(rawId)
  const scope = ctx.plugin(() => {})
  const session = Session.create(id)
  const agent: Agent = {
    id, options: {}, session, inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return agent
}

async function harness(
  mode: 'danger-full-access' | 'workspace-write',
  timing: { idleSilenceMs?: number; handoffGraceMs?: number; timeoutMs?: number } = {},
  dialect: 'bash' | 'zsh' | 'pwsh' = (process.platform as string) === 'openharmony' ? 'zsh' : 'bash',
) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pty-local-'))
  roots.push(root)
  const ctx = new Context()
  provideWorkingDirectoryFixture(ctx)
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TerminalSessionService)
  await ctx.plugin(PassthroughSandbox)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: root })
  await ctx.plugin(LocalSubprocessRuntime)
  const fiber = await ctx.plugin(ptyLocal, {
    shellDialect: dialect,
    pollIntervalMs: 10,
    exactProbeAfterMs: 20,
    idleSilenceMs: timing.idleSilenceMs ?? 250,
    handoffGraceMs: timing.handoffGraceMs ?? 250,
    timeoutMs: timing.timeoutMs ?? 2_000,
    disposeGraceMs: 500,
    scrollbackLines: 100,
    scrollbackMaxBytes: 32_768,
    maxReadBytes: 16_384,
  })
  const agent = stubAgent(ctx, `agent-${mode}`)
  await ctx.agents.register(agent)
  return { ctx, root, agent, fiber, sandbox: ctx.sandbox as PassthroughSandbox }
}

// TerminalSendOperation.append drops output once the operation settles, so this only
// observes a marker the child prints while `operation` is still active. A caller
// whose child is slow to print must raise the harness `timing` bounds too;
// extending this deadline alone cannot recover output the operation never collected.
async function waitForOutput(operation: TerminalSendOperation, expected: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let output = ''
  while (!output.includes(expected) && Date.now() < deadline) {
    output += operation.readOutput().delta
    if (!output.includes(expected)) await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(output).toContain(expected)
}

// A send the test interrupts settles when bash returns to its prompt, so the
// kernel may publish the foreground handoff on either side of the silence
// bound. `handoffGraceMs` widens the window that wins the exact attribution but
// cannot remove the race on a loaded host, so these settles assert that the
// session became usable again, not which readiness tier observed it.
function expectReadyForNextSend(waitReason: string): void {
  expect(['stdin_read', 'inferred_idle']).toContain(waitReason)
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (_missingProcess) {
    return false
  }
  if (process.platform !== 'linux' && (process.platform as string) !== 'openharmony') return true
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/, 1)[0]
    return !/^[ZXx]$/.test(state ?? '')
  } catch (_unreadableProcEntry) {
    return false
  }
}

function pidFileDiagnostics(pidFile: string, viewport: string): string {
  const pids = [...viewport.matchAll(/\[\d+\]\s+(\d+)/g)].flatMap(([, pid]) => pid === undefined ? [] : [pid])
  const native = spawnSync('python3', ['-c', [
    'import json, os, sys',
    'path = sys.argv[1]',
    'result = {"exists": os.path.exists(path)}',
    'if result["exists"]:',
    '    with open(path, "rb") as stream: result["bytes"] = stream.read(256).hex()',
    '    result["size"] = os.stat(path).st_size',
    'for pid in sys.argv[2:]:',
    '    try:',
    '        with open("/proc/" + pid + "/stat") as stream: result[pid] = stream.read()',
    '    except OSError as error: result[pid] = str(error)',
    'print(json.dumps(result))',
  ].join('\n'), pidFile, ...pids], { encoding: 'utf8', timeout: 1_000 })
  return `viewport=${JSON.stringify(viewport)}\nnative=${native.stdout}\nstderr=${native.stderr}\nerror=${String(native.error)}`
}

function canReadLinuxProcessSyscall(pid: number): boolean {
  try {
    readFileSync(`/proc/${pid}/task/${pid}/syscall`, 'utf8')
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') return false
    throw error
  }
}

// The real-shell suite drives a POSIX bash over the actual node-pty terminal;
// Windows has no bash, and its pwsh counterpart lives in the describe below.
describe.skipIf(process.platform === 'win32')('terminal-bash real shell', () => {
  it('persists cwd and environment across sends, scrubs secrets, and closes', async () => {
    const previous = process.env.DSH_TEST_SECRET
    process.env.DSH_TEST_SECRET = 'must-not-leak'
    try {
      const { ctx, root, agent } = await harness('danger-full-access')
      const created = await ctx.terminals.spawn(agent, { type: 'shell', name: 'main', cwd: root })
      expect(created.motd).toContain('dsh> ')

      const first = ctx.terminals.startSend(agent, created.sessionId, { text: 'export KEEP=ok; cd /', submit: true })
      expect((await first.done).waitReason).toBe('stdin_read')
      const second = ctx.terminals.startSend(agent, created.sessionId, { text: 'printf "cwd=%s keep=%s secret=%s\\n" "$PWD" "$KEEP" "${DSH_TEST_SECRET-unset}"', submit: true })
      expect((await second.done).viewport).toContain('cwd=/ keep=ok secret=unset')

      expect(ctx.terminals.read(agent, created.sessionId, { offset: 0, count: 20 }).text).toContain('cwd=/ keep=ok secret=unset')
      expect(await ctx.terminals.kill(agent, created.sessionId)).toBe(true)
      expect(ctx.terminals.list(agent)).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.DSH_TEST_SECRET
      else process.env.DSH_TEST_SECRET = previous
    }
  }, 10_000)

  it('restores the controlled prompt after an in-shell PS1 override', async () => {
    // The silence tier is pushed beyond every assertion below, so each settle
    // proves prompt-based readiness survives the override rather than the
    // inferred_idle fallback absorbing a broken prompt.
    const { ctx, agent } = await harness('danger-full-access', {
      idleSilenceMs: 5_000,
      timeoutMs: 8_000,
    })
    const created = await ctx.terminals.spawn(agent, { type: 'shell' })

    const override = ctx.terminals.startSend(agent, created.sessionId, { text: 'PS1=broken-prompt', submit: true })
    expect((await override.done).waitReason).toBe('stdin_read')

    const prompt = (process.platform as string) === 'openharmony' ? '${(%)PS1}' : '$PS1'
    const after = ctx.terminals.startSend(agent, created.sessionId, { text: `printf "healed=[%s]\\n" "${prompt}"`, submit: true })
    const result = await after.done
    expect(result.waitReason).toBe('stdin_read')
    expect(result.viewport).toContain('healed=[dsh> ]')
    await ctx.terminals.kill(agent, created.sessionId)
  }, 20_000)

  it.skipIf(process.platform !== 'linux')('recognizes a foreground read opened through /dev/tty', async () => {
    const { ctx, root, agent } = await harness('danger-full-access', {
      idleSilenceMs: 5_000,
      timeoutMs: 8_000,
    })
    const created = await ctx.terminals.spawn(agent, { type: 'shell' })
    const readerPidFile = join(root, 'tty-reader.pid')

    const waiting = ctx.terminals.startSend(agent, created.sessionId, {
      text: `bash -c 'exec </dev/tty; printf "%s" "$BASHPID" > "$1"; printf "WAITING\\n"; read -r answer; printf "ANSWER=%s\\n" "$answer"' dsh "${readerPidFile}"`,
      submit: true,
    })
    await waitForOutput(waiting, 'WAITING')
    const result = await waiting.done
    const readerPid = Number(readFileSync(readerPidFile, 'utf8'))
    expect(readerPid).toBeGreaterThan(0)
    expect(result.waitReason).toBe(canReadLinuxProcessSyscall(readerPid) ? 'stdin_read' : 'inferred_idle')

    const answer = ctx.terminals.startSend(agent, created.sessionId, { text: 'accepted', submit: true })
    const answered = await answer.done
    expect(answered.waitReason).toBe('stdin_read')
    expect(answered.viewport).toContain('ANSWER=accepted')
    await ctx.terminals.kill(agent, created.sessionId)
  }, 20_000)

  it('wraps the exact shell argv under confined policy and unregisters on reload', async () => {
    const { ctx, root, agent, fiber, sandbox } = await harness('workspace-write')
    const created = await ctx.terminals.spawn(agent, { type: 'shell' })
    expect(sandbox.calls).toEqual([{
      argv: (process.platform as string) === 'openharmony' ? ['/usr/bin/zsh', '-f', '-i'] : ['/bin/bash', '--noprofile', '--norc', '-i'],
      policy: { mode: 'workspace-write', workspaceRoot: root, sessionId: 'agent-workspace-write' },
    }])
    await fiber.dispose()
    expect(ctx.terminals.listBackends()).toEqual([])
    expect(ctx.terminals.list(agent)).toHaveLength(1)
    await ctx.terminals.kill(agent, created.sessionId)
  }, 10_000)

  it('signals a foreground command and kills a TERM-ignoring background descendant', async () => {
    const { ctx, root, agent } = await harness('danger-full-access')
    const foregroundScript = join(root, 'foreground.cjs')
    const foregroundPidFile = join(root, 'foreground.pid')
    const backgroundPidFile = join(root, 'background.pid')
    fixturePidFiles.push(foregroundPidFile, backgroundPidFile)
    const requireSubprocess = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-subprocess-local/package.json'))
    writeFileSync(foregroundScript, [
      'const { writeFileSync, writeSync } = require("node:fs")',
      `const koffi = require(${JSON.stringify(requireSubprocess.resolve('koffi'))})`,
      'const tcgetpgrp = koffi.load(null).func("int tcgetpgrp(int fd)")',
      'writeFileSync(process.argv[2], String(process.pid))',
      'process.on("SIGINT", () => { writeSync(1, "FOREGROUND_SIGINT\\n"); process.exit(0) })',
      'function ready() {',
      '  if (tcgetpgrp(0) !== process.pid) return setTimeout(ready, 10)',
      '  writeSync(1, "FOREGROUND_READY\\n")',
      '}',
      'ready()',
      'setInterval(() => {}, 60_000)',
      '',
    ].join('\n'))
    const created = await ctx.terminals.spawn(agent, { type: 'shell' })
    const read = () => ctx.terminals.read(agent, created.sessionId, { offset: 0, count: 100 }).text

    const foreground = ctx.terminals.startSend(agent, created.sessionId, {
      text: `"${process.execPath}" "${foregroundScript}" "${foregroundPidFile}"`, submit: true,
    })
    // Scrollback also observes readiness if the silence tier already settled the send.
    await expect.poll(read, { timeout: 2_000 }).toContain('FOREGROUND_READY')
    const foregroundPid = Number(readFileSync(foregroundPidFile, 'utf8'))
    expect(await ctx.terminals.signal(agent, created.sessionId, 'SIGINT')).toEqual({
      delivered: true, targetPgid: foregroundPid,
    })
    expectReadyForNextSend((await foreground.done).waitReason)
    await expect.poll(read, { timeout: 2_000 }).toContain('FOREGROUND_SIGINT')

    const background = ctx.terminals.startSend(agent, created.sessionId, {
      text: `sh -c 'trap "" TERM; printf "%s" "$$" > "$1"; exec sleep 60' dsh "${backgroundPidFile}" &`,
      submit: true,
    })
    const backgroundResult = await background.done
    // The PID file is written after TERM is ignored; exec preserves that disposition.
    try {
      await expect.poll(() => existsSync(backgroundPidFile) && readFileSync(backgroundPidFile, 'utf8'),
        { timeout: 2_000 }).toMatch(/^\d+$/)
    } catch (error) {
      throw new Error(`${JSON.stringify(backgroundResult)}\n${pidFileDiagnostics(backgroundPidFile, read())}`, { cause: error })
    }
    const pid = Number(readFileSync(backgroundPidFile, 'utf8'))
    expect(processIsRunning(pid)).toBe(true)
    await ctx.terminals.kill(agent, created.sessionId)
    // Linux can retain a stopped descendant as a zombie until its parent reaps it.
    expect(processIsRunning(pid)).toBe(false)
  }, 10_000)

  it('quiesces a disowned same-session descendant after the shell exits naturally', async () => {
    const { ctx, root, agent } = await harness('danger-full-access')
    const created = await ctx.terminals.spawn(agent, { type: 'shell' })
    const pidFile = join(root, 'disowned.pid')
    let pid: number | undefined
    try {
      const background = ctx.terminals.startSend(agent, created.sessionId, {
        text: `sh -c 'trap "" TERM; printf "%s" "$$" > "$1"; sleep 60' dsh "${pidFile}" & disown`,
        submit: true,
      })
      await background.done
      const pidDeadline = Date.now() + 2_000
      let childPid = 0
      while (childPid === 0 && Date.now() < pidDeadline) {
        if (existsSync(pidFile)) childPid = Number(readFileSync(pidFile, 'utf8'))
        if (childPid > 0) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(existsSync(pidFile), ctx.terminals.read(agent, created.sessionId, { offset: 0, count: 100 }).text).toBe(true)
      expect(childPid, childPid > 0 ? undefined
        : pidFileDiagnostics(pidFile, ctx.terminals.read(agent, created.sessionId, { offset: 0, count: 100 }).text)).toBeGreaterThan(0)
      pid = childPid
      expect(() => process.kill(childPid, 0)).not.toThrow()
      await ctx.terminals.startSend(agent, created.sessionId, { text: 'exit', submit: true }).done
      const deadline = Date.now() + 2_000
      while (ctx.terminals.list(agent)[0]?.status.kind !== 'exited' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(ctx.terminals.list(agent)[0]?.status.kind).toBe('exited')
      await ctx.terminals.kill(agent, created.sessionId)
      expect(processIsRunning(childPid)).toBe(false)
    } finally {
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch (_alreadyReaped) {
          // Product cleanup is the expected path; this only contains a failed regression.
        }
      }
    }
  }, 10_000)

  it('cancels a slow-starting raw-mode foreground process with a real SIGINT', async () => {
    const { ctx, root, agent } = await harness('danger-full-access', {
      idleSilenceMs: 10_000,
      timeoutMs: 15_000,
    })
    const script = join(root, 'raw-foreground.py')
    const pidFile = join(root, 'raw-foreground.pid')
    fixturePidFiles.push(pidFile)
    writeFileSync(script, [
      'import os, signal, sys, termios, time',
      'with open(sys.argv[1], "w") as pid_file: pid_file.write(str(os.getpid()))',
      'def interrupted(*_):',
      '    print("SIGINT_SEEN", flush=True)',
      '    sys.exit(0)',
      'signal.signal(signal.SIGINT, interrupted)',
      'attrs = termios.tcgetattr(0)',
      'attrs[3] &= ~termios.ISIG',
      'termios.tcsetattr(0, termios.TCSANOW, attrs)',
      'time.sleep(2.1)',
      'while os.tcgetpgrp(0) != os.getpgrp(): time.sleep(0.01)',
      'assert not termios.tcgetattr(0)[3] & termios.ISIG',
      'print("RAW_READY", flush=True)',
      'time.sleep(60)',
      '',
    ].join('\n'))
    const created = await ctx.terminals.spawn(agent, { type: 'shell' })
    const controller = new AbortController()
    const ready = 'RAW_READY'
    // Slow readiness must remain beyond the shared harness's short send bound.
    // Only child output contains the marker; the shell echoes a script path.
    const command = `python3 "${script}" "${pidFile}"`
    expect(command).not.toContain(ready)
    const foreground = ctx.terminals.startSend(agent, created.sessionId, {
      text: command,
      submit: true,
      signal: controller.signal,
    })
    await waitForOutput(foreground, ready, 15_000)
    controller.abort()
    const result = await foreground.done
    expectReadyForNextSend(result.waitReason)
    expect(result.viewport).toContain('SIGINT_SEEN')
    expect(processIsRunning(Number(readFileSync(pidFile, 'utf8')))).toBe(false)
    const afterReady = 'AFTER_SIGINT'
    const afterCommand = 'printf "AFTER_%s\\n" SIGINT'
    expect(afterCommand).not.toContain(afterReady)
    const after = ctx.terminals.startSend(agent, created.sessionId, {
      text: afterCommand,
      submit: true,
    })
    await waitForOutput(after, afterReady, 15_000)
    expectReadyForNextSend((await after.done).waitReason)
    await ctx.terminals.kill(agent, created.sessionId)
  }, 35_000)
})

const hasPwsh = spawnSync(
  resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'],
  { encoding: 'utf8' },
).status === 0

describe.skipIf(!hasPwsh)('terminal-bash pwsh real shell', () => {
  it.each([false, true])('bootstraps a persistent pwsh, persists state, and scrubs secrets (hold command: %s)', async (holdCommand) => {
    const previous = process.env.DSH_TEST_SECRET
    process.env.DSH_TEST_SECRET = 'must-not-leak'
    try {
      const { ctx, root, agent } = await harness('danger-full-access', {
        idleSilenceMs: 300,
        handoffGraceMs: 300,
        timeoutMs: 8_000,
      }, 'pwsh')
      const created = await ctx.terminals.spawn(agent, { type: 'shell', name: 'main', cwd: root })
      // stdin_read can precede delivery of the printable prompt to the PTY reader.
      await expect.poll(() => ctx.terminals.read(agent, created.sessionId, { offset: 0, count: 100 }).text,
        { timeout: 8_000 }).toContain('dsh> ')

      const releaseFile = join(root, 'release-command')
      // Hold the command across the silence settlement without relying on host load.
      const barrier = holdCommand
        ? `while (-not [IO.File]::Exists('${releaseFile.replaceAll("'", "''")}')) { [Threading.Thread]::Sleep(10) }; `
        : ''
      const first = ctx.terminals.startSend(agent, created.sessionId, {
        text: barrier + '$env:KEEP = "ok"; Set-Location /',
        submit: true,
      })
      expect(['stdin_read', 'inferred_idle']).toContain((await first.done).waitReason)
      const expected = 'keep=ok cwd=/ secret=END'
      const command = "Write-Output ('keep={0} cwd={1} secret={2}END' -f $env:KEEP, (Get-Location).Path, $env:DSH_TEST_SECRET)"
      expect(command).not.toContain(expected)
      const second = ctx.terminals.startSend(agent, created.sessionId, { text: command, submit: true })
      const result = await second.done
      expect(['stdin_read', 'inferred_idle']).toContain(result.waitReason)
      if (holdCommand) {
        expect(result.waitReason).toBe('inferred_idle')
        expect(result.viewport).not.toContain(expected)
        writeFileSync(releaseFile, '')
      }

      // A silence-settled send stops collecting output; scrollback still receives
      // the command's later output. Only the child can produce this formatted token.
      const read = () => ctx.terminals.read(agent, created.sessionId, { offset: 0, count: 100 }).text
      await expect.poll(read, { timeout: 8_000 }).toContain(expected)
      expect(read()).not.toContain('must-not-leak')
      expect(await ctx.terminals.kill(agent, created.sessionId)).toBe(true)
      expect(ctx.terminals.list(agent)).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.DSH_TEST_SECRET
      else process.env.DSH_TEST_SECRET = previous
    }
  }, 30_000)

  it('pins UTF-8 output encoding so non-ASCII output survives the byte decode', async () => {
    const { ctx, root, agent } = await harness('danger-full-access', {
      idleSilenceMs: 300,
      handoffGraceMs: 300,
      timeoutMs: 8_000,
    }, 'pwsh')
    const created = await ctx.terminals.spawn(agent, { type: 'shell', name: 'main', cwd: root })
    // The bootstrap itself must have pinned both encodings: the session byte
    // decode is UTF-8, so an un-pinned console writing its host code page
    // garbles every non-ASCII byte that follows.
    const pinned = ctx.terminals.startSend(agent, created.sessionId, {
      text: '"console=" + [Console]::OutputEncoding.WebName + " out=" + $OutputEncoding.WebName',
      submit: true,
    })
    const pinnedResult = await pinned.done
    expect(pinnedResult.viewport).toContain('console=utf-8 out=utf-8')
    // Char codes keep the submitted line ASCII-only, so the assertion is a
    // pure output-decode check.
    const sent = ctx.terminals.startSend(agent, created.sessionId, {
      text: "[Console]::Write([char]0x4E2D + [char]0x6587 + ' encoding-ok')",
      submit: true,
    })
    const result = await sent.done
    expect(result.viewport).toContain('中文 encoding-ok')
    await ctx.terminals.kill(agent, created.sessionId)
  }, 30_000)
})
