"""Bounded native zsh exec diagnostic; uses no Harness or node-pty code."""

import errno
import json
import os
import pty
import select
import signal
import subprocess
import time


def read_until(fd, marker, timeout):
    end = time.monotonic() + timeout
    output = b""
    while time.monotonic() < end:
        ready, _, _ = select.select([fd], [], [], min(0.1, max(0, end - time.monotonic())))
        if not ready:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            break
        if not chunk:
            break
        output += chunk
        if marker in output:
            break
    return output


def main():
    print(subprocess.check_output(["/usr/bin/zsh", "--version"], text=True, timeout=3).strip())
    direct = subprocess.run(
        ["/usr/bin/zsh", "-f", "-c", "exec /usr/bin/zsh -f -c 'print EXEC_OK'"],
        capture_output=True, text=True, timeout=3, check=True,
    )
    print("noninteractive:", repr(direct.stdout))
    pid, fd = pty.fork()
    if pid == 0:
        os.execve("/usr/bin/zsh", ["/usr/bin/zsh", "-f", "-i"],
                  dict(os.environ, TERM="dumb", PS1="DSH_NATIVE_EXEC> ", RPS1=""))
    try:
        marker = b"DSH_NATIVE_EXEC> "
        initial = read_until(fd, marker, 3)
        if marker not in initial:
            raise RuntimeError("initial interactive shell did not reach its prompt")
        os.write(fd, b"exec /usr/bin/zsh -f -i\n")
        output = read_until(fd, marker, 3)
        try:
            with open(f"/proc/{pid}/stat") as stream:
                fields = stream.read().rsplit(") ", 1)[1].split()
            state = {"state": fields[0], "exit_signal": fields[35], "exit_code": fields[49]}
        except FileNotFoundError:
            state = {"state": "gone"}
        print(json.dumps({"interactive_output": output.decode("utf-8", "replace"),
                          "replacement_prompt": marker in output, "process": state}))
    finally:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        os.close(fd)


if __name__ == "__main__":
    main()
