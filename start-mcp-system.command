#!/bin/zsh

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

NODE_BIN="/Applications/Codex.app/Contents/Resources/node"
LOG_FILE="$PROJECT_DIR/mcp-start-log.txt"

: > "$LOG_FILE"

if [[ ! -x "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "没有找到 Node.js，无法启动系统。" | tee -a "$LOG_FILE"
  echo "请先安装 Node.js，或使用 Codex 自带的 Node 运行。" | tee -a "$LOG_FILE"
  read -n 1 -s -r "?按任意键关闭..."
  exit 1
fi

if [[ ! -d "$PROJECT_DIR/node_modules" ]]; then
  echo "没有找到 node_modules，请先执行 npm install。" | tee -a "$LOG_FILE"
  echo "当前目录：$PROJECT_DIR" | tee -a "$LOG_FILE"
  read -n 1 -s -r "?按任意键关闭..."
  exit 1
fi

echo "正在启动 Amazon Sellersprite Selector..." | tee -a "$LOG_FILE"
echo "项目目录：$PROJECT_DIR" | tee -a "$LOG_FILE"
echo "Node：$NODE_BIN" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
echo "启动成功后，请打开：" | tee -a "$LOG_FILE"
echo "http://127.0.0.1:5173/" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
echo "注意：这个窗口不要关闭，关闭后网页就访问不了。" | tee -a "$LOG_FILE"
echo "如果失败，错误会保存到：$LOG_FILE" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

(
  sleep 6
  open "http://127.0.0.1:5173/" >/dev/null 2>&1 || true
) &

"$NODE_BIN" scripts/dev-with-bridge.mjs --host 127.0.0.1 --port 5173 2>&1 | tee -a "$LOG_FILE"
status=${pipestatus[1]}

echo ""
echo "系统已停止，退出码：$status" | tee -a "$LOG_FILE"
echo "请把这个窗口里的错误，或 mcp-start-log.txt 截图发给我。" | tee -a "$LOG_FILE"
read -n 1 -s -r "?按任意键关闭..."
