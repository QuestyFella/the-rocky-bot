#!/usr/bin/env python3
"""Offline checks for apollo-sso (Gitea OAuth2/OIDC + PKCE, session cookies, nginx auth_request, borrow SSO).

  python3 apollo/test-apollo-sso.py
"""
import importlib.machinery
import importlib.util
import json
import os
import shutil
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.cookies import SimpleCookie
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))


def load_script(name, filename):
    loader = importlib.machinery.SourceFileLoader(name, os.path.join(HERE, filename))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


sso_mod = load_script("apollo_sso", "apollo-sso")
borrow_mod = load_script("apollo_borrow_sso", "apollo-borrow")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def req(url, method="GET", payload=None, headers=None):
    hdrs = dict(headers or {})
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf8")
        hdrs["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with OPENER.open(r, timeout=5) as resp:
            return resp.status, resp.headers, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def extract_cookies(headers):
    out = {}
    for raw in headers.get_all("Set-Cookie") or []:
        c = SimpleCookie()
        c.load(raw)
        for k, m in c.items():
            out[k] = m.value
    return out


class FakeGitea:
    def __init__(self):
        self.calls = []

    def exchange_and_userinfo(self, cfg, code, verifier):
        self.calls.append((code, verifier))
        if code == "bad":
            raise RuntimeError("invalid grant")
        return {
            "u": "qstyban",
            "n": "Ban Q",
            "g": ["University-of-Guelph-Rocketry-Club:Owners", "University-of-Guelph-Rocketry-Club:Members"],
        }


class SsoTests(unittest.TestCase):
    def setUp(self):
        self.cfg = {
            "client_id": "cid-123",
            "client_secret": "csec-xyz",
            "session_secret": "super-secret-signing-key",
            "gitea_public_url": "http://10.16.26.107/gitea",
            "gitea_internal_url": "http://127.0.0.1:3000",
            "redirect_uri": "http://10.16.26.107/sso/callback",
            "session_ttl": 3600,
        }
        self.gitea = FakeGitea()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), sso_mod.make_handler(lambda: self.cfg, gitea=self.gitea))
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_token_signing_and_open_redirect_guard(self):
        tok = sso_mod.sign_token({"u": "alex", "exp": time.time() + 60}, "k")
        self.assertEqual(sso_mod.verify_token(tok, "k")["u"], "alex")
        self.assertIsNone(sso_mod.verify_token(tok + "x", "k"))
        self.assertIsNone(sso_mod.verify_token(tok, "wrong"))
        expired = sso_mod.sign_token({"u": "alex", "exp": time.time() - 1}, "k")
        self.assertIsNone(sso_mod.verify_token(expired, "k"))

        self.assertEqual(sso_mod.safe_next("/borrow/"), "/borrow/")
        self.assertEqual(sso_mod.safe_next("https://evil.example"), "/")
        self.assertEqual(sso_mod.safe_next("//evil.example/x"), "/")

    def test_full_oauth2_pkce_login_verify_and_logout(self):
        # Unauthenticated /verify -> 401; optional=1 -> 200 with X-Apollo-SSO: 1 and empty user
        code, hdrs, _ = req(self.base + "/verify")
        self.assertEqual(code, 401)
        code, hdrs, _ = req(self.base + "/verify?optional=1")
        self.assertEqual(code, 200)
        self.assertEqual(hdrs.get("X-Apollo-SSO"), "1")
        self.assertEqual(hdrs.get("X-Apollo-User"), "")

        # /login sets signed state cookie and redirects to Gitea with PKCE S256
        code, hdrs, _ = req(self.base + "/login?next=/borrow/")
        self.assertEqual(code, 302)
        loc = hdrs.get("Location")
        self.assertTrue(loc.startswith("http://10.16.26.107/gitea/login/oauth/authorize?"))
        params = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query)
        self.assertEqual(params["code_challenge_method"], ["S256"])
        state = params["state"][0]
        st_cookie = extract_cookies(hdrs)[sso_mod.STATE_COOKIE]

        # Wrong state is rejected
        code, _, _ = req(f"{self.base}/callback?code=ok1&state=wrong", headers={"Cookie": f"{sso_mod.STATE_COOKIE}={st_cookie}"})
        self.assertEqual(code, 400)

        # Valid callback exchanges code + verifier, sets apollo_session cookie, redirects to /borrow/
        code, hdrs, _ = req(f"{self.base}/callback?code=ok1&state={state}", headers={"Cookie": f"{sso_mod.STATE_COOKIE}={st_cookie}"})
        self.assertEqual(code, 302)
        self.assertEqual(hdrs.get("Location"), "/borrow/")
        sess_cookie = extract_cookies(hdrs)[sso_mod.SESSION_COOKIE]
        self.assertEqual(len(self.gitea.calls), 1)
        self.assertEqual(sso_mod.pkce_challenge(self.gitea.calls[0][1]), params["code_challenge"][0])

        # /verify returns 200 with verified headers
        code, hdrs, _ = req(self.base + "/verify", headers={"Cookie": f"{sso_mod.SESSION_COOKIE}={sess_cookie}"})
        self.assertEqual(code, 200)
        self.assertEqual(hdrs.get("X-Apollo-User"), "qstyban")
        self.assertEqual(hdrs.get("X-Apollo-Name"), "Ban Q")
        self.assertEqual(hdrs.get("X-Apollo-Admin"), "1")

        # /whoami returns JSON
        code, _, body = req(self.base + "/whoami", headers={"Cookie": f"{sso_mod.SESSION_COOKIE}={sess_cookie}"})
        self.assertEqual(code, 200)
        who = json.loads(body)
        self.assertTrue(who["authenticated"] and who["admin"] and who["user"] == "qstyban")

        # /logout clears cookie
        code, hdrs, _ = req(self.base + "/logout?next=/borrow/")
        self.assertEqual(code, 302)
        self.assertEqual(hdrs.get("Location"), "/borrow/")
        self.assertEqual(extract_cookies(hdrs)[sso_mod.SESSION_COOKIE], "")

    def test_borrow_enforces_sso_when_enabled_but_allows_kiosk(self):
        tmp = tempfile.mkdtemp(prefix="apollo-borrow-sso-")
        store = borrow_mod.BorrowStore(tmp)
        bserver = ThreadingHTTPServer(("127.0.0.1", 0), borrow_mod.make_handler(store))
        bbase = f"http://127.0.0.1:{bserver.server_address[1]}"
        threading.Thread(target=bserver.serve_forever, daemon=True).start()
        try:
            payload = {"borrower": "Ban Q", "discord": "qstyban", "item": "Soldering iron", "qty": 1, "unit": "pcs"}
            # Proxied unauthenticated web write with X-Apollo-SSO: 1 -> 401
            code, _, _ = req(bbase + "/api/loans", "POST", payload,
                             headers={"X-Forwarded-For": "10.16.26.44", "X-Apollo-SSO": "1", "X-Apollo-User": ""})
            self.assertEqual(code, 401)
            # Proxied authenticated web write -> 201
            code, _, _ = req(bbase + "/api/loans", "POST", payload,
                             headers={"X-Forwarded-For": "10.16.26.44", "X-Apollo-SSO": "1", "X-Apollo-User": "qstyban"})
            self.assertEqual(code, 201)
            # Direct loopback kiosk write -> 201 without SSO
            code, _, _ = req(bbase + "/api/loans", "POST", dict(payload, source="kiosk"))
            self.assertEqual(code, 201)
        finally:
            bserver.shutdown()
            bserver.server_close()
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
