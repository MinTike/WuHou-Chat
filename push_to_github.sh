#!/usr/bin/env bash
# ============================================================
# 武侯Chat · 框架一键上传 GitHub（在可联网环境运行）
# 用法：
#   bash push_to_github.sh <仓库名>
#   例： bash push_to_github.sh wuhou-chat-framework
# 可选：第二个参数为可见性 public/private（默认 public）
# ============================================================
set -euo pipefail

REPO_NAME="${1:-}"
VISIBILITY="${2:-public}"
GH_USER="MinTike"

if [ -z "$REPO_NAME" ]; then
  echo "用法: bash $0 <仓库名> [public|private]" >&2
  exit 1
fi

cd "$(dirname "$0")"

echo "==> [1/4] 校验本地提交"
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "错误：当前目录不是 git 仓库" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "警告：存在未提交的改动，先自动提交" >&2
  git add -A
  git commit -m "chore: 同步更新" >/dev/null || true
fi
echo "本地提交：$(git log --oneline -1)"

echo "==> [2/4] 通过 GitHub API 创建仓库（需已登录凭据）"
# 从 git 凭据管理器读取 token（避免明文存储）
CREDS=$(git credential fill <<< $'protocol=https\nhost=github.com\n' 2>/dev/null || true)
TOKEN=$(printf '%s\n' "$CREDS" | sed -n 's/^password=//p')
if [ -z "$TOKEN" ]; then
  echo "错误：未找到 GitHub 凭据。请先运行：git credential-manager github login" >&2
  exit 1
fi

# 已存在则复用，否则创建
REPO_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: token $TOKEN" \
  "https://api.github.com/repos/$GH_USER/$REPO_NAME" || true)
if [ "$REPO_STATUS" = "200" ] || [ "$REPO_STATUS" = "301" ]; then
  echo "仓库已存在，复用：$GH_USER/$REPO_NAME"
else
  echo "创建仓库 $REPO_NAME（$VISIBILITY）..."
  CREATE_STATUS=$(curl -s -o /tmp/gh_create.json -w "%{http_code}" \
    -X POST -H "Authorization: token $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -d "{\"name\":\"$REPO_NAME\",\"private\":$([ "$VISIBILITY" = private ] && echo true || echo false),\"description\":\"武侯Chat 开源框架：前端 UI 壳层 + 后端脚手架（不含核心代码）\",\"has_issues\":true,\"has_wiki\":false}" \
    "https://api.github.com/user/repos" || true)
  if [ "$CREATE_STATUS" = "201" ] || [ "$CREATE_STATUS" = "422" ]; then
    # 201=创建成功；422=已存在（同名），继续复用
    echo "仓库就绪（HTTP $CREATE_STATUS）"
  else
    echo "创建仓库失败（HTTP $CREATE_STATUS），响应：" >&2
    cat /tmp/gh_create.json 2>/dev/null || true
    echo >&2
    exit 1
  fi
fi

echo "==> [3/4] 关联远程仓库"
if git remote | grep -q '^origin$'; then
  git remote set-url origin "https://github.com/$GH_USER/$REPO_NAME.git"
else
  git remote add origin "https://github.com/$GH_USER/$REPO_NAME.git"
fi

echo "==> [4/4] 推送"
# Windows Git 常见问题：schannel 证书吊销检查失败（CRYPT_E_NO_REVOCATION_CHECK）
# 这通常发生在企业代理/受限网络下。只在失败时自动关闭吊销检查并重试一次。
if ! git push -u origin main; then
  if git config --get http.schannelCheckRevoke >/dev/null 2>&1; then
    echo "推送失败且已配置过 schannelCheckRevoke，请手动检查" >&2
    exit 1
  fi
  echo "检测到推送失败，尝试关闭 schannel 证书吊销检查后重试..."
  git config http.schannelCheckRevoke false
  git push -u origin main
fi
echo
echo "✅ 完成：https://github.com/$GH_USER/$REPO_NAME"