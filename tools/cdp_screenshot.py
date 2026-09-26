#!/usr/bin/env python3
"""Save a PNG screenshot of one of Steam's CEF targets (default: the VR keyboard popup).

Runs on the headset. Usage: python3 cdp_screenshot.py OUT.png [--target TITLE]
"""
import argparse
import asyncio
import base64
import json

import aiohttp

DEVTOOLS = "http://127.0.0.1:8080"


async def capture(target_title: str, out_path: str) -> None:
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{DEVTOOLS}/json") as response:
            targets = await response.json(content_type=None)
        target = next((t for t in targets if t["title"] == target_title), None)
        if target is None:
            raise SystemExit(f"no target titled {target_title!r}")
        async with session.ws_connect(target["webSocketDebuggerUrl"], max_msg_size=0) as ws:
            await ws.send_json({"id": 1, "method": "Page.captureScreenshot", "params": {"format": "png"}})
            async for message in ws:
                reply = json.loads(message.data)
                if reply.get("id") == 1:
                    if "error" in reply:
                        raise SystemExit(f"capture failed: {reply['error']}")
                    with open(out_path, "wb") as f:
                        f.write(base64.b64decode(reply["result"]["data"]))
                    print(out_path)
                    return


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("out")
    parser.add_argument("--target", default="SteamVR - Keyboard")
    args = parser.parse_args()
    asyncio.run(capture(args.target, args.out))


if __name__ == "__main__":
    main()
