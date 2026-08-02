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
"""

import errno
import fcntl
import os
import pty
import select
import struct
import sys
import termios

BUFFER_SIZE = 65536
CONTROL_FD = 3


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
    try:
        os.fstat(CONTROL_FD)
    except OSError:
        return False
    return True


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

    pid, master_fd = pty.fork()
    if pid == 0:
        # Child: stdin/stdout/stderr are already the pty slave.
        try:
            os.execvp(argv[0], argv)
        except OSError as exc:
            sys.stderr.write("pty-bridge: cannot start %s: %s\n" % (argv[0], exc))
            sys.stderr.flush()
        os._exit(127)

    set_winsize(master_fd, rows, cols)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    control = CONTROL_FD if control_fd_available() else None
    control_buffer = b""

    watching = [master_fd, stdin_fd]
    if control is not None:
        watching.append(control)

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
                break

        if stdin_fd in readable:
            data = read_some(stdin_fd)
            if data is None or data == b"":
                watching.remove(stdin_fd)
            else:
                write_all(master_fd, data)

        if control is not None and control in readable:
            data = read_some(control)
            if data is None or data == b"":
                watching.remove(control)
                control = None
            else:
                control_buffer = apply_control(master_fd, control_buffer + data)

    try:
        os.close(master_fd)
    except OSError:
        pass

    try:
        _, status = os.waitpid(pid, 0)
    except OSError:
        return 0

    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 0


if __name__ == "__main__":
    sys.exit(main())
