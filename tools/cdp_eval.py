#!/usr/bin/env python3
"""Evaluate a JavaScript expression in one of Steam's CEF targets and print the result.

Runs on the headset. Usage: python3 cdp_eval.py [--target TITLE] EXPRESSION
"""
import argparse
import asyncio
import json

import aiohttp

DEVTOOLS = "http://127.0.0.1:8080"


async def evaluate(target_title: str, expression: str) -> None:
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{DEVTOOLS}/json") as response:
            targets = await response.json(content_type=None)
        target = next((t for t in targets if t["title"] == target_title), None)
        if target is None:
            raise SystemExit(f"no target titled {target_title!r}")
        async with session.ws_connect(target["webSocketDebuggerUrl"], max_msg_size=0) as ws:
            await ws.send_json({
                "id": 1,
                "method": "Runtime.evaluate",
                "params": {"expression": expression, "returnByValue": True, "awaitPromise": True},
            })
            async for message in ws:
                reply = json.loads(message.data)
                if reply.get("id") == 1:
                    result = reply.get("result", {})
                    if "exceptionDetails" in result:
                        print("EXCEPTION:", json.dumps(result["exceptionDetails"], ensure_ascii=False, indent=2))
                    else:
                        print(json.dumps(result.get("result", {}).get("value"), ensure_ascii=False, indent=2))
                    return


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", default="SharedJSContext")
    parser.add_argument("expression")
    args = parser.parse_args()
    asyncio.run(evaluate(args.target, args.expression))


if __name__ == "__main__":
    main()
