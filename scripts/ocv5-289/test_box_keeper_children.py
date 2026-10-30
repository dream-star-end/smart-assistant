"""Kernel ownership and fail-closed cleanup regressions; no model calls."""
import errno
import os
from pathlib import Path
import runpy
import signal
import subprocess
import sys
import time
from types import SimpleNamespace
import unittest
from unittest import mock

KEEPER = Path(__file__).with_name("box_keeper.py")


def cleanup_child(pid: int) -> None:
    fd = None
    try:
        fd = os.pidfd_open(pid, 0)
        os.waitid(os.P_PIDFD, fd, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        try:
            signal.pidfd_send_signal(fd, signal.SIGKILL, None, 0)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError):
        pass
    finally:
        if fd is not None:
            os.close(fd)


class OwnedChildrenTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = runpy.run_path(str(KEEPER))
        self.stop = self.module["stop_owned_children"]
        self.reap = self.module["reap_adopted_after_last_signal"]

    def test_foreign_pidfd_is_not_signal_authority(self) -> None:
        with mock.patch.dict(self.stop.__globals__, {"owned_children": lambda: [os.getppid()]}):
            with mock.patch.object(signal, "pidfd_send_signal") as sent:
                with self.assertRaises(ChildProcessError):
                    self.stop(time.monotonic() + 1)
                sent.assert_not_called()

    def test_entire_batch_is_validated_before_first_signal(self) -> None:
        child = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"])
        try:
            with mock.patch.dict(self.stop.__globals__, {
                    "owned_children": lambda: [child.pid, os.getppid()]}):
                with mock.patch.object(signal, "pidfd_send_signal") as sent:
                    with self.assertRaises(ChildProcessError):
                        self.stop(time.monotonic() + 1)
                    sent.assert_not_called()
            self.assertIsNone(child.poll())
        finally:
            child.kill()
            child.wait(timeout=3)

    def test_denied_signal_does_not_fall_back_to_numeric_pid(self) -> None:
        child = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"])
        try:
            with mock.patch.object(signal, "pidfd_send_signal", side_effect=PermissionError):
                with mock.patch.object(os, "kill") as numeric, mock.patch.object(os, "killpg") as group:
                    with self.assertRaises(PermissionError):
                        self.stop(time.monotonic() + 1)
                    numeric.assert_not_called()
                    group.assert_not_called()
            self.assertIsNone(child.poll())
        finally:
            child.kill()
            child.wait(timeout=3)

    def test_empty_candidate_list_is_not_echild(self) -> None:
        child = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"])
        try:
            began = time.monotonic()
            with mock.patch.dict(self.stop.__globals__, {"owned_children": lambda: []}):
                self.assertFalse(self.reap())
            self.assertLess(time.monotonic() - began, 1.8)
            self.assertIsNone(child.poll())
        finally:
            child.kill()
            child.wait(timeout=3)

    def test_unreadable_ownership_stays_unproven(self) -> None:
        child = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"])
        try:
            def denied():
                raise PermissionError(errno.EACCES, "fixture")
            with mock.patch.dict(self.stop.__globals__, {"owned_children": denied}):
                self.assertFalse(self.reap())
            self.assertIsNone(child.poll())
        finally:
            child.kill()
            child.wait(timeout=3)

    def test_missing_pidfd_signal_capability_stays_unproven(self) -> None:
        child = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"])
        try:
            with mock.patch.dict(self.stop.__globals__, {"signal": SimpleNamespace()}):
                self.assertFalse(self.reap())
            self.assertIsNone(child.poll())
        finally:
            child.kill()
            child.wait(timeout=3)

    def test_invalid_or_oversize_kernel_candidate_frame_is_rejected(self) -> None:
        for raw in (b"0", b"-1", b"1 x", b"2147483648", b"12345678901",
                    b"1 " * 257, b"9" * 4097):
            with self.subTest(raw=raw[:24]):
                with mock.patch.object(os, "open", return_value=12345):
                    with mock.patch.object(os, "read", return_value=raw):
                        with mock.patch.object(os, "close") as closed:
                            with self.assertRaises(ValueError):
                                self.module["owned_children"]()
                            closed.assert_called_once_with(12345)

    def test_binding_failure_closes_open_handles_without_signal(self) -> None:
        with mock.patch.dict(self.stop.__globals__, {"owned_children": lambda: [123]}):
            with mock.patch.object(os, "pidfd_open", return_value=12345):
                with mock.patch.object(os, "waitid", side_effect=ChildProcessError):
                    with mock.patch.object(os, "close") as closed:
                        with mock.patch.object(signal, "pidfd_send_signal") as sent:
                            with self.assertRaises(ChildProcessError):
                                self.stop(time.monotonic() + 1)
                            closed.assert_called_once_with(12345)
                            sent.assert_not_called()

    def test_sigterm_ignoring_owned_child_is_actually_killed_and_reaped(self) -> None:
        read_fd, write_fd = os.pipe()
        pid = os.fork()
        if pid == 0:
            os.close(read_fd)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            os.write(write_fd, b"R")
            os.close(write_fd)
            time.sleep(30)
            os._exit(0)
        os.close(write_fd)
        try:
            self.assertEqual(os.read(read_fd, 1), b"R")
            with mock.patch.object(os, "kill") as numeric, mock.patch.object(os, "killpg") as group:
                self.assertTrue(self.reap())
                numeric.assert_not_called()
                group.assert_not_called()
            with self.assertRaises(ChildProcessError):
                os.waitpid(-1, os.WNOHANG)
            self.assertFalse(Path(f"/proc/{pid}").exists())
        finally:
            os.close(read_fd)
            cleanup_child(pid)


if __name__ == "__main__":
    unittest.main()
