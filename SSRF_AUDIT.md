# 武侯Chat · SSRF（服务端请求伪造）专项审计报告

- **审计日期**：2026-10-30
- **审计范围**：`app/` 全部后端代码
- **审计目标**：识别所有服务端发起的网络请求，验证是否存在 SSRF（Server-Side Request Forgery）漏洞
- **审计方法**：静态代码审计 + 关键点动态验证（`ipaddress` 绕过测试）
- **总体结论**：**未发现可利用的 SSRF 漏洞（风险评级：低）**

---

## 一、服务端外连点清单

经全量代码扫描，武侯Chat 后端存在 **4 个**服务端外连点，全部**连接目标来自服务端配置**，不直接受用户请求参数控制。

| # | 位置 | 库 | 连接目标 | 触发条件 | 用户可控性 |
|---|------|-----|---------|---------|-----------|
| 1 | `app/core/geo.py::_remote()` | `aiohttp` | `settings.geo_lookup_url`（默认 `http://ip-api.com/json/{ip}...`） | 公网 IP 登录/查询归属地 | 仅 `{ip}` 占位符，且经 `ipaddress` 严格校验 |
| 2 | `app/core/files.py` | `ftplib` | `settings.ftp_host:ftp_port` | `ftp_enabled=True` 时文件存取 | 无（连接参数全部来自配置） |
| 3 | `app/core/store.py` | `redis.asyncio` | `settings.redis_url` | 存储读写 | 无（配置） |
| 4 | `app/mq.py` | `aio_pika` | `settings.rabbit_url` | 事件总线 | 无（配置） |

**排除项（非 SSRF）：**
- `app/routers/waf.py::panel_proxy()` — 名称含 "proxy" 但实际是**进程内 WAF 状态直读**（`_dispatch_panel` 纯本地函数），不发起任何外部 HTTP 请求。
- `app/core/scan.py` — 上传文件检测，纯本地特征码比对，无外部请求。
- `app/core/badwords_data.py` — 内置静态违规词库，无远程下载。
- `app/main.py` 的 CSP 外链（高德/ArcGIS 地图瓦片） — 前端浏览器行为，非服务端请求。

---

## 二、各入口 SSRF 风险分析

### 2.1 `geo.py` — IP 归属地查询（唯一 HTTP 外连）

**调用链**：
```
用户登录 → device_of() → client_ip() → geo.lookup(ip) → _remote(ip)
                                                    → aiohttp GET settings.geo_lookup_url.replace("{ip}", ip)
```

**防护现状**：

1. **IP 来源可信**：`deps.py::client_ip()` 已实施 P1-⑥ 修复——**默认不信任 `X-Forwarded-For`**，仅当请求直连自 `trusted_proxies` 白名单时才采信 XFF 首值。默认 `trusted_proxies=""`，攻击者无法伪造 IP。
2. **IP 格式严格校验**：`geo.classify()` 使用 `ipaddress.ip_address()` 解析，任何畸形输入（`@`、`#`、八进制 `0177.0.0.1`、十进制整数 `2130706433`、域名、`1.1.1.1:80`、路径注入等）全部抛 `ValueError` 并被拦截。
3. **内网/保留地址拦截**：`classify()` 对 loopback / private / link-local / reserved / multicast / 运营商 NAT（`100.64.0.0/10`）直接返回本地可读名称，**不发起远程查询**。
4. **模板不可控**：`geo_lookup_url` 来自 `.env`/环境变量，无管理接口可运行时修改（已确认 admin 路由无配置写入点）。
5. **失败静默降级**：任何异常返回 `None`，不影响主流程。

**动态验证（ipaddress 绕过测试）**：实测 18 种畸形/编码 IP，全部被 `ipaddress.ip_address()` 拒绝：
```
'1.1.1.1@evil.com'      → INVALID
'1.1.1.1#@evil'         → INVALID
'0x7f000001'            → INVALID
'2130706433'            → INVALID
'0177.0.0.1'            → INVALID
'127.1'                 → INVALID
'1.1.1.1:80'            → INVALID
'example.com'           → INVALID
'1.1.1.1/../../etc/passwd' → INVALID
'::ffff:127.0.0.1'      → loopback=True → 拦截（本地）
'fe80::1%eth0'          → link-local → 拦截
```

**结论**：`{ip}` 替换进 URL 后只能是合法 IP 字面量（数字/点/冒号），**无法注入 URL 结构、协议或主机**。该入口**不存在可利用 SSRF**。

**残余风险（极低）**：
- 若运维将 `geo_lookup_url` 配置为含用户可控片段的模板（如内部服务地址），且 `trusted_proxies` 误配为攻击者可达代理，理论上可被用于「对指定公网 IP 发起第三方 HTTP 请求」（请求反射）。但这两个前提同时成立才可利用，且影响仅为「让服务端替你 GET 一个公网 URL」，不构成内网探测。
- `geo_lookup_url` 使用 **HTTP 明文**（默认 `http://ip-api.com`），存在中间人篡改响应风险（影响归属地展示，不涉及密钥）。

