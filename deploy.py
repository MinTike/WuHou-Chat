#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""武侯Chat 服务器部署工具（跨平台：Windows / Linux）

替代手工敲命令的一键部署脚本。覆盖：
  check    环境与配置自检（Python/venv/依赖/.env 安全基线/WAF 引擎）
  setup    创建 .env（从模板）+ 安装依赖 + 初始化数据目录
  start    后台启动服务（HTTP/WS，PID 与日志托管）
  stop     停止服务（按 PID 文件）
  restart  重启
  status   查看运行状态（PID/端口/健康）
  health   健康检查（/api/meta 探活）
  deploy   一键部署 = check -> setup -> start -> health

用法示例：
  python deploy.py check                # 只做自检
  python deploy.py deploy               # 一键部署（生产前请先填好 .env）
  python deploy.py start --http 8000 --ws 8001
  python deploy.py start --detach       # Windows：计划任务脱离会话启动（SSH/远程桌面/受限环境）
  python deploy.py rewrite --base-url https://chat.example.com
                                        # 把所有本地地址改写为服务器地址（部署前必用）
  python deploy.py stop
  python deploy.py status
  python deploy.py health

退出码：0=成功；1=检查/操作失败。

说明：
  --detach 仅 Windows 有效。普通 start 通过 Popen 启动子进程；在 SSH 会话、
  IDE 托管终端等受 Job Object 约束的环境里，父进程退出会连带回收子进程。
  --detach 改用计划任务（schtasks）在独立会话中启动，服务不随 deploy.py 退出而消亡。
  服务 PID 仍写入 logs/chat.pid，stop/status 无需额外参数。
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import secrets
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

# ---------------------------------------------------------------- 路径与常量
BASE_DIR = Path(__file__).resolve().parent
ENV_FILE = BASE_DIR / ".env"
ENV_TEMPLATE = BASE_DIR / ".env.example"
VENV_DIR = BASE_DIR / "venv"
DATA_DIR = BASE_DIR / "data"
LOGS_DIR = BASE_DIR / "logs"
PID_FILE = BASE_DIR / "logs" / "chat.pid"
LOG_FILE = BASE_DIR / "logs" / "chat.log"
DEFAULT_HTTP_PORT = 8000
DEFAULT_WS_PORT = 8001

# 运行所需的核心依赖（与 app/ 实际导入一致）
CORE_REQUIREMENTS = [
    "fastapi>=0.142",
    "uvicorn[standard]>=0.54",
    "aiohttp>=3.14",
    "aio-pika>=10.1",
    "aiosqlite>=0.22",
    "bcrypt>=5.0",
    "PyJWT>=2.15",
    "pydantic>=2.13",
    "pydantic-settings>=2.15",
    "redis>=8.1",
    "cryptography>=50.0",
    "python-multipart>=0.0.32",
    "python-dotenv>=1.2",
    "httptools>=0.8",
]

# 泄漏默认值清单（与 app/config.py _LEAKED_DEFAULTS 保持一致）
_LEAKED_DEFAULTS = {
    "wuhou-chat-dev-secret-please-change-me",
    "wuhou@2026",
}

# ANSI 颜色（仅 TTY 输出）
_GREEN = "\033[32m"
_RED = "\033[31m"
_YELLOW = "\033[33m"
_CYAN = "\033[36m"
_RESET = "\033[0m"


def _use_color() -> bool:
    return sys.stdout.isatty() and os.environ.get("NO_COLOR", "") == ""


def c(text: str, color: str) -> str:
    return f"{color}{text}{_RESET}" if _use_color() else text


def ok(msg: str = "") -> None:
    print(c("  ✅ " + msg, _GREEN))


def fail(msg: str = "") -> None:
    print(c("  ❌ " + msg, _RED))


def warn(msg: str = "") -> None:
    print(c("  ⚠️  " + msg, _YELLOW))


def info(msg: str = "") -> None:
    print(c("  ℹ️  " + msg, _CYAN))


# ---------------------------------------------------------------- 平台工具
def is_windows() -> bool:
    return platform.system().lower() == "windows"


