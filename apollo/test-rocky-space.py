#!/usr/bin/env python3
"""Offline checks for rocky-space-export (SGP4 pass prediction, feeds, caching) and rocky-board's space page.

  python3 apollo/test-rocky-space.py
"""
import importlib.machinery
import importlib.util
import json
import math
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def load_script(name, filename):
    loader = importlib.machinery.SourceFileLoader(name, os.path.join(HERE, filename))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


space_exp = load_script("rocky_space_export", "rocky-space-export")
board_mod = load_script("rocky_board", "rocky-board")

# Official Spacetrack Report #3 SGP4 test case (Satellite 88888)
TLE_88888 = (
    "1 88888U          80275.98708465  .00073094  13844-3  66816-4 0    87",
    "2 88888  72.8435 115.9689 0086731  52.6988 110.5714 16.05824518  1058",
)
# Real ISS & Tiangong TLEs captured from CelesTrak on 2026-11-27
ISS_TLE = (
    "ISS (ZARYA)\n"
    "1 25544U 98067A   26331.39543039  .00005227  00000+0  10075-3 0  9992\n"
    "2 25544  51.6311 212.4074 0007387  70.5574 289.6212 15.49633135597058\n"
)
CSS_TLE = (
    "CSS (TIANHE)\n"
    "1 48274U 21035A   26331.55776823  .00010374  00000+0  12949-3 0  9996\n"
    "2 48274  41.4711  49.1353 0009789 305.1998  54.7923 15.59774432318681\n"
)
SAMPLE_SOLAR_XML = b"""<?xml version="1.0" encoding="UTF-8" ?>
<solar>
  <solardata>
    <source url="http://www.hamqsl.com/solar.html">N0NBH</source>
    <updated> 27 Nov 2026 1826 GMT</updated>
    <solarflux>87</solarflux>
    <aindex> 4</aindex>
    <kindex> 0</kindex>
    <xray>B2.9</xray>
    <sunspots>26</sunspots>
    <aurora> 1</aurora>
    <latdegree>67.5</latdegree>
    <solarwind>354.0</solarwind>
    <magneticfield>  6.1</magneticfield>
    <calculatedconditions>
      <band name="80m-40m" time="day">Good</band>
      <band name="30m-20m" time="day">Fair</band>
      <band name="17m-15m" time="day">Poor</band>
      <band name="12m-10m" time="day">Poor</band>
      <band name="80m-40m" time="night">Good</band>
      <band name="30m-20m" time="night">Fair</band>
      <band name="17m-15m" time="night">Poor</band>
      <band name="12m-10m" time="night">Poor</band>
    </calculatedconditions>
    <calculatedvhfconditions>
      <phenomenon name="vhf-aurora" location="northern_hemi">Band Closed</phenomenon>
      <phenomenon name="E-Skip" location="north_america">Band Closed</phenomenon>
    </calculatedvhfconditions>
    <geomagfield>INACTIVE</geomagfield>
    <signalnoise>S0-S1</signalnoise>
    <muf>NoRpt</muf>
  </solardata>
</solar>"""

FIXED_NOW = datetime(2026, 11, 27, 18, 30, 0, tzinfo=timezone.utc).timestamp()

SAMPLE_NEWS = {
    "results": [
        {"title": "Governments Invest $71.8B in Space Defense", "news_site": "SpaceNews", "published_at": "2026-11-27T15:35:22Z"},
        {"title": "Artemis III Astronaut’s VAB Visit — Engine Check", "news_site": "NASA", "published_at": "2026-11-27T14:00:00Z"},
    ]
}
SAMPLE_LAUNCHES = {
    "results": [
        # Already launched (status id 3 = Success): must be filtered out
        {"name": "Electron | Already Launched", "lsp_name": "Rocket Lab", "location": "Mahia, NZ",
         "net": "2026-11-27T18:00:00Z", "status": {"id": 3, "abbrev": "Success"}},
        # Past launch (> 1h ago): must be filtered out
        {"name": "Old Rocket | Past", "lsp_name": "OldCo", "location": "Somewhere",
         "net": "2026-11-27T16:00:00Z", "status": {"id": 1, "abbrev": "Go"}},
        # Upcoming valid launches
        {"name": "Falcon 9 Block 5 | USSF-380", "lsp_name": "SpaceX", "location": "Vandenberg SFB, CA, USA",
         "net": "2026-11-29T04:39:00Z", "status": {"id": 1, "abbrev": "Go"}},
        {"name": "Long March 6C | Test Sat", "lsp_name": "China Aerospace Science and Technology Corporation",
         "location": "Taiyuan, China", "net": "2026-11-29T03:50:00Z", "status": {"id": 8, "abbrev": "TBC"}},
    ]
}

