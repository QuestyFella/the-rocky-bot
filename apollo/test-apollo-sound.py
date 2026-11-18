#!/usr/bin/env python3
"""Checks for apollo-sound, with fake aplay, espeak-ng, yt-dlp and mpv (no speakers or network needed).

  python3 apollo/test-apollo-sound.py
"""
import array
import importlib.machinery
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import textwrap
import threading
import time
import unittest
import wave
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="apollo-sound-test-")
SOUND_DIR, ROOM_DIR, BIN = (os.path.join(TMP, d) for d in ("sound", "room", "bin"))
LOG = os.path.join(TMP, "calls.log")
for d in (SOUND_DIR, ROOM_DIR, BIN):
    os.makedirs(d)

# Both voices write half a second of speech at about espeak's level (peak 15000), as a mono 16-bit WAV.
SPEECH = """
    import array, math, wave
    def speech(out):
        with wave.open(out, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(22050)
            w.writeframes(array.array("h", (int(15000 * math.sin(i / 10)) for i in range(11025))).tobytes())
"""
FAKES = {
    "aplay": """
        log("aplay", os.path.basename(sys.argv[-1]))
        time.sleep(60 if "freeze" in sys.argv[-1] else 0.3)     # like aplay on apollo, now and then
    """,
    "espeak-ng": SPEECH + """
    log("espeak", sys.stdin.read())
    speech(sys.argv[sys.argv.index("-w") + 1])
    """,
    "piper-tts": SPEECH + """
    text = sys.stdin.read()
    log("piper", text, os.path.basename(sys.argv[sys.argv.index("--model") + 1]))
    if "piperfail" in text: sys.exit(1)
    speech(sys.argv[sys.argv.index("--output_file") + 1])
    """,
    "yt-dlp": """
        query = sys.argv[-1]
        log("yt-dlp", query)
        if "nothing" in query: sys.exit(0)
        if "broken" in query: sys.stderr.write("ERROR: YouTube said no\\n"); sys.exit(1)
        if "toolong" in query: print("4000\\thttps://www.youtube.com/watch?v=long\\tA Very Long Mix")
        elif "live" in query: print("NA\\thttps://www.youtube.com/watch?v=live\\tLive Radio")
        elif "sneaky" in query: print("100\\thttp://127.0.0.1:3000/\\tNot YouTube")
        else: print("212\\thttps://www.youtube.com/watch?v=" + query.split(":")[-1].replace(" ", "_") + "\\tSong " + query.split(":")[-1])
    """,
    # Logs what it plays and every IPC command (pause / resume) until it's stopped or 8 s pass.
    "mpv": """
        import signal, socket
        url = sys.argv[-1]
        sock = next(a.split("=", 1)[1] for a in sys.argv if a.startswith("--input-ipc-server="))
        log("mpv", url, next(a for a in sys.argv if a.startswith("--pause=")))
        signal.signal(signal.SIGTERM, lambda *_: (log("mpv-stopped", url), sys.exit(0)))
        try: os.remove(sock)
        except OSError: pass
        server = socket.socket(socket.AF_UNIX); server.bind(sock); server.listen(); server.settimeout(0.1)
        end = time.time() + 8
        while time.time() < end:
            try: conn, _ = server.accept()
            except socket.timeout: continue
            with conn: log("mpv-ipc", conn.recv(1000).decode().strip())
        log("mpv-done", url)
    """,
}
for name, body in FAKES.items():
    path = os.path.join(BIN, name)
    with open(path, "w") as f:
        f.write("#!" + sys.executable + "\nimport os, sys, time\n"
                f"def log(*a):\n    open({LOG!r}, 'a').write(' | '.join(a) + '\\n')\n" + textwrap.dedent(body))
    os.chmod(path, 0o755)

VOICE = os.path.join(TMP, "voice.onnx")
open(VOICE, "w").close()
os.environ.update(PATH=BIN + os.pathsep + os.environ["PATH"], APOLLO_SOUND_DIR=SOUND_DIR, ROCKY_ROOM_DIR=ROOM_DIR,
                  APOLLO_PIPER=os.path.join(BIN, "piper-tts"), APOLLO_PIPER_VOICE=VOICE)