def venv_python() -> Path:
    """返回 venv 中的 python 解释器路径。"""
    if is_windows():
        p = VENV_DIR / "Scripts" / "python.exe"
    else:
        p = VENV_DIR / "bin" / "python"
    return p


def find_system_python() -> str:
    """找到一个可用的系统 python（用于创建 venv）。"""
    for cand in (sys.executable, "python3", "python"):
        try:
            if cand == sys.executable:
                return cand
            subprocess.run(
                [cand, "-c", "import sys; assert sys.version_info >= (3, 10)"],
                check=True, capture_output=True, timeout=15,
            )
            return cand
        except Exception:
            continue
    return sys.executable


# ---------------------------------------------------------------- 环境自检
def _check_python() -> list[str]:
    problems = []
    v = sys.version_info
    if v < (3, 10):
        problems.append(f"Python 版本过低：{v.major}.{v.minor}.{v.micro}（需要 >= 3.10）")
    else:
        ok(f"Python {v.major}.{v.minor}.{v.micro}")
    return problems


def _check_venv() -> list[str]:
    problems = []
    py = venv_python()
    if not py.exists():
        warn("venv 不存在（可运行 python deploy.py setup 创建并安装依赖）")
        return problems
    # 验证 venv 可运行
    try:
        r = subprocess.run([str(py), "-c", "import sys; print(sys.version.split()[0])"],
                           capture_output=True, text=True, timeout=30,
                           encoding="utf-8", errors="replace")
        if r.returncode == 0:
            ok(f"venv Python {r.stdout.strip()}")
        else:
            problems.append("venv 解释器异常：" + (r.stderr or "").strip()[:120])
    except Exception as e:
        problems.append(f"venv 解释器无法执行：{e}")
    return problems


def _check_dependencies() -> list[str]:
    problems = []
    py = venv_python()
    if not py.exists():
        return problems
    # pip 包名 -> import 模块名（部分包名与导入名不一致）
    IMPORT_MAP = {
        "fastapi": "fastapi",
        "uvicorn": "uvicorn",
        "aiohttp": "aiohttp",
        "aio-pika": "aio_pika",
        "aiosqlite": "aiosqlite",
        "bcrypt": "bcrypt",
        "PyJWT": "jwt",
        "pydantic": "pydantic",
        "pydantic-settings": "pydantic_settings",
        "redis": "redis",
        "cryptography": "cryptography",
        "python-multipart": "multipart",
        "python-dotenv": "dotenv",
        "httptools": "httptools",
    }
    missing = []
    for pkg in CORE_REQUIREMENTS:
        name = pkg.split(">=")[0].split("[")[0]
        mod = IMPORT_MAP.get(name, name.replace("-", "_"))
        try:
            subprocess.run(
                [str(py), "-c", f"import {mod}"],
                check=True, capture_output=True, timeout=30,
                encoding="utf-8", errors="replace",
            )
        except Exception:
            missing.append(name)
    if missing:
        problems.append("缺少依赖：" + ", ".join(missing) + "（运行 python deploy.py setup 安装）")
    else:
        ok("核心依赖已就绪")
    return problems


def _read_env() -> dict:
    """读取 .env 键值（兼容 export KEY= 与 KEY= 形式）。"""
    if not ENV_FILE.exists():
        return {}
    out = {}
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k:
            out[k] = v
    return out


