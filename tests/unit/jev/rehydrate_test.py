"""Fixture lifecycle tests. No production DB, containers or systemd units are touched."""
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[3] / "scripts/jev/rehydrate-jev-hook.py"
spec = importlib.util.spec_from_file_location("rehydrate", SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Response:
    status = 200
    def __enter__(self): return self
    def __exit__(self, *args): pass


class RehydrateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "fixture.sqlite"
        with sqlite3.connect(self.db) as conn:
            conn.execute("CREATE TABLE api_keys(name TEXT, key TEXT)")
            conn.execute("CREATE TABLE middleware_hooks(name TEXT, description TEXT, priority INT, code TEXT, enabled INT)")
            conn.execute("INSERT INTO api_keys VALUES('omniroute-verify','fixture-only')")
            conn.execute("INSERT INTO middleware_hooks VALUES('jev-router','fixture',10,'fixture code',1)")
        self.addCleanup(self.temp.cleanup)

    def test_recreates_container_memory_and_reads_current_persisted_state(self):
        for enabled in [1, 0, 1]:
            with sqlite3.connect(self.db) as conn:
                conn.execute("UPDATE middleware_hooks SET enabled=?", (enabled,))
            # Empty runtime models a new container. Every invocation must rehydrate,
            # even after a successful prior invocation, preserving disabled state.
            runtime = {}
            def opener(request, **kwargs):
                if not isinstance(request, str):
                    self.assertEqual(request.method, "PUT")
                    runtime["jev-router"] = json.loads(request.data)
                return Response()
            module.rehydrate(self.db, "http://127.0.0.1:1", opener=opener)
            self.assertEqual(runtime["jev-router"]["enabled"], bool(enabled))
            self.assertEqual(runtime["jev-router"]["code"], "fixture code")

    def test_readiness_retry_then_one_idempotent_put(self):
        calls = []
        def opener(request, **kwargs):
            calls.append(request)
            if len(calls) == 1: raise OSError("not ready")
            return Response()
        module.rehydrate(self.db, "http://localhost:1", opener=opener, sleep=lambda _: None)
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[-1].method, "PUT")

    def test_missing_database_is_not_created(self):
        missing = self.db.parent / "missing.sqlite"
        with self.assertRaises(sqlite3.OperationalError):
            module.rehydrate(missing, "http://localhost:1")
        self.assertFalse(missing.exists())

    def test_never_enables_missing_hook_or_retries_ambiguous_mutation(self):
        attempts = []
        def opener(request, **kwargs):
            if not isinstance(request, str):
                attempts.append(request)
                raise OSError("ambiguous connection failure")
            return Response()
        with self.assertRaises(OSError): module.rehydrate(self.db, "http://localhost:1", opener=opener)
        self.assertEqual(len(attempts), 1)
        with sqlite3.connect(self.db) as conn: conn.execute("DELETE FROM middleware_hooks")
        with self.assertRaises(ValueError): module.rehydrate(self.db, "http://localhost:1", opener=opener)
        self.assertEqual(len(attempts), 1)

    def test_remote_api_rejected_and_readiness_deadline_bounded(self):
        with self.assertRaises(ValueError): module.rehydrate(self.db, "https://remote.invalid")
        with self.assertRaises(TimeoutError): module.rehydrate(self.db, "http://localhost:1", timeout=0)


if __name__ == "__main__": unittest.main()
