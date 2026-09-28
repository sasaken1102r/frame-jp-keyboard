#!/usr/bin/env python3
"""Inject the frame-jp-keyboard bundle into Steam's SharedJSContext over the Chrome DevTools Protocol.

Runs on the Steam Frame as a systemd --user service (stdlib + aiohttp only).

Every 2 s it looks up the SharedJSContext target on http://127.0.0.1:8080/json. When the target
is new (Steam restarted) or window.__fjk is missing (the context reloaded), it evaluates the bundle.
CDP being unreachable or Steam restarting is normal: it waits with backoff and tries again.
Console lines starting with "[fjk]" are forwarded to stdout (journald).

It also serves kana-kanji conversion to the page with libanthy (see Anthy below) through a CDP
binding named fjkAnthy, so the keyboard does not depend on IBus.

And it drives frame-updater (vendor/frame-updater, copied next to this script as frame-update.sh
and frame_update.py): a forced check/install requested from the page (see src/update.js) arrives
through a second binding, fjkUpdateBridge, and the automatic check runs at connect and at most hourly
(frame-update.sh's own cache limits the actual GitHub call to once a day; see maybe_auto_check()).

Usage:
  frame_jp_keyboard_injector.py [--bundle PATH] [--once] [--devtools URL] [--no-console] [--anthy-selftest]
"""
from __future__ import annotations

import argparse
import asyncio
import ctypes
import itertools
import json
import os
import sys
import time
from pathlib import Path
from typing import Awaitable, Callable

import aiohttp

try:
    # Vendored from frame-updater and installed next to this script by install.sh; see
    # vendor/frame-updater/python/frame_update.py. Optional: an older or partial install without it
    # just runs without the update feature (fails safe, like everything else in this file).
    from frame_update import Updater
except ImportError:
    Updater = None  # type: ignore[assignment,misc]

DEFAULT_DEVTOOLS = "http://127.0.0.1:8080"
DEFAULT_BUNDLE = Path.home() / ".local/share/frame-jp-keyboard/bundle.js"
TARGET_TITLE = "SharedJSContext"
POLL_SECONDS = 2.0
MAX_BACKOFF_SECONDS = 30.0
CALL_TIMEOUT_SECONDS = 15.0
CHECK_EXPRESSION = "typeof window.__fjk === 'object' && window.__fjk !== null"
STATUS_EXPRESSION = "window.__fjk ? `${window.__fjk.version} (${window.__fjk.state})` : 'missing'"

# --- Update checks (frame-updater) ------------------------------------------------------------
UPDATE_APP = "frame-jp-keyboard"
UPDATE_REPO = "sasaken1102r/frame-jp-keyboard"
UPDATE_ASSET = "frame-jp-keyboard-{version}.tar.gz"
# The page -> injector CDP binding for update requests (Runtime.addBinding); see main.js's bridgeSend.
UPDATE_BINDING_NAME = "fjkUpdateBridge"
# How often we retry the automatic check while connected. frame-update.sh's own ~24h cache (see
# frame-updater/README.md) is what actually limits GitHub calls to about once a day; this just
# means a Steam restart or a long-running session notices a new release reasonably soon.
AUTO_RECHECK_SECONDS = 3600.0
# Read from the page's own settings (fjk.settings.updateCheck; see src/settings.js), defaulting to
# on. The forced check the page sends when the indicator is tapped ignores this setting entirely.
UPDATE_CHECK_ENABLED_EXPRESSION = (
    "(() => { try { const s = JSON.parse(localStorage.getItem('fjk.settings') || '{}'); "
    "return s.updateCheck !== false; } catch { return true; } })()"
)


def read_version() -> str:
    """This build's version, from the VERSION file installed next to this script (see scripts/build.js
    and scripts/package.js); 'dev' when running from a checkout that never ran `npm run build`."""
    try:
        text = (Path(__file__).resolve().parent / "VERSION").read_text(encoding="utf-8").strip()
        return text or "dev"
    except OSError:
        return "dev"


