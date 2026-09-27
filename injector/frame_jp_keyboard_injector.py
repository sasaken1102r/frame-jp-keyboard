#!/usr/bin/env python3
"""Inject the frame-jp-keyboard bundle into Steam's SharedJSContext over the Chrome DevTools Protocol.

Runs on the Steam Frame as a systemd --user service (stdlib + aiohttp only).

Every 2 s it looks up the SharedJSContext target on http://127.0.0.1:8080/json. When the target
is new (Steam restarted) or window.__fjk is missing (the context reloaded), it evaluates the bundle.
CDP being unreachable or Steam restarting is normal: it waits with backoff and tries again.
Console lines starting with "[fjk]" are forwarded to stdout (journald).

It also drives frame-updater (vendor/frame-updater, copied next to this script as frame-update.sh
and frame_update.py): a forced check/install requested from the page (see src/update.js) arrives as
a Runtime.addBinding call, and the page's own automatic check runs at connect and at most hourly
(frame-update.sh's own cache limits the actual GitHub call to once a day; see maybe_auto_check()).

Usage:
  frame_jp_keyboard_injector.py [--bundle PATH] [--once] [--devtools URL] [--no-console]
"""
from __future__ import annotations

import argparse
import asyncio
import itertools
import json
import os
import sys
import time
from pathlib import Path
from typing import Callable

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
# The page -> injector CDP binding name (Runtime.addBinding); see src/update.js's `send`.
BINDING_NAME = "fjkUpdateBridge"
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
    """A minimal CDP client over one websocket: request/response, console forwarding, and one
    Runtime.addBinding channel for page -> injector calls (see BINDING_NAME)."""

    def __init__(self, ws: aiohttp.ClientWebSocketResponse, forward_console: bool,
                 on_binding: Callable[[str], None] | None = None) -> None:
        self._ws = ws
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future] = {}
        self._forward_console = forward_console
        self._on_binding = on_binding
        self._connected_ms = time.time() * 1000
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
        if params.get("name") == BINDING_NAME and self._on_binding:
            self._on_binding(params.get("payload", ""))

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
    except CdpError as error:
        log.info(f"update: push to page failed: {error}")


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
    """Handle one page -> injector request (see src/update.js's `send` and BINDING_NAME)."""
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
        asyncio.create_task(poll_install(session, updater))
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
    except CdpError:
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
                         on_binding=lambda payload: asyncio.create_task(handle_bridge_message(payload, session, updater)))
    log.clear_state()
    log.info(f"connected to {TARGET_TITLE} ({target['id']})")
    recheck = {"last": 0.0}
    try:
        # Always on: bindingCalled (the update bridge) needs it, same as consoleAPICalled did.
        await session.call("Runtime.enable")
        await session.add_binding(BINDING_NAME)
        while not session.closed:
            if not await session.evaluate(CHECK_EXPRESSION):
                await inject(session, args.bundle, LANG)
            if updater is not None:
                await maybe_auto_check(session, updater, recheck)
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
    args = parser.parse_args()
    args.bundle = args.bundle.expanduser()
    try:
        if args.once:
            sys.exit(asyncio.run(run_once(args)))
        log.info(f"frame-jp-keyboard injector: bundle {args.bundle}, CDP {args.devtools}, lang {LANG}")
        asyncio.run(run_service(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
