#!/bin/zsh

set -e
cd "$(dirname "$0")"

if curl -fsS http://localhost:3000/ >/dev/null 2>&1; then
  open http://localhost:3000/
  exit 0
fi

npm run dev &
tracker_pid=$!

for attempt in {1..60}; do
  if curl -fsS http://localhost:3000/ >/dev/null 2>&1; then
    open http://localhost:3000/
    wait $tracker_pid
    exit 0
  fi
  sleep 1
done

echo "投递管理系统未能启动，请保留此窗口并检查上方提示。"
wait $tracker_pid