def steam_language() -> str:
    """Steam's language setting: the first "language" value in ~/.steam/registry.vdf, read only
    (e.g. "japanese"). Same file and format the other Frame apps' panels read."""
    home = os.environ.get("HOME", "")
    if not home:
        return ""
    try:
        with open(os.path.join(home, ".steam", "registry.vdf"), encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if '"language"' not in line:
                    continue
                # Format: <tab>"language"<tab>"japanese"
                parts = line.split('"')
                try:
                    return parts[parts.index("language") + 2]
                except (ValueError, IndexError):
                    return ""
    except OSError:
        return ""
    return ""


def detect_language() -> str:
    """'ja' or 'en' for the update banner: Steam's language if readable, else LC_ALL/LC_MESSAGES/LANG,
    else English. This keyboard has no language setting of its own (see main.js's LANG constant)."""
    steam = steam_language()
    if steam:
        return "ja" if steam == "japanese" else "en"
    for name in ("LC_ALL", "LC_MESSAGES", "LANG"):
        value = os.environ.get(name, "")
        if value:
            return "ja" if value.lower().startswith("ja") else "en"
    return "en"


# Looked up once at start, like the C++ panels' systemLanguage() (frame-updater/cpp/update_check.cpp).
LANG = detect_language()


class Log:
    """Print concise lines for journald, suppressing repeats of the same state message."""

    def __init__(self) -> None:
        self._last_state: str | None = None

    def info(self, message: str) -> None:
        print(message, flush=True)

    def state(self, message: str) -> None:
        """Print a state message only when it differs from the previous one."""
        if message != self._last_state:
            self._last_state = message
            print(message, flush=True)

    def clear_state(self) -> None:
        self._last_state = None


log = Log()


class CdpError(Exception):
    pass


class CdpSession:
    """A minimal CDP client over one websocket: request/response, console forwarding, and the
    Runtime.addBinding channels for page -> injector calls (ANTHY_BINDING_NAME, UPDATE_BINDING_NAME)."""

    def __init__(self, ws: aiohttp.ClientWebSocketResponse, forward_console: bool,
                 on_update: Callable[[str], Awaitable[None]] | None = None) -> None:
        self._ws = ws
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future] = {}
        self._forward_console = forward_console
        self._on_update = on_update
        self._connected_ms = time.time() * 1000
        self._tasks: set = set()
        self._reader = asyncio.create_task(self._read())

    @property
    def closed(self) -> bool:
        return self._reader.done()

    async def _read(self) -> None:
        try:
            async for message in self._ws:
                if message.type != aiohttp.WSMsgType.TEXT:
                    if message.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.ERROR):
                        break
                    continue
                data = json.loads(message.data)
                if "id" in data:
                    future = self._pending.pop(data["id"], None)
                    if future and not future.done():
                        future.set_result(data)
                elif data.get("method") == "Runtime.consoleAPICalled" and self._forward_console:
                    self._on_console(data.get("params", {}))
                elif data.get("method") == "Runtime.bindingCalled":
                    self._on_binding_called(data.get("params", {}))
        finally:
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(CdpError("websocket closed"))
            self._pending.clear()

    def _on_console(self, params: dict) -> None:
        # Runtime.enable replays old messages; only show ones logged after we connected.
        if params.get("timestamp", 0) < self._connected_ms - 1000:
            return
        parts = []
        for arg in params.get("args", []):
            if "value" in arg:
                value = arg["value"]
                parts.append(value if isinstance(value, str) else json.dumps(value, ensure_ascii=False))
            else:
                parts.append(arg.get("description") or arg.get("type", "?"))
        text = " ".join(parts)
        if text.startswith("[fjk]"):
            level = params.get("type", "log")
            log.info(f"js {level}: {text}" if level != "log" else f"js: {text}")

    def _on_binding_called(self, params: dict) -> None:
        """Route one page -> injector call by binding name. Each is served in its own task: the
        reply is a CDP call answered by this same reader."""
        name = params.get("name")
        if name == ANTHY_BINDING_NAME:
            self.spawn(serve_binding(self, params))
        elif name == UPDATE_BINDING_NAME and self._on_update:
            self.spawn(self._on_update(params.get("payload", "")))

    def spawn(self, coroutine: Awaitable[None]) -> None:
        """Run a coroutine in a task that this session keeps a reference to until it finishes."""
        task = asyncio.ensure_future(coroutine)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def add_binding(self, name: str) -> None:
        await self.call("Runtime.addBinding", {"name": name})

    async def call(self, method: str, params: dict | None = None) -> dict:
        if self.closed:
            raise CdpError("websocket closed")
        message_id = next(self._ids)
        future = asyncio.get_running_loop().create_future()
        self._pending[message_id] = future
        await self._ws.send_json({"id": message_id, "method": method, "params": params or {}})
        reply = await asyncio.wait_for(future, CALL_TIMEOUT_SECONDS)
        if "error" in reply:
            raise CdpError(f"{method}: {reply['error'].get('message', reply['error'])}")
        return reply.get("result", {})

    async def evaluate(self, expression: str) -> object:
        result = await self.call("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": False,
        })
        if "exceptionDetails" in result:
            details = result["exceptionDetails"]
            description = details.get("exception", {}).get("description") or details.get("text", "exception")
            raise CdpError(description.splitlines()[0])
        return result.get("result", {}).get("value")

    async def close(self) -> None:
        await self._ws.close()
        self._reader.cancel()


