#!/usr/bin/env python3
"""Inject the frame-jp-keyboard bundle into Steam's SharedJSContext over the Chrome DevTools Protocol.

Runs on the Steam Frame as a systemd --user service (stdlib + aiohttp only).

Every 2 s it looks up the SharedJSContext target on http://127.0.0.1:8080/json. When the target
is new (Steam restarted) or window.__fjk is missing (the context reloaded), it evaluates the bundle.
CDP being unreachable or Steam restarting is normal: it waits with backoff and tries again.
Console lines starting with "[fjk]" are forwarded to stdout (journald).

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

import aiohttp

DEFAULT_DEVTOOLS = "http://127.0.0.1:8080"
DEFAULT_BUNDLE = Path.home() / ".local/share/frame-jp-keyboard/bundle.js"
TARGET_TITLE = "SharedJSContext"
POLL_SECONDS = 2.0
MAX_BACKOFF_SECONDS = 30.0
CALL_TIMEOUT_SECONDS = 15.0
CHECK_EXPRESSION = "typeof window.__fjk === 'object' && window.__fjk !== null"
STATUS_EXPRESSION = "window.__fjk ? `${window.__fjk.version} (${window.__fjk.state})` : 'missing'"


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
    """A minimal CDP client over one websocket: request/response plus console forwarding."""

    def __init__(self, ws: aiohttp.ClientWebSocketResponse, forward_console: bool) -> None:
        self._ws = ws
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future] = {}
        self._forward_console = forward_console
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


async def inject(session: CdpSession, bundle: Path) -> bool:
    source = read_bundle(bundle)
    if source is None:
        return False
    try:
        await session.evaluate(source)
    except CdpError as error:
        log.info(f"injection failed: {error}")
        return False
    try:
        status = await session.evaluate(STATUS_EXPRESSION)
    except CdpError:
        status = "?"
    log.info(f"injected {bundle} -> window.__fjk {status}")
    return True


async def watch_target(http: aiohttp.ClientSession, target: dict, args: argparse.Namespace) -> None:
    """Keep the bundle injected into one target until it disappears or its websocket closes."""
    ws = await http.ws_connect(target["webSocketDebuggerUrl"], max_msg_size=0, heartbeat=30)
    session = CdpSession(ws, forward_console=not args.no_console)
    log.clear_state()
    log.info(f"connected to {TARGET_TITLE} ({target['id']})")
    try:
        if not args.no_console:
            await session.call("Runtime.enable")
        while not session.closed:
            if not await session.evaluate(CHECK_EXPRESSION):
                await inject(session, args.bundle)
            await asyncio.sleep(POLL_SECONDS)
            current = await find_target(http, args.devtools)
            if current is None or current["id"] != target["id"]:
                log.info(f"{TARGET_TITLE} target changed; reconnecting")
                return
    finally:
        await session.close()


async def run_service(args: argparse.Namespace) -> None:
    backoff = POLL_SECONDS
    timeout = aiohttp.ClientTimeout(total=None, connect=5, sock_read=None)
    async with aiohttp.ClientSession(timeout=timeout) as http:
        while True:
            try:
                target = await asyncio.wait_for(find_target(http, args.devtools), 10)
                if target is None:
                    log.state(f"waiting for {TARGET_TITLE} target")
                else:
                    backoff = POLL_SECONDS
                    await watch_target(http, target, args)
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
                return 0 if await inject(session, args.bundle) else 1
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
        log.info(f"frame-jp-keyboard injector: bundle {args.bundle}, CDP {args.devtools}")
        asyncio.run(run_service(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