### 2.2 `files.py` — FTP 文件存储

**调用链**：
```
上传 → FileStore.put(fid, data) → _ftp_put() → ftplib.FTP.connect(settings.ftp_host, settings.ftp_port)
下载 → FileStore.get("ftp", path) → _ftp_get(path) → ftplib.FTP.connect(settings.ftp_host, settings.ftp_port)
```

**防护现状**：
- 连接参数（`ftp_host`/`ftp_port`/`ftp_user`/`ftp_password`/`ftp_root`）**全部来自配置**，无用户输入。
- 写入的文件名 `fid` 由 `secrets.token_hex(10)` 生成，**用户不可控**，无文件名注入 FTP 命令（`STOR`/`RETR`）风险。
- `path` 由服务端生成（`{fid}.bin`），读取时从数据库元数据取回，用户不可控。
- 默认 `ftp_enabled=False`，FTP 外连**默认关闭**。

**结论**：**无 SSRF**。

### 2.3 `store.py` / `mq.py` — Redis / RabbitMQ

- 连接串全部来自配置（`redis_url`/`rabbit_url`），无用户输入。
- 生产环境启动闸门 `_enforce_secure_startup()` 会对非本机 Redis 地址告警。
- 消息内容只作为 AMQP 消息体/路由键，**不参与连接地址构造**。

**结论**：**无 SSRF**。

---

## 三、WAF 层 SSRF 防护（纵深防御）

项目内置的 WAF 引擎（`app/core/wafengine.py`）已具备对**入站 SSRF 探测**的检测能力：

```python
_SSRF_INTERNAL = re.compile(
    r"(?i)(?:\blocalhost\b|\b127\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b0\.0\.0\.0\b|\b169\.254\.\d{1,3}\.\d{1,3}\b|"
    r"\b192\.168\.\d{1,3}\.\d{1,3}\b|\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|"
    r"\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b|\b::1\b|\bfc00:|\bfe80:|"
    r"169\.254\.169\.254|instance-data|metadata\.google\.|metadata\.aliyuncs\.com|100\.100\.100\.200)")
_SSRF_PROTO = re.compile(r"(?i)^(?:file|gopher|dict|ftp|ftps|tftp|ldap|ldaps|telnet|ssh|scp|smb|redis|mongodb|mysql):")
```

- `_SSRF_INTERNAL`：拦截请求中出现的内网 IP / 云元数据地址（169.254.169.254 等）。
- `_SSRF_PROTO`：拦截 `file://`、`gopher://`、`dict://`、`ftp://` 等 SSRF 常用协议。

该防护作用于**入站请求内容检测**，可拦截攻击者向本站发起的 SSRF 探测载荷，属于有效的纵深防御层。

---

## 四、修复建议（低优先级加固）

虽然未发现可利用漏洞，建议做以下低成本加固，提升纵深防御水平：

| 优先级 | 建议 | 位置 | 状态 |
|--------|------|------|------|
| 🟢 低 | **`geo_lookup_url` 默认改用 HTTPS**（`https://ipwho.is/...`），避免响应被中间人篡改 | `app/config.py` | ✅ 已实施 |
| 🟢 低 | **`_remote()` 增加响应内容校验**：仅接受 JSON 且必须含 `ip` 字段回显，防止第三方接口被恶意替换返回内容 | `app/core/geo.py` | ✅ 已实施 |
| 🟢 低 | **增加出站代理开关**：在企业内网环境，可将 geo 查询显式走正向代理，避免直连外网 | `app/config.py` | ✅ 已实施 |
| 🟢 低 | **FTP 连接地址增加协议白名单**：集中 `_ftp_connect()` 校验主机格式（拒绝协议前缀/`@`/路径/空白），并限制端口范围 | `app/core/files.py` | ✅ 已实施 |
| 🟢 低 | **WAF 入站 SSRF 规则已覆盖**，建议保持；若未来新增「URL 抓取类」功能（如头像外链、链接预览），必须在服务端做目标地址校验（DNS 解析后检查是否为内网 IP，并禁止重定向） | 未来功能 | ✅ 已预置模块（见 6.5） |

---

## 六、修复实施记录（2026-10-30）

### 6.1 `app/config.py` — 默认 HTTPS + 出站代理
- `geo_lookup_url` 默认值由 `http://ip-api.com/json/{ip}...` 改为 **`https://ipwho.is/{ip}?fields=ip,success,country,region,city,isp`**（免费 HTTPS，字段与 `_parse_payload` 兼容）。
- 新增 **`geo_proxy: str = ""`** 配置项：企业内网部署时可指定正向代理，geo 查询走代理避免直连外网。