# ---------------------------------------------------------------------------------------------
# Kana-kanji conversion with libanthy (the same library and learning data ibus-anthy uses).
#
# The page asks for conversions through a CDP binding (Runtime.addBinding "fjkAnthy"): it calls
# fjkAnthy(JSON) and we answer with Runtime.evaluate("__fjkAnthyReply(JSON)"). Every request is
# self-contained (it carries the reading and the segment lengths), so previews and the explicit
# conversion never disturb each other. Only commit / commitPrediction write anthy's learning data
# (~/.anthy, shared with ibus-anthy). Nothing typed is ever logged.
# ---------------------------------------------------------------------------------------------

ANTHY_UTF8_ENCODING = 2
NTH_UNCONVERTED_CANDIDATE = -1
MAX_CANDIDATES = 50
MAX_PREDICTIONS = 20
BUFFER_BYTES = 4096
ANTHY_BINDING_NAME = "fjkAnthy"
REPLY_FUNCTION = "__fjkAnthyReply"


class _ConvStat(ctypes.Structure):
    _fields_ = [("nr_segment", ctypes.c_int)]


class _SegmentStat(ctypes.Structure):
    _fields_ = [("nr_candidate", ctypes.c_int), ("seg_len", ctypes.c_int)]


class _PredictionStat(ctypes.Structure):
    _fields_ = [("nr_prediction", ctypes.c_int)]


class AnthyError(Exception):
    pass