def _check_env() -> list[str]:
    problems = []
    if not ENV_FILE.exists():
        problems.append(".env 不存在（请先 cp .env.example .env 并填写真实值，或运行 python deploy.py setup）")
        return problems

    env = _read_env()
    secret = env.get("SECRET_KEY", "")
    admin_user = env.get("ADMIN_USERNAME", "")
    admin_pwd = env.get("ADMIN_PASSWORD", "")
    deploy_env = env.get("DEPLOY_ENV", "dev").strip().lower()
    captcha_debug = env.get("CAPTCHA_DEBUG", "0")
    debug = env.get("DEBUG", "0")
    cors = env.get("CORS_ORIGINS", "")

    # SECRET_KEY
    if not secret:
        problems.append("SECRET_KEY 未设置")
    elif secret in _LEAKED_DEFAULTS or len(secret) < 32:
        problems.append("SECRET_KEY 过短或使用了公开默认值（需 ≥32 随机字符）")
    else:
        ok("SECRET_KEY 合规")

    # 管理员
    if not admin_user:
        problems.append("ADMIN_USERNAME 未设置")
    else:
        ok("ADMIN_USERNAME 已设置")
    if not admin_pwd:
        problems.append("ADMIN_PASSWORD 未设置")
    elif admin_pwd in _LEAKED_DEFAULTS or len(admin_pwd) < 12:
        problems.append("ADMIN_PASSWORD 过短或使用了公开默认值（需 ≥12 随机字符）")
    else:
        ok("ADMIN_PASSWORD 合规")

    # 生产环境额外校验
    if deploy_env == "prod":
        if captcha_debug == "1":
            problems.append("生产环境 CAPTCHA_DEBUG=1（验证码答案会随响应下发）")
        if debug == "1":
            problems.append("生产环境 DEBUG=1")
        if cors.strip() in ("", "*"):
            problems.append("生产环境 CORS_ORIGINS 不能为 * 或空")
        else:
            ok("CORS_ORIGINS 已设置")
        ok(f"DEPLOY_ENV=prod（启动安全闸门将生效）")
    else:
        info(f"DEPLOY_ENV={deploy_env or 'dev'}（非 prod，生产发布前请改为 prod）")

    return problems


def _check_waf() -> list[str]:
    problems = []
    py = venv_python()
    if not py.exists():
        return problems
    try:
        r = subprocess.run(
            [str(py), "-c", "from app.core.wafengine import engine; assert len(engine.list_rules()) > 0"],
            capture_output=True, text=True, timeout=30, cwd=str(BASE_DIR),
            encoding="utf-8", errors="replace",
        )
        if r.returncode == 0:
            ok("JredonpT-WAF（定制版）引擎就绪")
        else:
            problems.append("WAF 引擎加载失败：" + (r.stderr or "").strip()[:120])
    except Exception as e:
        problems.append(f"WAF 引擎检查异常：{e}")
    return problems


def _check_ports(http_port: int, ws_port: int) -> list[str]:
    problems = []
    for port, label in ((http_port, "HTTP"), (ws_port, "WS")):
        if _port_in_use(port):
            problems.append(f"{label} 端口 {port} 已被占用（可能服务已在运行）")
    if not problems:
        ok(f"端口 {http_port}(HTTP) / {ws_port}(WS) 空闲")
    return problems


def _port_in_use(port: int) -> bool:
    """探测本机端口是否已被监听（跨平台，避免 netstat 编码问题）。"""
    import socket
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            return s.connect_ex(("127.0.0.1", port)) == 0
    except Exception:
        return False


# ---------------------------------------------------------------- setup
def _generate_secret() -> str:
    return secrets.token_urlsafe(48)


def _setup_env(force: bool = False) -> None:
    if ENV_FILE.exists() and not force:
        info(".env 已存在，跳过生成（如需重新生成请先删除或加 --force）")
        return
    if not ENV_TEMPLATE.exists():
        # 无模板时生成一个最小可用 .env
        env = (
            "# 武侯Chat 环境配置（由 deploy.py 自动生成）\n"
            f"SECRET_KEY={_generate_secret()}\n"
            "ADMIN_USERNAME=admin\n"
            f"ADMIN_PASSWORD={_generate_secret()[:20]}\n"
            "DEPLOY_ENV=dev\n"
            "DEBUG=0\n"
            "LOG_LEVEL=INFO\n"
            "PUBLIC_BASE_URL=http://127.0.0.1:8000\n"
            "CORS_ORIGINS=*\n"
            "REDIS_URL=redis://127.0.0.1:6379/0\n"
            "REDIS_ENABLED=1\n"
            "RABBIT_URL=amqp://guest:guest@127.0.0.1:5672/\n"
            "RABBIT_ENABLED=1\n"
        )
        ENV_FILE.write_text(env, encoding="utf-8")
        warn("已自动生成 .env（管理员口令为随机值，请登录后台后立即修改）")
        return

    # 从模板复制，并填充随机密钥/口令
    template = ENV_TEMPLATE.read_text(encoding="utf-8")
    secret = _generate_secret()
    admin_pwd = _generate_secret()[:20]
    template = template.replace("SECRET_KEY=", f"SECRET_KEY={secret}")
    template = template.replace("ADMIN_PASSWORD=", f"ADMIN_PASSWORD={admin_pwd}")
    ENV_FILE.write_text(template, encoding="utf-8")
    warn("已从模板生成 .env，SECRET_KEY 与管理端口令已自动填充随机值。")
    warn("请手动修改 ADMIN_USERNAME / CORS_ORIGINS / PUBLIC_BASE_URL 等为真实值。")


