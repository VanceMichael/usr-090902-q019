#!/bin/sh
# 一键端到端核对：从空库启动，制造缺口与并发改签，跨数据库重启核对水位/冲突/游标。
set -eu
cd "$(dirname "$0")/.."

COMPOSE="docker compose"
BASE="http://127.0.0.1:8080"

echo "== 清理旧环境（含持久卷，确保空库） =="
$COMPOSE down -v --remove-orphans

echo "== 构建并启动 db + app =="
$COMPOSE up -d --build db app

echo "== 阶段 1 =="
node scripts/e2e.mjs --phase=1 --base="$BASE"

echo "== 重启数据库（持久卷保留） =="
$COMPOSE restart db

echo "== 阶段 2 =="
node scripts/e2e.mjs --phase=2 --base="$BASE"

echo "== 端到端核对全部通过 =="
