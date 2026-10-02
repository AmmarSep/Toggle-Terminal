#!/usr/bin/env python3
"""Minimal pty bridge for the Obsidian Toggle Terminal plugin.

Allocates a real pty and proxies it over ordinary pipes, which is what
node-pty would do natively. Used when node-pty is not installed.

Usage:
    pty-bridge.py <rows> <cols> <command> [args...]

Wiring:
    stdin  -> pty master   keystrokes
    master -> stdout       screen output
    fd 3   -> control      one "<rows> <cols>\\n" per resize (optional)

Unlike script(1), this works when stdin is a pipe or socket rather than a
terminal, and it supports live resizing.

Lifetime: when stdin reaches EOF — Obsidian quit, crashed, or the plugin
closed the session — the bridge hangs up the pty exactly like closing a
terminal window: the shell gets SIGHUP, and is killed if it ignores it.
Without this an idle shell never notices Obsidian is gone and both
processes linger forever.
"""

import errno
import fcntl
import os
import pty
import select
import signal
import stat
import struct
import sys
import termios
import time

BUFFER_SIZE = 65536
CONTROL_FD = 3
HANGUP_GRACE_SECONDS = 2.0


def set_winsize(fd, rows, cols):
    """TIOCSWINSZ also raises SIGWINCH in the foreground process group."""
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def write_all(fd, data):
    while data:
        try:
            written = os.write(fd, data)
        except OSError as exc:
            if exc.errno == errno.EINTR:
                continue
            if exc.errno == errno.EAGAIN:
                select.select([], [fd], [])
                continue
            return False
        data = data[written:]
    return True


def read_some(fd):
    try:
        return os.read(fd, BUFFER_SIZE)
    except OSError as exc:
        if exc.errno == errno.EINTR:
            return b""
        return None


def control_fd_available():
    """True when the parent handed us a pipe (or socket) on fd 3.

    Must be asked before pty.fork(): without a control channel the master
    itself may be allocated fd 3, and treating it as the control channel
    makes the bridge read the terminal twice and hang.
    """
    try:
        mode = os.fstat(CONTROL_FD).st_mode
    except OSError:
        return False
    return stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode)


def apply_control(master_fd, buffer):
    """Consume complete '<rows> <cols>' lines from the control buffer."""
    while b"\n" in buffer:
        line, buffer = buffer.split(b"\n", 1)
        parts = line.split()
        if len(parts) == 2:
            try:
                set_winsize(master_fd, int(parts[0]), int(parts[1]))
            except ValueError:
                pass
    return buffer


def signal_group(pid, signum):
    """The child called setsid() inside pty.fork(), so its pid is its group."""
    try:
        os.killpg(pid, signum)
    except OSError:
        pass


def reap(pid, grace):
    """Wait for the child; after `grace` seconds, SIGKILL its group and wait again."""
    deadline = None if grace is None else time.monotonic() + grace
    while True:
        try:
            done, status = os.waitpid(pid, 0 if deadline is None else os.WNOHANG)
        except OSError:
            return None
        if done:
            return status
        if time.monotonic() >= deadline:
            signal_group(pid, signal.SIGKILL)
            deadline = None
            continue
        time.sleep(0.05)


def exit_code(status):
    if status is None:
        return 0
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 0


def on_terminate(signum, _frame):
    # Unwind through main()'s cleanup instead of dying with the pty open.
    raise SystemExit(128 + signum)


def main():
    if len(sys.argv) < 4:
        sys.stderr.write("pty-bridge: usage: pty-bridge.py <rows> <cols> <command> [args...]\n")
        return 2

    try:
        rows = max(int(sys.argv[1]), 1)
        cols = max(int(sys.argv[2]), 1)
    except ValueError:
        rows, cols = 24, 80
    argv = sys.argv[3:]
    control = CONTROL_FD if control_fd_available() else None

    pid, master_fd = pty.fork()
    if pid == 0:
        # Child: stdin/stdout/stderr are already the pty slave.
        try:
            os.execvp(argv[0], argv)
        except OSError as exc:
            sys.stderr.write("pty-bridge: cannot start %s: %s\n" % (argv[0], exc))
            sys.stderr.flush()
        os._exit(127)

    signal.signal(signal.SIGTERM, on_terminate)
    signal.signal(signal.SIGHUP, on_terminate)

    set_winsize(master_fd, rows, cols)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    control_buffer = b""

    watching = [master_fd, stdin_fd]
    if control is not None:
        watching.append(control)

    hang_up = False
    try:
        while True:
            try:
                readable = select.select(watching, [], [])[0]
            except OSError as exc:
                if exc.errno == errno.EINTR:
                    continue
                break

            if master_fd in readable:
                data = read_some(master_fd)
                if data is None or data == b"":
                    # EIO on the master means the child closed the slave: it exited.
                    break
                if not write_all(stdout_fd, data):
                    # Nobody is reading the screen any more.
                    hang_up = True
                    break

            if stdin_fd in readable:
                data = read_some(stdin_fd)
                if data is None or data == b"":
                    hang_up = True
                    break
                write_all(master_fd, data)

            if control is not None and control in readable:
                data = read_some(control)
                if data is None or data == b"":
                    watching.remove(control)
                    control = None
                else:
                    control_buffer = apply_control(master_fd, control_buffer + data)
    except SystemExit:
        hang_up = True
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass
        if hang_up:
            signal_group(pid, signal.SIGHUP)

    return exit_code(reap(pid, HANGUP_GRACE_SECONDS if hang_up else None))


if __name__ == "__main__":
    sys.exit(main())