def _create_venv() -> None:
    if venv_python().exists():
        ok("venv 已存在")
        return
    info("创建虚拟环境 venv …")
    sys_py = find_system_python()
    subprocess.run([sys_py, "-m", "venv", str(VENV_DIR)], check=True, timeout=180)
    ok("venv 创建完成")


def _install_deps() -> None:
    py = venv_python()
    if not py.exists():
        raise RuntimeError("venv 不存在，请先运行 setup 创建")
    info("安装核心依赖（可能耗时较长）…")
    req_file = BASE_DIR / "requirements.txt"
    if req_file.exists():
        subprocess.run([str(py), "-m", "pip", "install", "--upgrade", "pip"],
                       check=True, capture_output=True, timeout=120)
        subprocess.run([str(py), "-m", "pip", "install", "-r", str(req_file)],
                       check=True, timeout=600)
    else:
        subprocess.run([str(py), "-m", "pip", "install", "--upgrade", "pip"],
                       check=True, capture_output=True, timeout=120)
        subprocess.run([str(py), "-m", "pip", "install"] + CORE_REQUIREMENTS,
                       check=True, timeout=600)
    ok("依赖安装完成")


def _init_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "files").mkdir(parents=True, exist_ok=True)
    ok("数据目录与日志目录已就绪")


# ---------------------------------------------------------------- 服务管理
def _start_service(http_port: int, ws_port: int, detach: bool = False) -> None:
    if detach:
        if not is_windows():
            raise RuntimeError("--detach 仅支持 Windows（通过计划任务脱离会话）")
        _start_detached(http_port, ws_port)
        return

    py = venv_python()
    if not py.exists():
        raise RuntimeError("venv 不存在，请先运行 python deploy.py setup")
    if _port_in_use(http_port):
        raise RuntimeError(f"HTTP 端口 {http_port} 已被占用，服务可能已在运行")
    if _port_in_use(ws_port):
        raise RuntimeError(f"WS 端口 {ws_port} 已被占用")

    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    log_fp = open(LOG_FILE, "ab", buffering=0)

    cmd = [str(py), "run.py", "--host", "0.0.0.0", "--http", str(http_port), "--ws", str(ws_port)]
    kwargs: dict = {}
    if is_windows():
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
    else:
        kwargs["start_new_session"] = True
    proc = subprocess.Popen(
        cmd, cwd=str(BASE_DIR), stdout=log_fp, stderr=log_fp, stdin=subprocess.DEVNULL, **kwargs
    )
    PID_FILE.write_text(str(proc.pid), encoding="utf-8")
    ok(f"服务已启动 PID={proc.pid} → {LOG_FILE}")
    info(f"HTTP http://0.0.0.0:{http_port} · WS ws://0.0.0.0:{ws_port}/ws")


