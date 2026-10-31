"""武侯Chat 启动入口：在同一事件循环内同时运行
FastAPI(HTTP, uvicorn) 与 aiohttp WebSocket 网关。

    python run.py            # 默认 HTTP 8000 / WS 8001
    python run.py --http 80 --ws 8001
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import signal
import sys

import uvicorn
from aiohttp import web

from app.config import settings
from app.main import app as fastapi_app
from app.main import ws_app
from app.realtime import hub

logging.getLogger("aiohttp.access").setLevel(logging.WARNING)


async def serve(http_port: int, ws_port: int, host: str) -> None:
    config = uvicorn.Config(fastapi_app, host=host, port=http_port,
                            log_level=settings.log_level.lower(), access_log=settings.debug)
    http_server = uvicorn.Server(config)
    http_server.install_signal_handlers = lambda: None  # 由外层统一处理

    runner = web.AppRunner(ws_app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, host, ws_port)

    banner = (
        f"\n  {settings.app_name}  v1.0.0   ——   {settings.copyright_text}\n"
        f"  HTTP  : http://127.0.0.1:{http_port}\n"
        f"  WS    : ws://127.0.0.1:{ws_port}/ws\n"
        f"  存储  : {settings.redis_url}  |  消息总线: {settings.rabbit_url}\n"
    )
    try:
        print(banner)
    except Exception:
        pass  # 后台无控制台时 banner 仅作装饰，不影响服务
    await site.start()
    await asyncio.gather(http_server.serve(), _ticker())
    await runner.cleanup()


async def _ticker() -> None:
    """周期性输出连接概况，并清理失效连接。"""
    while True:
        await asyncio.sleep(120)
        logging.getLogger("wuhou").info("在线连接 %d · 在线用户 %d", hub.count(), len(hub.local_online()))


def main() -> None:
    # 后台服务/计划任务/重定向场景下 stdout 可能是 GBK 或非交互管道，
    # 统一重配为 UTF-8 + 替换错误，避免 banner 中的 © / 中文触发 UnicodeEncodeError。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    parser = argparse.ArgumentParser(description=f"{settings.app_name} 服务启动器")
    parser.add_argument("--http", type=int, default=settings.http_port)
    parser.add_argument("--ws", type=int, default=settings.ws_port)
    parser.add_argument("--host", default=settings.host)
    args = parser.parse_args()

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, lambda: asyncio.ensure_future(_shutdown(loop)))
        except NotImplementedError:  # Windows 无 SIGTERM 处理器
            pass
    try:
        loop.run_until_complete(serve(args.http, args.ws, args.host))
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        loop.close()


async def _shutdown(loop: asyncio.AbstractEventLoop) -> None:
    for task in asyncio.all_tasks(loop):
        task.cancel()
    loop.stop()


if __name__ == "__main__":
    sys.exit(main())