### 6.2 `app/core/geo.py` — 响应回显校验 + 代理支持
- `_remote()` 增加出站代理透传（`settings.geo_proxy`）。
- 新增 `_echoes_ip(ip, d)`：第三方响应**必须回显本次请求的 IP**（兼容 `ip` / `query` / `ip_address` / `addr` / `IPv4` 及嵌套 `data` 子对象），否则视为请求失败并静默降级。防止 DNS/HTTP 被劫持后返回伪造归属地，也避免缓存投毒。

### 6.3 `app/core/files.py` — FTP 目标校验
- 新增 `_ftp_connect()` 统一建立连接，集中校验：
  - 主机名拒绝空白、`/`、`\`、`@`、URL 协议前缀（`http://`、`gopher://` 等）
  - 支持 IPv4 / IPv6（裸 `::1` 与带括号 `[::1]`，连接时去括号）
  - 端口必须 `1-65535`
- `_ftp_put` / `_ftp_get` / `_ftp_delete` 全部复用 `_ftp_connect()`。

### 6.4 验证结果
| 验证项 | 结果 |
|--------|------|
| `_echoes_ip` 8 个用例（匹配/不匹配/嵌套/非 dict） | ✅ 全部通过 |
| `_ftp_connect` 11 个用例（合法主机/IPv6/恶意协议/用户信息/路径/空白/端口越界） | ✅ 全部通过 |
| `python -m py_compile` 三个修改文件 | ✅ 语法通过 |
| `tools/files_roundtrip_check.py`（上传/下载/兜底/404/拦截） | ✅ 通过 |
| `tools/smoke_test.py --base http://127.0.0.1:8123` 端到端 55 项 | ✅ **55 通过 / 0 失败** |

### 6.5 为未来「URL 抓取类」功能预置 SSRF 目标校验模块（2026-10-31）

审计报告中唯一标注「待未来功能落地」的加固项，现已落成可复用模块：

- **`app/core/ssrf.py`** — 服务端「URL 抓取目标」主动校验层：
  - 协议白名单（仅 `http` / `https`）；
  - 拒绝 URL 夹带用户信息、控制字符、空白、非法端口；
  - 内网 / 保留 / 云元数据 CIDR 拦截（含 `100.64/10` 运营商 NAT、`198.18/15` 基准测试段、IPv6 组播）；
  - IPv4-mapped IPv6（`::ffff:x.x.x.x`）按内嵌 IPv4 判断，防 `::ffff:127.0.0.1` 绕过；
  - 云元数据域名关键字预检（`metadata.google.internal` / `instance-data` / `169.254.169.254` 等）；
  - 域名先 DNS 解析再逐一校验 IP；
  - 附 DNS 重绑定防护说明（建立连接前复检对端 IP、禁止重定向）。
- **`tools/ssrf_guard_check.py`** — 61 项验证脚本：协议白名单 / URL 结构 / 内网 IP 字面量 / 编码绕过（八进制、十进制整数、十六进制、简写 loopback）/ 云元数据域名 / 域名解析后拦截 / 合法公网放行，**61/61 全部通过**。
- 回归：`tools/smoke_test.py --base http://127.0.0.1:8123` **55 项通过 / 0 失败**。

未来接入示例：
```python
from app.core import ssrf
result = await ssrf.validate_fetch_url(user_url)   # 发起请求前校验
if not result.ok:
    raise HTTPException(status_code=400, detail=result.reason)
# 然后才用 aiohttp / httpx 发起请求
```

---

## 七、结论（修复后）

| 维度 | 结论 |
|------|------|
| 可利用的 SSRF 漏洞 | **0** |
| 服务端外连点 | 4 个（全部配置驱动，无用户输入直达） |
| 用户可控制的 URL 注入点 | 0 |
| 内网/云元数据访问风险 | 无（classify 拦截 + 配置不可控 + 响应回显校验） |
| 明文 HTTP 归属地查询 | 已消除（默认 HTTPS） |
| 未来 URL 抓取功能 SSRF 防护 | ✅ 已预置 `app/core/ssrf.py`（协议白名单 + 内网/元数据拦截 + DNS 解析后校验 + DNS 重绑定说明） |
| 整体风险评级 | 🟢 **低** |

**核心判断**：本项目 SSRF 防护的核心优势在于 **「所有服务端外连目标均来自部署配置，且无任何接口接受用户提供的 URL/主机名」**。唯一带用户输入占位符的 `geo.py` 又经过严格的 `ipaddress` 校验 + 内网地址拦截 + 响应回显校验，无法被构造为 SSRF 跳板。审计建议的全部加固项（含为未来「URL 抓取类」功能预置的目标校验模块）均已落地，整体风险可控。

---

*审计人：Kimi K3.1 Pro · 项目：武侯Chat Free（版权 © 2026 左熙宇）*
