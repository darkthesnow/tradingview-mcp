#!/bin/bash
#
# 把上游项目（tradesdontlie/tradingview-mcp）的新提交合并进本地分支。
#
#   origin          自己的私有仓库，推送目标
#   upstream        上游开源项目，只读，只用来拉取
#   main            上游 main 的镜像，只做快进
#   tradingview_mcp main + 本地改动，上游 main 合并到这里
#
# 用法: scripts/sync_upstream.sh [--dry-run] [--no-push]
#   --dry-run  只列出上游有哪些新提交，不做任何改动
#   --no-push  在本地合并并测试，但不推送
#
# 合并有冲突、或 lint / 单元测试失败时，会把分支恢复到合并前再退出。
# 不运行端到端测试（它会改动正在使用的 TradingView 图表），不强制推送，不变基。
#
# 注意: 变量后面紧跟着中文标点时要写成 ${VAR}，否则 bash 可能把标点的第一个字节
# 当成变量名的一部分，在 set -u 下报"unbound variable"。

set -euo pipefail

WORK_BRANCH=tradingview_mcp
MIRROR_BRANCH=main

DRY_RUN=false
PUSH=true
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --no-push) PUSH=false ;;
    -h|--help) sed -n '3,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: ${arg}（可用: --dry-run --no-push）" >&2; exit 2 ;;
  esac
done

step() { printf '\n== %s ==\n' "$1"; }
stop() { printf '\n已停止: %s\n' "$1" >&2; exit 1; }

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || true
[ -n "$ROOT" ] || stop "当前不在 git 仓库里"
cd "$ROOT"

# ── 开始前的检查：任何一项不满足都不改动仓库 ──

step "检查仓库状态"
for remote in origin upstream; do
  git remote get-url "$remote" >/dev/null 2>&1 || stop "缺少远程 ${remote}"
done
[ "$(git remote get-url --push origin)" != "$(git remote get-url upstream)" ] \
  || stop "origin 和 upstream 指向同一个仓库"
echo "origin:   $(git remote get-url --push origin)"
echo "upstream: $(git remote get-url upstream)"

CURRENT=$(git rev-parse --abbrev-ref HEAD)
[ "$CURRENT" = "$WORK_BRANCH" ] || stop "当前在 ${CURRENT} 分支，请先执行: git switch ${WORK_BRANCH}"

DIRTY=$(git status --porcelain | grep -v '^?? \.DS_Store$' || true)
[ -z "$DIRTY" ] || stop "工作区有未提交的改动，先提交或暂存它们:
${DIRTY}"

for marker in MERGE_HEAD REBASE_HEAD CHERRY_PICK_HEAD; do
  if git rev-parse -q --verify "$marker" >/dev/null 2>&1; then
    stop "有一个进行中的操作（${marker}），先处理完再同步"
  fi
done

# ── 拉取上游 ──

step "拉取上游"
GIT_TERMINAL_PROMPT=0 git fetch upstream || stop "拉取上游失败（网络问题？）"
git rev-parse -q --verify upstream/main >/dev/null 2>&1 || stop "upstream 上没有 main 分支"

NEW_WORK=$(git rev-list --count "${WORK_BRANCH}..upstream/main")
NEW_MIRROR=$(git rev-list --count "${MIRROR_BRANCH}..upstream/main")
if [ "$NEW_WORK" = 0 ] && [ "$NEW_MIRROR" = 0 ]; then
  echo "上游没有新提交，无需同步。"
  exit 0
fi

echo "还没合入 ${WORK_BRANCH} 的上游提交（${NEW_WORK} 个）:"
git log --oneline "${WORK_BRANCH}..upstream/main" | head -30
if [ "$NEW_WORK" -gt 30 ]; then echo "  … 其余 $((NEW_WORK - 30)) 个省略"; fi

if [ "$DRY_RUN" = true ]; then
  echo "（--dry-run：没有做任何改动）"
  exit 0
fi

# ── 快进镜像分支 ──

step "快进 ${MIRROR_BRANCH}"
git show-ref --verify --quiet "refs/heads/${MIRROR_BRANCH}" || git branch "$MIRROR_BRANCH" upstream/main
git fetch upstream "main:${MIRROR_BRANCH}" 2>&1 | tail -2 \
  || stop "上游 main 无法快进（历史可能被改写），请手动检查: git log --oneline ${MIRROR_BRANCH}..upstream/main"

# ── 合并 ──

step "合并 upstream/main 到 ${WORK_BRANCH}"
BEFORE=$(git rev-parse HEAD)
DEPS_CHANGED=false

undo_merge() {
  git reset --keep -q "$BEFORE"
  if [ "$DEPS_CHANGED" = true ]; then npm ci >/dev/null 2>&1 || true; fi
  echo "已把 ${WORK_BRANCH} 恢复到合并前（$(git rev-parse --short HEAD)）。" >&2
}

if ! git merge --no-edit upstream/main; then
  CONFLICTS=$(git diff --name-only --diff-filter=U | tr '\n' ' ')
  git merge --abort
  stop "合并有冲突，已撤销，分支保持原样。冲突的文件: ${CONFLICTS}
想手动解决就执行: git merge upstream/main"
fi
MERGE=$(git rev-parse --short HEAD)

if [ -n "$(git diff --name-only "$BEFORE" HEAD -- package.json package-lock.json)" ]; then
  DEPS_CHANGED=true
  step "依赖有变化，重新安装"
  npm ci || { undo_merge; stop "npm ci 失败"; }
fi

# ── 测试：只跑 lint 和单元测试 ──

step "lint 和单元测试"
npm run lint --silent || { undo_merge; stop "lint 没有通过（输出见上）"; }

TEST_LOG=$(mktemp)
if npm run test:unit --silent >"$TEST_LOG" 2>&1; then
  grep -E '^ℹ (tests|pass|fail) ' "$TEST_LOG" | tr '\n' ' '; echo
else
  tail -40 "$TEST_LOG" >&2
  rm -f "$TEST_LOG"
  undo_merge
  stop "单元测试没有通过（失败详情见上）"
fi
rm -f "$TEST_LOG"

# ── 推送 ──

if [ "$PUSH" = true ]; then
  step "推送到 origin"
  git push -u origin "$MIRROR_BRANCH" "$WORK_BRANCH" \
    || stop "推送失败。本地已经合并好，可以稍后手动执行: git push origin ${MIRROR_BRANCH} ${WORK_BRANCH}"
  PUSHED="，并已推送到 origin"
else
  PUSHED="（--no-push：没有推送）"
fi

step "完成"
echo "合并提交 ${MERGE} 已落在 ${WORK_BRANCH}，lint 和单元测试通过${PUSHED}。"
echo "提醒: ZCode 里正在运行的 MCP 服务器要重连，才会用上更新后的代码。"