def _start_detached(http_port: int, ws_port: int) -> None:
    """通过计划任务在独立会话中启动服务（绕过 Job Object / 父进程回收）。

    步骤：
      1. 用 schtasks 注册一个「立即触发」的一次性计划任务；
      2. 任务执行 tools/detached_start.py，由其 Popen 启动 run.py 并写 PID；
      3. 轮询等待 PID 文件出现且健康。
    """
    if _port_in_use(http_port):
        raise RuntimeError(f"HTTP 端口 {http_port} 已被占用，服务可能已在运行")
    if _port_in_use(ws_port):
        raise RuntimeError(f"WS 端口 {ws_port} 已被占用")

    helper = BASE_DIR / "tools" / "detached_start.py"
    if not helper.exists():
        raise RuntimeError(f"缺少辅助脚本 {helper}")

    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    task_name = f"WuhouChat_{http_port}_{int(time.time())}"
    # 触发时间设为 1 分钟后，再用 /RUN 立即触发（保证任务已注册完成）
    trigger_time = (time.strftime("%H:%M", time.localtime(time.time() + 1)))
    cmd_line = (
        f'"{sys.executable}" "{helper}" --http {http_port} --ws {ws_port}'
    )

    # 注册一次性任务
    r = subprocess.run(
        ["schtasks", "/Create", "/TN", task_name, "/TR", cmd_line,
         "/SC", "ONCE", "/ST", trigger_time, "/F"],
        capture_output=True, text=True, timeout=30,
        encoding="utf-8", errors="replace",
    )
    if r.returncode != 0:
        raise RuntimeError("schtasks 创建任务失败：" + (r.stderr or r.stdout or "").strip()[-200:])

    # 立即触发
    r = subprocess.run(
        ["schtasks", "/Run", "/TN", task_name],
        capture_output=True, text=True, timeout=30,
        encoding="utf-8", errors="replace",
    )
    if r.returncode != 0:
        raise RuntimeError("schtasks 触发任务失败：" + (r.stderr or r.stdout or "").strip()[-200:])

    info(f"已通过计划任务 {task_name} 启动（HTTP {http_port} / WS {ws_port}）…")

    # 轮询等待 PID 文件出现且端口健康
    pid = None
    for _ in range(60):
        time.sleep(0.5)
        if PID_FILE.exists():
            try:
                pid = int(PID_FILE.read_text(encoding="utf-8").strip())
                if pid > 0 and _port_in_use(http_port):
                    break
            except Exception:
                pass
        # 任务可能失败，提前检查
        if _port_in_use(http_port):
            break

    if pid and _port_in_use(http_port):
        ok(f"服务已启动 PID={pid}（计划任务 {task_name} 已保留）")
        info(f"HTTP http://0.0.0.0:{http_port} · WS ws://0.0.0.0:{ws_port}/ws")
    else:
        # 清理失败的任务，避免残留
        subprocess.run(["schtasks", "/Delete", "/TN", task_name, "/F"],
                       capture_output=True, text=True, timeout=30,
                       encoding="utf-8", errors="replace")
        raise RuntimeError("脱离式启动失败：服务未在预期时间内就绪（详见 logs/chat.log）")


def _read_pid() -> int | None:
    if not PID_FILE.exists():
        return None
    try:
        return int(PID_FILE.read_text(encoding="utf-8").strip())
    except Exception:
        return None


def _pid_alive(pid: int) -> bool:
    if is_windows():
        try:
            r = subprocess.run(["tasklist", "/FI", f"PID eq {pid}"],
                               capture_output=True, text=True, timeout=20,
                               encoding="utf-8", errors="replace")
            return str(pid) in r.stdout
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _stop_service() -> None:
    pid = _read_pid()
    if not pid:
        warn("未找到 PID 文件，服务可能未运行")
        return
    if not _pid_alive(pid):
        warn(f"PID {pid} 已不在运行，清理 PID 文件")
        PID_FILE.unlink(missing_ok=True)
        return
    info(f"停止服务 PID={pid} …")
    if is_windows():
        subprocess.run(["taskkill", "/PID", str(pid), "/F"],
                       capture_output=True, text=True, timeout=30,
                       encoding="utf-8", errors="replace")
    else:
        try:
            os.kill(pid, signal.SIGTERM)
            for _ in range(30):
                if not _pid_alive(pid):
                    break
                time.sleep(0.5)
            else:
                os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    PID_FILE.unlink(missing_ok=True)
    ok("服务已停止")


def _service_status(http_port: int) -> None:
    pid = _read_pid()
    alive = pid is not None and _pid_alive(pid)
    if alive:
        ok(f"服务运行中（PID={pid}）")
    else:
        warn("服务未运行")
    # 端口探活
    if _port_in_use(http_port):
        ok(f"HTTP 端口 {http_port} 正在监听")
    else:
        warn(f"HTTP 端口 {http_port} 未监听")
    # 健康
    health = _http_get(f"http://127.0.0.1:{http_port}/api/meta", timeout=3)
    if health is not None:
        try:
            d = json.loads(health)
            if d.get("ok"):
                ok(f"/api/meta 健康（{d.get('data', {}).get('app', '')}）")
                return
        except Exception:
            pass
        warn("/api/meta 响应异常")
    else:
        warn("/api/meta 不可达")


