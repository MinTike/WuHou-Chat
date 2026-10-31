# 武侯Chat · 开源框架

> 武侯Chat（WuHou Chat）前端界面框架 + 后端脚手架。
> 本项目仅包含**框架代码**，不含任何业务核心逻辑与生产密钥，可安全公开与二次开发。
>
> © 2026 左熙宇 · 本仓库采用 **Apache License 2.0** 开源，详见 [LICENSE](./LICENSE)。

---

## 目录结构

```
wuhou-chat-framework/
├── static/            # 前端全部代码（UI 壳层 + 通用组件 + 业务前端，见下方说明）
│   ├── index.html     # 入口页（登录/注册/主应用）
│   ├── admin.html     # 管理端页面
│   ├── waf.html       # WAF 拦截页
│   ├── css/           # 主题 / 布局 / 组件 / 玻璃拟态 / 动效样式
│   ├── js/            # 前端模块（ES Module）
│   └── img/           # 图标与品牌资源
├── run.py             # 启动入口（FastAPI HTTP + aiohttp WebSocket 网关）
├── deploy.py          # 部署 / 运维脚本（含 SECRET_KEY 自动生成与合规自检）
├── requirements.txt   # Python 依赖
├── SSRF_AUDIT.md   # SSRF 安全审计报告（含预置校验模块说明）
├── .env.example       # 环境变量模板（占位符，无真实密钥）
└── .gitignore         # 已覆盖密钥/运行时数据/构建产物
```

## 前端（static/）

前端为原生 HTML/CSS/JS（ES Module），无构建步骤，由后端直接托管。

- 双端独立界面：桌面端三栏（`shell-desktop.js`）、移动端 App 形态（`shell-mobile.js`），由 `formfactor.js` 自动切换。
- 视觉体系：glassmorphism + 极光渐变 + neumorphism，含 3D 倾斜、粒子氛围、品牌页增强。
- 认证页：登录/注册为两张可拖拽的玻璃卡片，含滑动人机检测。
- WAF 独立控制台前端：`waf.html` / `waf.js` / `boot-waf.js` / `css/waf.css`（对应后端 `/app/waf` 引擎不在本仓库）。

> 注意：`static/js/` 下的业务模块（聊天、加密、实时通道、动态等）也一并开源，但**对应后端接口不在本仓库**。

## 启动（开发环境）

```bash
# 1. 创建虚拟环境并安装依赖
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt   # Windows
# .venv/bin/pip install -r requirements.txt       # Linux/macOS

# 2. 从模板生成环境变量（自动生成随机 SECRET_KEY）
python deploy.py env

# 3. 启动
python run.py --http 8000 --ws 8001
```

打开 http://127.0.0.1:8000 即可访问。

## 安全设计（框架层）

- **配置驱动外连**：服务端所有外部连接（地理位置、文件存储、Redis 等）均由 `.env` 配置，前端不直接接触外部 URL。
- **SSRF 防护**：`SSRF_AUDIT_2026-10-30.md` 记录了完整审计过程，并为未来「URL 抓取类」功能预置了目标校验模块（协议白名单、内网/云元数据拦截、DNS 重绑定缓解）。
- **密钥管理**：`SECRET_KEY`/`ADMIN_PASSWORD` 等由 `deploy.py env` 自动生成随机值，`.env` 永不入库。
- **WAF**：内置进程内 WAF 引擎，规则 28 条，入站 SSRF 规则已覆盖。

## 开源范围与边界

| 包含（本仓库）                          | 不包含（核心/私有）                      |
| --------------------------------------- | ---------------------------------------- |
| `static/` 前端全部（含 WAF 前端页面）     | `app/` 后端业务逻辑与安全引擎            |
| `run.py` / `deploy.py` / `requirements.txt` | `clients/` 桌面/移动客户端               |
| `.env.example` / `.gitignore`           | `data/`（运行时数据/托管密钥）           |
| `SSRF_AUDIT_2026-10-30.md`（审计）       | `logs/` / `venv/` / `.env`               |
| `README.md` / `icon.png` / 品牌资源      | 支付二维码、内部脚本                     |

如你需要完整后端（FastAPI + 加密 + 实时通道 + WAF 引擎），请联系作者授权获取私有仓库。

## License

本仓库采用 **Apache License 2.0** 开源。

```
Copyright © 2026 左熙宇（MinTike）

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

完整许可文本见 [LICENSE](./LICENSE)。