"""Watchdog must never signal a recycled numeric PGID after parent loss."""
import errno
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import threading
import unittest
from unittest.mock import patch

path = Path(__file__).with_name("box_supervisor.py")
spec = importlib.util.spec_from_file_location("box_supervisor_under_test", path)
assert spec and spec.loader
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)


class WatchdogPidfdTest(unittest.TestCase):
    def test_group_flag_success_uses_pidfd_only(self) -> None:
        calls = []
        with patch.object(supervisor.signal, "pidfd_send_signal",
                          side_effect=lambda fd, sig, info=None, flags=0:
                          calls.append((fd, sig, flags))), \
             patch.object(supervisor, "kill_group", side_effect=AssertionError("numeric PGID")):
            self.assertTrue(supervisor.signal_group_by_pidfd(31))
        self.assertEqual(calls, [(31, supervisor.signal.SIGKILL, 4)])

    def test_old_kernel_falls_back_to_leader_pidfd_not_numeric_group(self) -> None:
        calls = []

        def send(fd, sig, info=None, flags=0):
            calls.append((fd, sig, flags))
            if flags == 4:
                raise OSError(errno.EINVAL, "old kernel")

        with patch.object(supervisor.signal, "pidfd_send_signal", side_effect=send), \
             patch.object(supervisor, "kill_group", side_effect=AssertionError("numeric PGID")):
            self.assertFalse(supervisor.signal_group_by_pidfd(32))
        self.assertEqual(calls, [(32, supervisor.signal.SIGKILL, 4),
                                 (32, supervisor.signal.SIGKILL, 0)])

    def test_reaped_leader_cannot_redirect_signal_to_reused_pgid(self) -> None:
        child = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(.05)"],
                                 start_new_session=True)
        watch_read, watch_write = os.pipe()
        ack_read, ack_write = os.pipe()
        result = []
        thread = threading.Thread(target=lambda: result.append(
            supervisor.watch_parent(watch_read, ack_write, child.pid)))
        try:
            thread.start()
            self.assertEqual(os.read(ack_read, 1), b"R")
            child.wait(timeout=2)  # leader is reaped before watchdog sees EOF
            os.close(watch_write); watch_write = -1
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(result, [125], "reaped original target cannot be group-signalled")
        finally:
            if watch_write >= 0:
                os.close(watch_write)
            os.close(ack_read)
            if child.poll() is None:
                child.kill(); child.wait(timeout=2)


if __name__ == "__main__":
    unittest.main()