def _http_get(url: str, timeout: int = 5) -> str | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.read().decode("utf-8", "ignore")
    except Exception:
        return None


def _wait_health(http_port: int, tries: int = 30, gap: float = 1.0) -> bool:
    info("等待服务健康 …")
    for i in range(tries):
        body = _http_get(f"http://127.0.0.1:{http_port}/api/meta", timeout=2)
        if body is not None:
            try:
                d = json.loads(body)
                if d.get("ok"):
                    ok("服务健康检查通过")
                    return True
            except Exception:
                pass
        time.sleep(gap)
    fail("服务健康检查超时")
    return False


# ---------------------------------------------------------------- 一键部署
def _run_deploy(http_port: int, ws_port: int, fix: bool, detach: bool = False) -> int:
    print(c("========== 武侯Chat 一键部署 ==========", _CYAN))
    problems = []

    print("\n── 1. 环境自检 ──")
    problems += _check_python()
    problems += _check_venv()
    problems += _check_dependencies()
    problems += _check_waf()

    print("\n── 2. 配置安全基线 ──")
    if fix:
        _fix_env()
    problems += _check_env()

    print("\n── 3. 端口检查 ──")
    problems += _check_ports(http_port, ws_port)

    if problems:
        print(c("\n❌ 部署前检查未通过：", _RED))
        for p in problems:
            fail(p)
        print("\n请处理上述问题后重试；或运行 python deploy.py setup 自动修复环境与 .env。")
        return 1

    print("\n── 4. 环境准备（幂等）──")
    _init_dirs()
    if not venv_python().exists():
        _create_venv()
        _install_deps()
    else:
        ok("venv 已就绪，跳过依赖安装（如需重装请删除 venv 后 setup）")

    print("\n── 5. 启动服务 ──")
    _start_service(http_port, ws_port, detach=detach)
    if not _wait_health(http_port):
        return 1

    print(c("\n✅ 部署完成！", _GREEN))
    info(f"访问 http://127.0.0.1:{http_port}")
    warn("生产发布前请执行 python deploy.py check --fix 并确认 CORS/域名。")
    return 0


# ---------------------------------------------------------------- 地址改写
def _rewrite_urls(base_url: str, cors: str | None, ws_port: int | None,
                  redis_url: str | None, rabbit_url: str | None,
                  ftp_host: str | None) -> int:
    """把 .env 中的本地/开发地址统一改写为服务器地址。

    仅改写以下键（其余配置保持不动）：
      PUBLIC_BASE_URL  -> 服务器对外地址（必改）
      CORS_ORIGINS     -> 默认与 base_url 相同
      REDIS_URL / RABBIT_URL / FTP_HOST -> 可选，默认保留现值
    """
    base_url = base_url.rstrip("/")
    if not ENV_FILE.exists():
        fail(".env 不存在，请先运行 python deploy.py setup 生成")
        return 1

    cors_value = (cors if cors is not None else base_url).strip()

    lines = ENV_FILE.read_text(encoding="utf-8").splitlines()
    updates = []

    def _set_key(lines: list[str], key: str, value: str) -> list[str]:
        """替换 KEY= 行的值；不存在则在文件末尾追加。返回是否发生替换。"""
        prefix = key + "="
        for i, line in enumerate(lines):
            stripped = line.strip()
            if stripped.startswith("export "):
                stripped = stripped[7:].strip()
            if stripped.startswith(prefix):
                lines[i] = f"{key}={value}"
                return True
        lines.append(f"{key}={value}")
        return True

    # PUBLIC_BASE_URL
    if _set_key(lines, "PUBLIC_BASE_URL", base_url):
        updates.append(f"PUBLIC_BASE_URL -> {base_url}")

    # CORS_ORIGINS
    if _set_key(lines, "CORS_ORIGINS", cors_value):
        updates.append(f"CORS_ORIGINS    -> {cors_value}")

    # WebSocket 端口：若指定且不同于 HTTP，写入 WS_PORT 键（config.py 已支持 ws_port 覆盖）
    if ws_port is not None:
        if _set_key(lines, "WS_PORT", str(ws_port)):
            updates.append(f"WS_PORT         -> {ws_port}")

    # 可选：Redis / RabbitMQ / FTP
    if redis_url is not None:
        if _set_key(lines, "REDIS_URL", redis_url):
            updates.append(f"REDIS_URL       -> {redis_url}")
    if rabbit_url is not None:
        if _set_key(lines, "RABBIT_URL", rabbit_url):
            updates.append(f"RABBIT_URL      -> {rabbit_url}")
    if ftp_host is not None:
        if _set_key(lines, "FTP_HOST", ftp_host):
            updates.append(f"FTP_HOST        -> {ftp_host}")

    ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(c("── 地址改写完成 ──", _CYAN))
    for u in updates:
        ok(u)
    info("前端 WebSocket 地址已改为从 /api/meta 动态获取（无需再改前端代码）")
    warn("请确认 .env 中 ADMIN_USERNAME/ADMIN_PASSWORD/SECRET_KEY 等敏感项无误后再启动。")
    return 0