loader = importlib.machinery.SourceFileLoader("apollo_sound", os.path.join(HERE, "apollo-sound"))
spec = importlib.util.spec_from_loader("apollo_sound", loader)
sound = importlib.util.module_from_spec(spec)
loader.exec_module(sound)


def calls(kind=None):
    try:
        lines = [l.rstrip("\n").split(" | ") for l in open(LOG)]
    except FileNotFoundError:
        return []
    return [l for l in lines if kind is None or l[0] == kind]


def wait_for(check, seconds=5):
    end = time.time() + seconds
    while time.time() < end:
        value = check()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError("timed out waiting")


def state():
    return sound.read_json(sound.STATE_FILE) or {}


def result(request_id):
    return wait_for(lambda: next((r for r in state().get("results", []) if r["id"] == request_id), None))


sequence = 0


def request(kind, **fields):
    global sequence
    sequence += 1
    request_id = f"r{sequence}"
    sound.write_json(os.path.join(sound.REQUEST_DIR, f"{int(time.time() * 1000)}-{request_id}.json"),
                     {"id": request_id, "type": kind, **fields})
    return request_id


def buzz(buzz_id, ago=0):
    at = (datetime.now(timezone.utc) - timedelta(seconds=ago)).isoformat().replace("+00:00", "Z")
    sound.write_json(os.path.join(ROOM_DIR, "buzz.json"), {"id": buzz_id, "name": "Sai", "note": "", "at": at})


class Tunes(unittest.TestCase):
    def test_timing_matches_the_doorbell(self):
        # The doorbell's README: Money takes 6.364 s and Starless 5.139 s.
        total = lambda name: round(sum(d for _, _, d in sound.tune_notes(*sound.TUNES[name])), 3)
        self.assertEqual(total("Money"), 6.364)
        self.assertEqual(total("Starless"), 5.139)
        self.assertEqual(len(sound.TUNES), 8)
        for bpm, notes in sound.TUNES.values():
            self.assertTrue(all(s <= d for _, s, d in sound.tune_notes(bpm, notes)))

    def test_a_frozen_aplay_is_stopped_soon_after_the_sound_should_end(self):
        path = os.path.join(TMP, "freeze.wav")
        sound.save_wav(path, array.array("h", bytes(2 * 11025)), 22050)      # half a second
        started = time.time()
        sound.play_file(path, 60)
        self.assertLess(time.time() - started, 5)

    def test_only_youtube_links(self):
        for good in ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ",
                     "https://music.youtube.com/watch?v=x"):
            self.assertEqual(sound.youtube_url(good), good)
        for bad in ("never gonna give you up", "http://127.0.0.1:3000/", "file:///etc/passwd",
                    "https://evil.example/youtube.com", "https://youtube.com.evil.example/x", "http://[::1"):
            self.assertIsNone(sound.youtube_url(bad))


