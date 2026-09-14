"""Drive the real OMP TUI through a PTY; never connects to a model endpoint."""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave,
                         env=os.environ, start_new_session=True)
os.close(slave)
output = bytearray()
answered = False
exited = False
deadline = time.monotonic() + 50
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            output.extend(data)
            with open(os.environ["OMP_REVIEW_TEST_TRACE"] + ".tty", "ab") as capture:
                capture.write(data)
            # Terminal capability/background/cursor queries used by the real TUI.
            if b"\x1b[6n" in data:
                os.write(master, b"\x1b[1;1R")
            if b"\x1b]11;?" in data:
                os.write(master, b"\x1b]11;rgb:0000/0000/0000\x1b\\")
        if not answered and "仅批准本次调用".encode() in output:
            time.sleep(0.05)
            scenario = os.environ["OMP_REVIEW_TEST_CASE"]
            if scenario == "tui-approve":
                os.write(master, b"\r")
            elif scenario == "tui-cancel":
                os.write(master, b"\x1b")
            elif scenario.startswith("tui-auto-"):
                pass
            else:
                # The fixture recommends approval, so move to rejection explicitly.
                os.write(master, b"\x1b[A")
                time.sleep(0.05)
                os.write(master, b"\r")
            answered = True
        if answered and not exited and b"SMOKE_DONE" in output:
            os.write(master, b"\x04")
            exited = True
        if child.poll() is not None:
            break
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
    try:
        child.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
    os.close(master)
sys.stdout.buffer.write(output)
if not answered:
    print("\nTUI_DRIVER_ERROR: approval dialog never appeared")
    sys.exit(1)
if not exited:
    print("\nTUI_DRIVER_ERROR: main agent did not finish")
    sys.exit(1)
sys.exit(0)