def _fix_env() -> None:
    """把 .env 的 CAPTCHA_DEBUG/DEBUG/DEPLOY_ENV 收敛为生产值（CORS 除外）。"""
    if not ENV_FILE.exists():
        return
    lines = ENV_FILE.read_text(encoding="utf-8").splitlines()
    changed = False
    out = []
    for line in lines:
        raw = line
        stripped = line.strip()
        if stripped.startswith("export "):
            stripped = stripped[7:].strip()
        if stripped.startswith("CAPTCHA_DEBUG=") and stripped.split("=", 1)[1].strip() == "1":
            line = line.replace("CAPTCHA_DEBUG=1", "CAPTCHA_DEBUG=0")
            changed = True
        elif stripped.startswith("DEBUG=") and stripped.split("=", 1)[1].strip() == "1":
            line = line.replace("DEBUG=1", "DEBUG=0")
            changed = True
        elif stripped.startswith("DEPLOY_ENV="):
            val = stripped.split("=", 1)[1].strip().strip('"').strip("'")
            if val.lower() != "prod":
                line = line.replace("DEPLOY_ENV=" + val, "DEPLOY_ENV=prod")
                changed = True
        out.append(line)
    if changed:
        ENV_FILE.write_text("\n".join(out) + "\n", encoding="utf-8")
        ok("已把 .env 收敛为生产值（CAPTCHA_DEBUG=0 / DEBUG=0 / DEPLOY_ENV=prod）")
        warn("CORS_ORIGINS 请手动改为真实域名。")
    else:
        ok(".env 已满足生产基线（无需收敛）")


