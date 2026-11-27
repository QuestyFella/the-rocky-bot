#!/usr/bin/env python3
"""Offline checks for apollo-borrow (SQLite store, HTTP API, PIN gate, CSV export) and rocky-board's kiosk form.

  python3 apollo/test-apollo-borrow.py
"""
import importlib.machinery
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def load_script(name, filename):
    loader = importlib.machinery.SourceFileLoader(name, os.path.join(HERE, filename))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


borrow_mod = load_script("apollo_borrow", "apollo-borrow")
board_mod = load_script("rocky_board_borrow", "rocky-board")


def strip_ansi(line):
    return ANSI_RE.sub("", line)


def http_req(url, method="GET", payload=None, headers=None):
    hdrs = dict(headers or {})
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf8")
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


class BorrowServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="apollo-borrow-test-")
        self.store = borrow_mod.BorrowStore(self.tmp)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), borrow_mod.make_handler(self.store))
        self.port = self.server.server_address[1]
        self.base = f"http://127.0.0.1:{self.port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_web_ui_and_crud_and_partial_return_and_csv(self):
        code, html = http_req(self.base + "/")
        self.assertEqual(code, 200)
        self.assertIn(b"~apollo", html)
        self.assertIn(b"borrow-form", html)

        # Validation rejects missing fields
        code, body = http_req(self.base + "/api/loans", "POST", {"borrower": "Alex"})
        self.assertEqual(code, 400)
        self.assertIn("error", json.loads(body))

        # Create loan (web)
        code, body = http_req(
            self.base + "/api/loans", "POST",
            {"borrower": "Alex Rivera", "discord": "@alexr", "item": "M3 standoff", "qty": 5, "unit": "pcs", "notes": "=cmd()"},
            headers={"X-Forwarded-For": "10.16.26.99"},
        )
        self.assertEqual(code, 201)
        loan = json.loads(body)
        self.assertEqual(loan["discord"], "alexr")
        self.assertEqual(loan["qtyText"], "5")
        self.assertEqual(loan["source"], "web")

        # Snapshot exists and is world-readable
        snap_path = os.path.join(self.tmp, "borrow.json")
        self.assertEqual(stat.S_IMODE(os.stat(snap_path).st_mode), 0o644)
        snap = json.load(open(snap_path, encoding="utf8"))
        self.assertEqual(len(snap["active"]), 1)

        # Partial return: 2 of 5 returned -> 3 remaining
        code, body = http_req(self.base + f"/api/loans/{loan['id']}/return", "POST", {"qty": 2})
        self.assertEqual(code, 200)
        part = json.loads(body)
        self.assertEqual(part["remainingText"], "3")
        self.assertIsNone(part["returnedAt"])

        # Remaining full return
        code, body = http_req(self.base + f"/api/loans/{loan['id']}/return", "POST", {})
        self.assertEqual(code, 200)
        done = json.loads(body)
        self.assertEqual(done["remainingText"], "0")
        self.assertIsNotNone(done["returnedAt"])

        # CSV export escapes formula-leading cells
        code, csv_bytes = http_req(self.base + "/api/export.csv")
        self.assertEqual(code, 200)
        csv_text = csv_bytes.decode("utf8")
        self.assertIn("Alex Rivera", csv_text)
        self.assertIn("'=cmd()", csv_text)

    def test_optional_pin_blocks_proxied_web_but_allows_local_kiosk(self):
        with open(os.path.join(self.tmp, "pin"), "w", encoding="utf8") as f:
            f.write("4242\n")

        payload = {"borrower": "Sai", "discord": "sai", "item": "Crimper", "qty": 1, "unit": "pcs", "source": "kiosk"}
        # Proxied request without PIN -> 403
        code, _ = http_req(self.base + "/api/loans", "POST", payload, headers={"X-Forwarded-For": "10.16.26.55"})
        self.assertEqual(code, 403)
        # Proxied request with PIN -> 201 and forced source='web'
        code, body = http_req(
            self.base + "/api/loans", "POST", payload,
            headers={"X-Forwarded-For": "10.16.26.55", "X-Borrow-Pin": "4242"},
        )
        self.assertEqual(code, 201)
        self.assertEqual(json.loads(body)["source"], "web")

        # Direct loopback kiosk request (no X-Forwarded-For) -> 201 without PIN and source='kiosk'
        code, body = http_req(self.base + "/api/loans", "POST", payload)
        self.assertEqual(code, 201)
        self.assertEqual(json.loads(body)["source"], "kiosk")

    def test_kiosk_keyboard_borrow_and_return_flow(self):
        ui = board_mod.BorrowUI(api_base=self.base)
        snap_path = os.path.join(self.tmp, "borrow.json")
        read_snap = lambda: json.load(open(snap_path, encoding="utf8"))

        # Press B -> open Borrow form, type Name, Discord, Item, Qty (replace 1 with 3), Units (keep pcs)
        now = time.time()
        self.assertTrue(ui.handle_key(b"b", read_snap(), now=now))
        self.assertEqual(ui.mode, "borrow")

        for ch in b"Ish Patel\r@ish\rFluke multimeter\r\x7f3\r\r":
            ui.handle_key(bytes([ch]), read_snap(), now=now)

        # Submitted and closed cleanly with green confirmation flash
        self.assertIsNone(ui.mode)
        self.assertIsNotNone(ui.flash)
        self.assertIn("Fluke multimeter", ui.flash[0])

        snap = read_snap()
        self.assertEqual(len(snap["active"]), 1)
        self.assertEqual(snap["active"][0]["qtyText"], "3")
        self.assertEqual(snap["active"][0]["unit"], "pcs")
        self.assertEqual(snap["active"][0]["source"], "kiosk")

        # Render the borrow page on 114x32 in kiosk Latin-1 mode
        old_kiosk, old_borrow = board_mod.KIOSK, board_mod.BORROW
        board_mod.KIOSK, board_mod.BORROW = True, ui
        try:
            lines, npages = board_mod.frame(None, None, 0, 114, 32, borrow=snap, now=now)
            self.assertEqual(npages, 1)
            self.assertEqual(len(lines), 32)
            plain = "\n".join(strip_ansi(l) for l in lines)
            self.assertIn("BORROWED EQUIPMENT", plain)
            self.assertIn("Fluke multimeter", plain)
            self.assertIn("@ish", plain)
            for l in lines:
                p = strip_ansi(l)
                self.assertEqual(board_mod.width(p), 114)
                self.assertTrue(all(ord(c) < 256 for c in p))

            # Open Return overlay via R, render overlay, confirm with Enter + Enter
            ui.handle_key(b"r", snap, now=now)
            self.assertEqual(ui.mode, "return")
            ol_lines, _ = board_mod.frame(None, None, 0, 114, 32, borrow=snap, now=now)
            self.assertIn("RETURN AN ITEM", "\n".join(strip_ansi(l) for l in ol_lines))

            ui.handle_key(b"\r", snap, now=now)
            self.assertEqual(ui.mode, "confirm_return")
            ui.handle_key(b"\r", snap, now=now)
            self.assertIsNone(ui.mode)
            self.assertIn("RETURNED:", ui.flash[0])
        finally:
            board_mod.KIOSK, board_mod.BORROW = old_kiosk, old_borrow

        snap_after = read_snap()
        self.assertEqual(snap_after["active"], [])
        self.assertEqual(len(snap_after["recentReturned"]), 1)

        # Idle timeout closes an abandoned form
        ui.handle_key(b"b", snap_after, now=now)
        self.assertEqual(ui.mode, "borrow")
        ui.tick(now + board_mod.BORROW_IDLE_SECONDS + 1)
        self.assertIsNone(ui.mode)

    def test_once_cli_prints_borrow_page(self):
        self.store.create_loan({"borrower": "Alex", "discord": "alex", "item": "Oscilloscope", "qty": 1, "unit": "pcs"})
        env = dict(os.environ, ROCKY_BOARD_FILE=os.path.join(self.tmp, "missing-board.json"),
                   ROCKY_SPACE_FILE=os.path.join(self.tmp, "missing-space.json"),
                   ROCKY_BORROW_FILE=os.path.join(self.tmp, "borrow.json"))
        proc = subprocess.run([sys.executable, os.path.join(HERE, "rocky-board"), "--once"],
                              env=env, capture_output=True, text=True, check=True)
        plain = strip_ansi(proc.stdout)
        self.assertIn("BORROWED EQUIPMENT", plain)
        self.assertIn("Oscilloscope", plain)


if __name__ == "__main__":
    unittest.main(verbosity=2)