SAMPLE_BOARD = {
    "title": "UofG Rocketry Board",
    "generatedAt": datetime.fromtimestamp(FIXED_NOW - 10, tz=timezone.utc).isoformat(timespec="seconds"),
    "counts": {"ready": 2, "progress": 1, "waiting": 0, "done": 5},
    "inProgress": [{"key": "RCK-1", "tag": "RADIO", "title": "Tune ground station antenna", "owners": ["Sai"], "due": None, "overdue": False}],
    "categories": [{"name": "POWER", "ready": [{"key": "RCK-2", "tag": "POWER", "title": "Test battery pack", "owners": [], "due": "1 Dec 2026", "overdue": False}], "waiting": 0}],
    "boards": [],
}
SAMPLE_BOARD["boards"] = [dict(SAMPLE_BOARD, name="main")]


def strip_ansi(line):
    return ANSI_RE.sub("", line)


def fake_fetcher(url):
    if "CATNR=25544" in url:
        return ISS_TLE.encode("utf8")
    if "CATNR=48274" in url:
        return CSS_TLE.encode("utf8")
    if "hamqsl.com" in url:
        return SAMPLE_SOLAR_XML
    if "spaceflightnewsapi.net" in url:
        return json.dumps(SAMPLE_NEWS).encode("utf8")
    if "thespacedevs.com" in url:
        return json.dumps(SAMPLE_LAUNCHES).encode("utf8")
    raise AssertionError(f"unexpected URL: {url}")


class Sgp4Tests(unittest.TestCase):
    def test_spacetrack_report_3_reference_vector(self):
        sat = space_exp.sgp4_init(*TLE_88888)
        expected = {
            0: (2328.97048951, -5995.22076416, 1719.97067261),
            360: (2456.10705566, -6071.93853760, 1222.89727783),
            720: (2567.56195068, -6112.50384521, 713.96397400),
            1080: (2663.09078979, -6115.48229980, 196.39640808),
            1440: (2742.55133057, -6079.67144775, -326.38095093),
        }
        for tsince, exp in expected.items():
            got = space_exp.sgp4_pos_teme(sat, tsince)
            err_km = math.sqrt(sum((a - b) ** 2 for a, b in zip(got, exp)))
            self.assertLess(err_km, 0.02, f"t={tsince}: err={err_km} km")

    def test_guelph_iss_and_tiangong_passes(self):
        for raw in (ISS_TLE, CSS_TLE):
            tle = space_exp.parse_tle_text(raw)
            epoch_iso, passes = space_exp.predict_passes(tle, 43.5327, -80.2262, 335, now=FIXED_NOW, days=3)
            self.assertTrue(epoch_iso.startswith("2026-11-27T"))
            self.assertGreater(len(passes), 4)
            for p in passes:
                self.assertLess(p["aos"], p["tca"])
                self.assertLess(p["tca"], p["los"])
                self.assertGreaterEqual(p["maxEl"], 10)
                self.assertLessEqual(p["maxEl"], 90)
                self.assertGreaterEqual(p["los"] - p["aos"], 120)
                self.assertLessEqual(p["los"] - p["aos"], 900)
                self.assertTrue(0 <= p["aosAz"] < 360 and 0 <= p["losAz"] < 360)
            self.assertTrue(any(p["visible"] for p in passes), "should find at least one visible twilight pass")


class ExporterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="rocky-space-test-")
        self.out = os.path.join(self.tmp, "space.json")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_parsers(self):
        solar = space_exp.parse_solar_xml(SAMPLE_SOLAR_XML)
        self.assertEqual(solar["sfi"], "87")
        self.assertEqual(solar["kIndex"], "0")
        self.assertEqual(solar["xray"], "B2.9")
        self.assertEqual(solar["geomag"], "INACTIVE")
        self.assertEqual(len(solar["hfBands"]), 4)
        self.assertEqual(solar["hfBands"][0], {"band": "80m-40m", "day": "Good", "night": "Good"})
        self.assertEqual(solar["vhf"], {"aurora": "Band Closed", "eSkipNA": "Band Closed"})

        launches = space_exp.parse_launches_json(SAMPLE_LAUNCHES, now=FIXED_NOW)
        self.assertEqual([l["name"] for l in launches], ["Long March 6C | Test Sat", "Falcon 9 Block 5 | USSF-380"])

    def test_export_cache_and_resilience(self):
        calls = []

        def tracked_fetch(url):
            calls.append(url)
            return fake_fetcher(url)

        snap = space_exp.export_once(out_path=self.out, now=FIXED_NOW, fetcher=tracked_fetch)
        self.assertEqual(snap["errors"], {})
        self.assertEqual(len(calls), 5)
        self.assertEqual(stat.S_IMODE(os.stat(self.out).st_mode), 0o644)
        self.assertEqual(len(snap["satellites"]), 2)
        self.assertGreater(len(snap["satellites"][0]["passes"]), 5)

        # 5 minutes later: nothing should be re-fetched (all within TTL), passes still populated
        calls.clear()
        snap2 = space_exp.export_once(out_path=self.out, now=FIXED_NOW + 300, fetcher=tracked_fetch)
        self.assertEqual(calls, [])
        self.assertEqual(snap2["solar"]["sfi"], "87")

        # 1 hour later, all upstreams fail: cached data is preserved and errors are recorded
        def failing_fetch(url):
            raise OSError("network down")

        snap3 = space_exp.export_once(out_path=self.out, now=FIXED_NOW + 3600, fetcher=failing_fetch)
        self.assertIn("solar", snap3["errors"])
        self.assertIn("news", snap3["errors"])
        self.assertIn("launches", snap3["errors"])
        self.assertEqual(snap3["solar"]["sfi"], "87")
        self.assertEqual(len(snap3["news"]["items"]), 2)
        self.assertGreater(len(snap3["satellites"][0]["passes"]), 5, "TLEs stay cached and re-propagate offline")


class BoardRenderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="rocky-board-test-")
        self.space_path = os.path.join(self.tmp, "space.json")
        self.board_path = os.path.join(self.tmp, "board.json")
        self.space = space_exp.export_once(out_path=self.space_path, now=FIXED_NOW, fetcher=fake_fetcher)
        with open(self.board_path, "w", encoding="utf8") as f:
            json.dump(SAMPLE_BOARD, f)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_backwards_compatible_without_space(self):
        lines, npages = board_mod.frame(SAMPLE_BOARD, None, 0, 114, 32, space=None, space_err=None, now=FIXED_NOW)
        self.assertEqual(npages, 1)
        plain = "\n".join(strip_ansi(l) for l in lines)
        self.assertIn("UOFG ROCKETRY BOARD", plain)
        self.assertNotIn("SPACE DASHBOARD", plain)

    def test_apollo_monitor_layout_114x32(self):
        # Page 0 = main board, Page 1 = space dashboard (single 2-column page on 114x32!)
        lines0, npages = board_mod.frame(SAMPLE_BOARD, None, 0, 114, 32, space=self.space, now=FIXED_NOW)
        self.assertEqual(npages, 2)
        self.assertEqual(len(lines0), 32)
        self.assertIn("space", strip_ansi(lines0[-1]))

        lines1, npages1 = board_mod.frame(SAMPLE_BOARD, None, 1, 114, 32, space=self.space, now=FIXED_NOW)
        self.assertEqual(npages1, 2)
        self.assertEqual(len(lines1), 32)
        for line in lines1:
            self.assertEqual(board_mod.width(strip_ansi(line)), 114)
        plain = "\n".join(strip_ansi(l) for l in lines1)
        for expected in ("SPACE DASHBOARD", "STATION PASSES", "ISS (ZARYA)", "TIANGONG (CSS)",
                         "HF PROPAGATION", "SFI 87", "80m-40m", "SPACE NEWS",
                         "UPCOMING LAUNCHES", "CASC", "Vandenberg SFB, CA"):
            self.assertIn(expected, plain)

    def test_overhead_now_and_stale_warning(self):
        first_iss = self.space["satellites"][0]["passes"][0]
        mid = (first_iss["aos"] + first_iss["los"]) // 2
        lines, _ = board_mod.frame(SAMPLE_BOARD, None, 1, 114, 32, space=self.space, now=mid)
        plain = "\n".join(strip_ansi(l) for l in lines)
        self.assertIn("OVERHEAD NOW!", plain)
        self.assertIn("LOS in", plain)

        # Stale space snapshot (> 60 min old)
        lines_stale, _ = board_mod.frame(SAMPLE_BOARD, None, 1, 114, 32, space=self.space, now=FIXED_NOW + 5400)
        plain_stale = "\n".join(strip_ansi(l) for l in lines_stale)
        self.assertIn("Space data is 90 min old", plain_stale)

    def test_narrow_and_wide_and_kiosk_latin1(self):
        old_kiosk = board_mod.KIOSK
        board_mod.KIOSK = True
        try:
            for w, h in ((80, 24), (114, 32), (180, 40)):
                lines, npages = board_mod.frame(SAMPLE_BOARD, None, 1, w, h, space=self.space, now=FIXED_NOW)
                self.assertGreaterEqual(npages, 2)
                self.assertEqual(len(lines), h)
                for line in lines:
                    plain = strip_ansi(line)
                    self.assertEqual(board_mod.width(plain), w)
                    self.assertTrue(all(ord(ch) < 256 for ch in plain), f"non-Latin-1 char in kiosk mode: {plain!r}")
                if (w, h) == (114, 32):
                    full = "\n".join(strip_ansi(l) for l in lines)
                    self.assertIn("Astronaut's VAB", full)
        finally:
            board_mod.KIOSK = old_kiosk

    def test_once_cli_prints_board_and_space(self):
        env = dict(os.environ, ROCKY_BOARD_FILE=self.board_path, ROCKY_SPACE_FILE=self.space_path)
        proc = subprocess.run([sys.executable, os.path.join(HERE, "rocky-board"), "--once"],
                              env=env, capture_output=True, text=True, check=True)
        plain = strip_ansi(proc.stdout)
        self.assertIn("UOFG ROCKETRY BOARD", plain)
        self.assertIn("SPACE DASHBOARD", plain)
        self.assertIn("HF PROPAGATION", plain)
        self.assertIn("SPACE NEWS", plain)
        self.assertLess(len(proc.stdout.splitlines()), 120, "--once should not emit thousands of trailing blank lines")


if __name__ == "__main__":
    unittest.main(verbosity=2)
