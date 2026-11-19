#!/usr/bin/env bash
# curl parallel 独立传输；Python标准库仅负责状态、配置和输出，不调用C++。
set -eu
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec python3 -I "$HERE/upload_batch.py" --curl "$@"