class Speakers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        buzz("before-start")                       # already there when apollo-sound starts: never rings
        threading.Thread(target=sound.Speakers().run, daemon=True).start()
        wait_for(lambda: state().get("updatedAt"), 30)
        cls.tunes = {os.path.basename(p) for p in os.listdir(os.path.join(SOUND_DIR, "tunes"))}

    def test_1_buzz_plays_a_tune_but_never_an_old_one(self):
        self.assertEqual(len(self.tunes), 8)
        buzz("old", ago=300)
        time.sleep(0.6)
        self.assertEqual(calls("aplay"), [])
        buzz("b1")
        first = wait_for(lambda: calls("aplay"))[0][1]
        self.assertIn(first, self.tunes)
        buzz("b2")
        second = wait_for(lambda: calls("aplay")[1:])[0][1]
        self.assertNotEqual(first, second, "never the same tune twice in a row")

    def test_2_say(self):
        said = lambda: [c for c in calls("aplay") if c[1] == "say.wav"]
        request("say", text="Sai says:   the   pizza is here")
        wait_for(lambda: said())
        self.assertEqual(calls("piper"), [["piper", "Sai says: the pizza is here", "voice.onnx"]])
        self.assertEqual(calls("espeak"), [], "piper's voice when it's installed")
        request("say", text="piperfail")
        wait_for(lambda: said()[1:])
        self.assertEqual(calls("espeak"), [["espeak", "piperfail"]], "espeak still says it if piper fails")
        os.remove(VOICE)
        request("say", text="no piper here")
        wait_for(lambda: said()[2:])
        self.assertEqual((len(calls("piper")), calls("espeak")[-1]), (2, ["espeak", "no piper here"]), "espeak without the voice")
        # What plays: silence while the sound chip wakes, a chime, then the speech turned up.
        with wave.open(os.path.join(SOUND_DIR, "say.wav")) as w:
            rate, samples = w.getframerate(), array.array("h", w.readframes(w.getnframes()))
        wake = int(rate * sound.WAKE_SECONDS)
        self.assertEqual(max(map(abs, samples[:wake])), 0)
        self.assertGreater(max(map(abs, samples[wake:wake + rate // 10])), 10000, "the chime")
        speech = samples[-11025:]
        self.assertAlmostEqual(max(map(abs, speech)), sound.SPEECH_PEAK, delta=50)
        rms = (sum(x * x for x in speech) / len(speech)) ** 0.5
        self.assertGreater(rms, 0.85 * sound.SPEECH_PEAK, "compressed: far louder on average than a plain sine at that peak (0.71)")
        with wave.open(os.path.join(SOUND_DIR, "tunes", "money.wav")) as w:
            self.assertEqual(max(map(abs, array.array("h", w.readframes(int(w.getframerate() * sound.WAKE_SECONDS))))), 0)

    def test_3_play_queue_skip_and_pause(self):
        time.sleep(0.6)                            # the last !say finishes, or the song would start paused
        first = request("play", query="rick", by="Sai", byId="discord:1")
        self.assertEqual(result(first), {**result(first), "ok": True, "title": "Song rick", "duration": 212, "ahead": 0})
        wait_for(lambda: calls("mpv"))
        self.assertEqual(calls("mpv")[-1][1:], ["https://www.youtube.com/watch?v=rick", "--pause=no"])
        self.assertEqual(state()["playing"]["title"], "Song rick")
        # Three more each: the fourth is one too many for one person.
        ids = [request("play", query=f"song{n}", by="Ish", byId="irc:ish") for n in range(4)]
        answers = [result(i) for i in ids]
        self.assertEqual([a.get("ahead") for a in answers[:3]], [1, 2, 3])
        self.assertEqual(answers[3]["error"], "too-many")
        self.assertEqual([s["title"] for s in state()["queue"]], ["Song song0", "Song song1", "Song song2"])
        # A buzz pauses the song and resumes it afterwards.
        buzz("b3")
        wait_for(lambda: [c for c in calls("mpv-ipc") if '"pause", false' in c[1]])
        self.assertIn('"pause", true', calls("mpv-ipc")[0][1])
        # Skipping: only the song that's playing.
        self.assertIs(result(request("skip", songId="nope"))["ok"], False)
        self.assertIs(result(request("skip", songId=first))["ok"], True)
        wait_for(lambda: calls("mpv-stopped"))
        wait_for(lambda: (state().get("playing") or {}).get("title") == "Song song0")

    def test_4_lookups_that_fail(self):
        self.assertEqual(result(request("play", query="nothing at all", byId="x"))["error"], "not-found")
        self.assertEqual(result(request("play", query="broken", byId="x"))["error"], "failed")
        self.assertEqual(result(request("play", query="live", byId="x"))["error"], "live")
        self.assertEqual(result(request("play", query="sneaky", byId="x"))["error"], "not-found")
        long = result(request("play", query="toolong", byId="x"))
        self.assertEqual((long["error"], long["duration"]), ("too-long", 4000))
        # A link to anything but YouTube is searched for as words, never fetched.
        request("play", query="http://127.0.0.1:3000/admin", byId="x")
        wait_for(lambda: [c for c in calls("yt-dlp") if "127.0.0.1" in c[1]])
        self.assertEqual([c for c in calls("yt-dlp") if "127.0.0.1" in c[1]][-1][1], "ytsearch1:http://127.0.0.1:3000/admin")


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