class Anthy:
    """One anthy context in UTF-8 mode, driven by self-contained requests."""

    def __init__(self, library: str = "libanthy.so.0") -> None:
        lib = ctypes.CDLL(library)
        ctx_p = ctypes.c_void_p
        lib.anthy_init.restype = ctypes.c_int
        lib.anthy_create_context.restype = ctx_p
        lib.anthy_context_set_encoding.argtypes = [ctx_p, ctypes.c_int]
        lib.anthy_set_string.argtypes = [ctx_p, ctypes.c_char_p]
        lib.anthy_set_string.restype = ctypes.c_int
        lib.anthy_resize_segment.argtypes = [ctx_p, ctypes.c_int, ctypes.c_int]
        lib.anthy_get_stat.argtypes = [ctx_p, ctypes.POINTER(_ConvStat)]
        lib.anthy_get_stat.restype = ctypes.c_int
        lib.anthy_get_segment_stat.argtypes = [ctx_p, ctypes.c_int, ctypes.POINTER(_SegmentStat)]
        lib.anthy_get_segment_stat.restype = ctypes.c_int
        lib.anthy_get_segment.argtypes = [ctx_p, ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
        lib.anthy_get_segment.restype = ctypes.c_int
        lib.anthy_commit_segment.argtypes = [ctx_p, ctypes.c_int, ctypes.c_int]
        lib.anthy_commit_segment.restype = ctypes.c_int
        lib.anthy_set_prediction_string.argtypes = [ctx_p, ctypes.c_char_p]
        lib.anthy_set_prediction_string.restype = ctypes.c_int
        lib.anthy_get_prediction_stat.argtypes = [ctx_p, ctypes.POINTER(_PredictionStat)]
        lib.anthy_get_prediction_stat.restype = ctypes.c_int
        lib.anthy_get_prediction.argtypes = [ctx_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
        lib.anthy_get_prediction.restype = ctypes.c_int
        lib.anthy_commit_prediction.argtypes = [ctx_p, ctypes.c_int]
        lib.anthy_commit_prediction.restype = ctypes.c_int
        if lib.anthy_init() != 0:
            raise AnthyError("anthy_init failed")
        ctx = lib.anthy_create_context()
        if not ctx:
            raise AnthyError("anthy_create_context failed")
        lib.anthy_context_set_encoding(ctx, ANTHY_UTF8_ENCODING)
        self._lib = lib
        self._ctx = ctx
        self._buffer = ctypes.create_string_buffer(BUFFER_BYTES)

    def _text(self, getter, *args) -> str:
        if getter(self._ctx, *args, self._buffer, BUFFER_BYTES) < 0:
            return ""
        return self._buffer.value.decode("utf-8", errors="replace")

    def _segment_stat(self, index: int) -> _SegmentStat:
        stat = _SegmentStat()
        self._lib.anthy_get_segment_stat(self._ctx, index, ctypes.byref(stat))
        return stat

    def _nr_segments(self) -> int:
        stat = _ConvStat()
        self._lib.anthy_get_stat(self._ctx, ctypes.byref(stat))
        return stat.nr_segment

    def _load(self, reading: str, lengths: list | None) -> None:
        """Convert a reading, then resize the segments (left to right) to the given lengths."""
        if self._lib.anthy_set_string(self._ctx, reading.encode("utf-8")) != 0:
            raise AnthyError("anthy_set_string failed")
        if not lengths or sum(lengths) != len(reading):
            return
        for index, wanted in enumerate(lengths):
            if index >= self._nr_segments():
                break
            have = self._segment_stat(index).seg_len
            if have != wanted:
                self._lib.anthy_resize_segment(self._ctx, index, wanted - have)

    def _segments(self) -> list:
        segments = []
        for index in range(self._nr_segments()):
            stat = self._segment_stat(index)
            count = min(stat.nr_candidate, MAX_CANDIDATES)
            segments.append({
                "reading": self._text(self._lib.anthy_get_segment, index, NTH_UNCONVERTED_CANDIDATE),
                "candidates": [self._text(self._lib.anthy_get_segment, index, n) for n in range(count)],
            })
        return segments

    def convert(self, reading: str, lengths: list | None = None) -> list:
        self._load(reading, lengths)
        return self._segments()

    def resize(self, reading: str, lengths: list | None, index: int, delta: int) -> list:
        self._load(reading, lengths)
        if 0 <= index < self._nr_segments() and delta in (-1, 1):
            self._lib.anthy_resize_segment(self._ctx, index, delta)
        return self._segments()

    def predict(self, reading: str) -> list:
        if self._lib.anthy_set_prediction_string(self._ctx, reading.encode("utf-8")) != 0:
            return []
        stat = _PredictionStat()
        self._lib.anthy_get_prediction_stat(self._ctx, ctypes.byref(stat))
        count = min(stat.nr_prediction, MAX_PREDICTIONS)
        return [self._text(self._lib.anthy_get_prediction, n) for n in range(count)]

    def commit(self, reading: str, lengths: list, choices: list, texts: list) -> bool:
        """Learn a conversion. Re-creates it and checks every chosen text before committing."""
        self._load(reading, lengths)
        segments = self._segments()
        if len(segments) != len(choices) or len(texts) != len(choices):
            return False
        for segment, choice, text in zip(segments, choices, texts):
            if not (0 <= choice < len(segment["candidates"])) or segment["candidates"][choice] != text:
                return False
        for index, choice in enumerate(choices):
            self._lib.anthy_commit_segment(self._ctx, index, choice)
        return True

    def commit_prediction(self, reading: str, index: int, text: str) -> bool:
        """Learn a picked prediction. Checks the text before committing."""
        predictions = self.predict(reading)
        if not (0 <= index < len(predictions)) or predictions[index] != text:
            return False
        self._lib.anthy_commit_prediction(self._ctx, index)
        return True

    def handle(self, request: dict) -> dict:
        """Serve one request from the page (the reply never echoes input on errors)."""
        op = request.get("op")
        reading = str(request.get("reading", ""))
        lengths = request.get("lengths") or None
        if op == "hello":
            return {"ok": True, "version": 1}
        if op == "convert":
            return {"ok": True, "segments": self.convert(reading, lengths)}
        if op == "resize":
            index = int(request.get("index", 0))
            delta = int(request.get("delta", 0))
            return {"ok": True, "segments": self.resize(reading, lengths, index, delta)}
        if op == "predict":
            return {"ok": True, "predictions": self.predict(reading)}
        if op == "commit":
            choices = [int(c) for c in request.get("choices", [])]
            texts = [str(t) for t in request.get("texts", [])]
            return {"ok": self.commit(reading, lengths or [], choices, texts)}
        if op == "commitPrediction":
            return {"ok": self.commit_prediction(reading, int(request.get("index", -1)), str(request.get("text", "")))}
        return {"ok": False, "error": "unknown op"}


_anthy = None
_anthy_failed = False


def get_anthy():
    """Load libanthy once; None (logged once) when it is not available."""
    global _anthy, _anthy_failed
    if _anthy is None and not _anthy_failed:
        try:
            _anthy = Anthy()
            log.info("libanthy loaded: kana-kanji conversion is served to the page")
        except (OSError, AnthyError) as error:
            _anthy_failed = True
            log.info(f"libanthy unavailable ({type(error).__name__}); the keyboard types hiragana directly")
    return _anthy


async def serve_binding(session, params: dict) -> None:
    """Answer one fjkAnthy(...) call from the page."""
    if params.get("name") != ANTHY_BINDING_NAME:
        return
    reply = {"id": None, "ok": False}
    try:
        request = json.loads(params.get("payload", "{}"))
        reply["id"] = request.get("id")
        anthy = get_anthy()
        if anthy is None:
            reply["error"] = "unavailable"
        else:
            reply.update(anthy.handle(request))
    except Exception as error:  # a bad request must never stop the service; log the kind only
        reply["error"] = type(error).__name__
        log.info(f"anthy request failed: {type(error).__name__}")
    expression = f"globalThis.{REPLY_FUNCTION} && globalThis.{REPLY_FUNCTION}({json.dumps(reply)})"
    params_out = {"expression": expression}
    if params.get("executionContextId") is not None:
        params_out["contextId"] = params["executionContextId"]
    try:
        await session.call("Runtime.evaluate", params_out)
    except (CdpError, asyncio.TimeoutError):
        pass


def anthy_selftest() -> int:
    """Convert, resize and predict a few readings and print timings. Never commits (learning untouched)."""
    anthy = get_anthy()
    if anthy is None:
        return 1
    for reading in ["かんじ", "きかい", "きょうはいいてんき", "にほんご", "でんしゃ", "わたしはがくせいです"]:
        start = time.perf_counter()
        segments = anthy.convert(reading)
        convert_ms = (time.perf_counter() - start) * 1000
        start = time.perf_counter()
        predictions = anthy.predict(reading)
        predict_ms = (time.perf_counter() - start) * 1000
        lengths = [len(s["reading"]) for s in segments]
        start = time.perf_counter()
        resized = anthy.resize(reading, lengths, 0, 1) if len(reading) > lengths[0] else segments
        resize_ms = (time.perf_counter() - start) * 1000
        start = time.perf_counter()
        again = anthy.convert(reading, [len(s["reading"]) for s in resized])
        reload_ms = (time.perf_counter() - start) * 1000
        whole = "".join(s["candidates"][0] if s["candidates"] else s["reading"] for s in segments)
        print(json.dumps({
            "reading": reading,
            "whole": whole,
            "segments": [s["reading"] for s in segments],
            "first": [s["candidates"][:3] for s in segments],
            "predictions": predictions[:3],
            "resized0+1": [s["reading"] for s in resized],
            "reloadedSame": [s["reading"] for s in again] == [s["reading"] for s in resized],
            "ms": {"convert": round(convert_ms, 2), "predict": round(predict_ms, 2),
                   "resize": round(resize_ms, 2), "reloadWithLengths": round(reload_ms, 2)},
        }, ensure_ascii=False))
    return 0


async def find_target(http: aiohttp.ClientSession, devtools: str) -> dict | None:
    async with http.get(f"{devtools}/json") as response:
        targets = await response.json(content_type=None)
    return next((t for t in targets if t.get("title") == TARGET_TITLE and t.get("webSocketDebuggerUrl")), None)


def read_bundle(path: Path) -> str | None:
    try:
        source = path.read_text(encoding="utf-8")
    except OSError as error:
        log.state(f"cannot read bundle {path}: {error.strerror}")
        return None
    return f"{source}\n//# sourceURL=frame-jp-keyboard/bundle.js\n"


async def inject(session: CdpSession, bundle: Path, lang: str) -> bool:
    source = read_bundle(bundle)
    if source is None:
        return False
    try:
        # Set before the bundle runs, so main.js's LANG constant sees it on the very first read.
        await session.evaluate(f"globalThis.__fjkLang = {json.dumps(lang)};\n{source}")
    except CdpError as error:
        log.info(f"injection failed: {error}")
        return False
    try:
        status = await session.evaluate(STATUS_EXPRESSION)
    except CdpError:
        status = "?"
    log.info(f"injected {bundle} -> window.__fjk {status}")
    return True


def create_updater() -> "Updater | None":
    """The shared updater for this app (see vendor/frame-updater), or None if its Python helper isn't
    installed next to this script (fails safe: the indicator just never hears back)."""
    if Updater is None:
        return None
    script = Path(__file__).resolve().parent / "frame-update.sh"
    return Updater(script, UPDATE_APP, UPDATE_REPO, read_version(), UPDATE_ASSET)


async def push(session: CdpSession, message: dict) -> None:
    """Call window.__fjk.updater.receive(message) in the page (see src/update.js)."""
    try:
        await session.evaluate(f"window.__fjk && window.__fjk.updater && window.__fjk.updater.receive({json.dumps(message)})")
    except (CdpError, asyncio.TimeoutError) as error:
        log.info(f"update: push to page failed: {type(error).__name__}: {error}")


async def poll_install(session: CdpSession, updater: "Updater", interval: float = 3.0, timeout: float = 600.0) -> None:
    """Push frame-update.sh's install progress until it stops running, the page is gone, or we time out.
    If install.sh restarts this very service (it does; see frame-updater/README.md), the session closes
    partway through and this just stops quietly -- the new process's own auto-check reports success."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and not session.closed:
        await asyncio.sleep(interval)
        answer = await updater.state()
        await push(session, {"source": "state", "answer": answer})
        if answer.get("state") != "running":
            return


async def handle_bridge_message(payload: str, session: CdpSession, updater: "Updater | None") -> None:
    """Handle one page -> injector request (see main.js's bridgeSend and UPDATE_BINDING_NAME)."""
    if updater is None:
        log.info("update: request from the page, but the update helper isn't installed")
        return
    try:
        message = json.loads(payload)
        action = message.get("action") if isinstance(message, dict) else None
    except ValueError:
        action = None
    if action == "check":
        answer = await updater.check(force=True)
        await push(session, {"source": "check", "forced": True, "answer": answer})
    elif action == "install":
        answer = await updater.install()
        await push(session, {"source": "install", "answer": answer})
        session.spawn(poll_install(session, updater))
    else:
        log.info(f"update: bad request from the page: {payload!r}")


async def maybe_auto_check(session: CdpSession, updater: "Updater", recheck: dict) -> None:
    """At most once per AUTO_RECHECK_SECONDS, check for updates if fjk.settings.updateCheck allows it
    (frame-update.sh's own cache keeps the actual GitHub call to about once a day regardless)."""
    now = time.monotonic()
    if now - recheck["last"] < AUTO_RECHECK_SECONDS:
        return
    recheck["last"] = now
    try:
        enabled = await session.evaluate(UPDATE_CHECK_ENABLED_EXPRESSION)
    except (CdpError, asyncio.TimeoutError):
        enabled = True
    if not enabled:
        return
    answer = await updater.check(force=False)
    await push(session, {"source": "check", "forced": False, "answer": answer})


async def watch_target(http: aiohttp.ClientSession, target: dict, args: argparse.Namespace,
                        updater: "Updater | None") -> None:
    """Keep the bundle injected into one target until it disappears or its websocket closes."""
    ws = await http.ws_connect(target["webSocketDebuggerUrl"], max_msg_size=0, heartbeat=30)
    session = CdpSession(ws, forward_console=not args.no_console,
                         on_update=lambda payload: handle_bridge_message(payload, session, updater))
    log.clear_state()
    log.info(f"connected to {TARGET_TITLE} ({target['id']})")
    # -inf, not 0: time.monotonic() counts from boot, so 0 would skip the first check for an hour.
    recheck = {"last": float("-inf")}
    try:
        await session.call("Runtime.enable")  # console forwarding and binding events
        # Bindings live as long as this session (each new connection adds them again) and are
        # exposed to every context of the target, including one reloaded before a re-injection.
        if get_anthy() is not None:
            # The page calls fjkAnthy(...) for conversions.
            await session.add_binding(ANTHY_BINDING_NAME)
        # The page calls fjkUpdateBridge(...) for a forced check or an install.
        await session.add_binding(UPDATE_BINDING_NAME)
        while not session.closed:
            if not await session.evaluate(CHECK_EXPRESSION):
                await inject(session, args.bundle, LANG)
            if updater is not None:
                # In its own task: a slow GitHub call must not hold up re-injection.
                session.spawn(maybe_auto_check(session, updater, recheck))
            await asyncio.sleep(POLL_SECONDS)
            current = await find_target(http, args.devtools)
            if current is None or current["id"] != target["id"]:
                log.info(f"{TARGET_TITLE} target changed; reconnecting")
                return
    finally:
        await session.close()


async def run_service(args: argparse.Namespace) -> None:
    backoff = POLL_SECONDS
    updater = create_updater()
    if updater is None:
        log.info("update helper (frame_update.py) not found next to this script; update checks are disabled")
    timeout = aiohttp.ClientTimeout(total=None, connect=5, sock_read=None)
    async with aiohttp.ClientSession(timeout=timeout) as http:
        while True:
            try:
                target = await asyncio.wait_for(find_target(http, args.devtools), 10)
                if target is None:
                    log.state(f"waiting for {TARGET_TITLE} target")
                else:
                    backoff = POLL_SECONDS
                    await watch_target(http, target, args, updater)
                    continue
            except (aiohttp.ClientError, asyncio.TimeoutError, CdpError, OSError, ValueError) as error:
                log.state(f"CDP unavailable ({type(error).__name__}: {error or 'no detail'}); retrying")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, MAX_BACKOFF_SECONDS)


async def run_once(args: argparse.Namespace) -> int:
    """Inject once unconditionally (the bundle replaces an existing instance itself)."""
    timeout = aiohttp.ClientTimeout(total=60)
    async with aiohttp.ClientSession(timeout=timeout) as http:
        try:
            target = await find_target(http, args.devtools)
            if target is None:
                log.info(f"no {TARGET_TITLE} target at {args.devtools}")
                return 1
            ws = await http.ws_connect(target["webSocketDebuggerUrl"], max_msg_size=0)
            session = CdpSession(ws, forward_console=False)
            try:
                return 0 if await inject(session, args.bundle, LANG) else 1
            finally:
                await session.close()
        except (aiohttp.ClientError, asyncio.TimeoutError, CdpError, OSError, ValueError) as error:
            log.info(f"CDP unavailable at {args.devtools}: {type(error).__name__}: {error}")
            return 1


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--bundle", type=Path, default=Path(os.environ.get("FJK_BUNDLE", DEFAULT_BUNDLE)),
                        help=f"bundle to inject (default: {DEFAULT_BUNDLE})")
    parser.add_argument("--devtools", default=DEFAULT_DEVTOOLS, help=f"CDP endpoint (default: {DEFAULT_DEVTOOLS})")
    parser.add_argument("--once", action="store_true", help="inject (or re-inject) once and exit")
    parser.add_argument("--no-console", action="store_true", help="do not forward [fjk] console lines")
    parser.add_argument("--anthy-selftest", action="store_true",
                        help="convert a few words with libanthy and print timings (never commits), then exit")
    args = parser.parse_args()
    args.bundle = args.bundle.expanduser()
    try:
        if args.anthy_selftest:
            sys.exit(anthy_selftest())
        if args.once:
            sys.exit(asyncio.run(run_once(args)))
        log.info(f"frame-jp-keyboard injector: bundle {args.bundle}, CDP {args.devtools}, lang {LANG}")
        asyncio.run(run_service(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