# ---------------------------------------------------------------- 主入口
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="deploy.py",
        description="武侯Chat 服务器部署工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = p.add_subparsers(dest="command", required=True)

    sp = sub.add_parser("check", help="环境与配置自检")
    sp.add_argument("--fix", action="store_true", help="先把 .env 收敛为生产值再检查")
    sp.add_argument("--http", type=int, default=DEFAULT_HTTP_PORT)
    sp.add_argument("--ws", type=int, default=DEFAULT_WS_PORT)

    sp = sub.add_parser("setup", help="创建 .env + 安装依赖 + 初始化目录")
    sp.add_argument("--force", action="store_true", help="覆盖已有 .env（谨慎）")
    sp.add_argument("--skip-env", action="store_true", help="跳过 .env 生成")

    sp = sub.add_parser("start", help="后台启动服务")
    sp.add_argument("--http", type=int, default=DEFAULT_HTTP_PORT)
    sp.add_argument("--ws", type=int, default=DEFAULT_WS_PORT)
    sp.add_argument("--detach", action="store_true",
                    help="Windows：通过计划任务脱离当前会话启动（适用于 SSH/远程/受限环境）")

    sub.add_parser("stop", help="停止服务")
    sp = sub.add_parser("restart", help="重启服务")
    sp.add_argument("--http", type=int, default=DEFAULT_HTTP_PORT)
    sp.add_argument("--ws", type=int, default=DEFAULT_WS_PORT)
    sp.add_argument("--detach", action="store_true",
                    help="Windows：通过计划任务脱离当前会话启动")
    sp = sub.add_parser("status", help="查看服务状态")
    sp.add_argument("--http", type=int, default=DEFAULT_HTTP_PORT)
    sp = sub.add_parser("health", help="健康检查")
    sp.add_argument("--http", type=int, default=DEFAULT_HTTP_PORT)

    sp = sub.add_parser("deploy", help="一键部署（check+setup+start+health）")
    sp.add_argument("--fix", action="store_true", help="部署前把 .env 收敛为生产值")
    sp.add_argument("--http", type=int, default=DEFAULT_HTTP_PORT)
    sp.add_argument("--ws", type=int, default=DEFAULT_WS_PORT)
    sp.add_argument("--detach", action="store_true",
                    help="Windows：通过计划任务脱离当前会话启动")

    sp = sub.add_parser("rewrite", help="把所有本地/开发地址改写为服务器地址（部署前必用）")
    sp.add_argument("--base-url", required=True,
                    help="服务器对外地址，如 https://chat.example.com（写入 PUBLIC_BASE_URL）")
    sp.add_argument("--cors", default=None,
                    help="CORS 允许来源，默认与 --base-url 相同；多个用逗号分隔")
    sp.add_argument("--ws-port", type=int, default=None,
                    help="WebSocket 对外端口（默认与 HTTP 同端口走反代时无需设置；独立 WS 端口时填写）")
    sp.add_argument("--redis-url", default=None, help="Redis 连接串（默认保留 .env 现值）")
    sp.add_argument("--rabbit-url", default=None, help="RabbitMQ 连接串（默认保留 .env 现值）")
    sp.add_argument("--ftp-host", default=None, help="FTP 服务器地址（默认保留 .env 现值）")

    return p


def main() -> int:
    args = build_parser().parse_args()
    cmd = args.command

    if cmd == "check":
        problems = []
        print("── 环境自检 ──")
        problems += _check_python()
        problems += _check_venv()
        problems += _check_dependencies()
        problems += _check_waf()
        print("── 配置安全基线 ──")
        if getattr(args, "fix", False):
            _fix_env()
        problems += _check_env()
        print("── 端口检查 ──")
        problems += _check_ports(args.http, args.ws)
        if problems:
            print(c("\n❌ 自检未通过：", _RED))
            for p in problems:
                fail(p)
            return 1
        print(c("\n✅ 自检全部通过。", _GREEN))
        return 0

    if cmd == "setup":
        _init_dirs()
        if not getattr(args, "skip_env", False):
            _setup_env(force=getattr(args, "force", False))
        _create_venv()
        _install_deps()
        ok("setup 完成。可运行 python deploy.py start 启动服务。")
        return 0

    if cmd == "start":
        _start_service(args.http, args.ws, detach=getattr(args, "detach", False))
        return 0 if _wait_health(args.http) else 1

    if cmd == "stop":
        _stop_service()
        return 0

    if cmd == "restart":
        _stop_service()
        time.sleep(1)
        _start_service(args.http, args.ws, detach=getattr(args, "detach", False))
        return 0 if _wait_health(args.http) else 1

    if cmd == "status":
        _service_status(args.http)
        return 0

    if cmd == "health":
        if _wait_health(args.http, tries=3, gap=0.5):
            return 0
        return 1

    if cmd == "deploy":
        return _run_deploy(args.http, args.ws, getattr(args, "fix", False),
                           detach=getattr(args, "detach", False))

    if cmd == "rewrite":
        return _rewrite_urls(args.base_url, args.cors, args.ws_port,
                             args.redis_url, args.rabbit_url, args.ftp_host)

    print(f"未知命令：{cmd}")
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n已取消。")
        sys.exit(130)
    except Exception as e:  # 顶层兜底，避免裸 traceback
        fail(f"部署失败：{e}")
        sys.exit(1)