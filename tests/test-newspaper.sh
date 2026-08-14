#!/usr/bin/env bash
set -euo pipefail

ROOT=${1:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)}
ROOT=$(cd -- "$ROOT" && pwd -P)
TMP=$(mktemp -d)
cleanup() { rm -rf -- "$TMP"; }
trap cleanup EXIT

mkdir -p "$TMP/state/current" "$TMP/state/status"
printf '# Small headline\n\nA compact edition.\n' >"$TMP/state/current/hourly.md"
printf '%s\n' '{"state":"running","stage":"writer","last_activity_at":"2026-08-14T02:00:00Z"}' >"$TMP/state/status/hourly.json"
QQ_NEWSPAPER_STATE_ROOT="$TMP/state" QQ_NEWSPAPER_PANEL_ONCE=1 \
  "$ROOT/bin/qq-newspaper-panel" hourly >"$TMP/panel"
grep -Fq 'the qq newspaper · HOURLY' "$TMP/panel"
grep -Fq 'WRITER · activity' "$TMP/panel"
grep -Fq 'A compact edition.' "$TMP/panel"

cat >"$TMP/herdr" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$QQ_TEST_CALLS"
case "$1 $2" in
  'workspace list') printf '%s\n' '{"id":"x","result":{"type":"workspace_list","workspaces":[{"workspace_id":"w1","label":"qq"}]}}' ;;
  'tab list') printf '%s\n' '{"id":"x","result":{"type":"tab_list","tabs":[]}}' ;;
  'tab create') printf '%s\n' '{"id":"x","result":{"type":"tab_created","tab_id":"w1:t1","root_pane":{"pane_id":"w1:p1"}}}' ;;
  'pane split')
    count=$(grep -c '^pane split' "$QQ_TEST_CALLS")
    printf '{"id":"x","result":{"type":"pane_info","pane":{"pane_id":"w1:p%s"}}}\n' "$((count + 1))"
    ;;
  *) printf '%s\n' '{"id":"x","result":{"type":"ok"}}' ;;
esac
SH
chmod +x "$TMP/herdr"
cat >"$TMP/qq-herdr-pane-add" <<'SH'
#!/usr/bin/env bash
pane=$1
shift
exec herdr pane split "$pane" --direction right "$@"
SH
chmod +x "$TMP/qq-herdr-pane-add"
QQ_TEST_CALLS="$TMP/calls" QQ_NEWSPAPER_FOCUS=0 PATH="$TMP:$PATH" \
  "$ROOT/bin/qq-newspaper-open" >"$TMP/open"
grep -Fq 'qq newspaper opened: w1:t1' "$TMP/open"
grep -Fq "pane run w1:p1 $ROOT/bin/qq-newspaper-panel hourly" "$TMP/calls"
grep -Fq "pane run w1:p2 $ROOT/bin/qq-newspaper-panel daily" "$TMP/calls"
grep -Fq "pane run w1:p3 $ROOT/bin/qq-newspaper-panel weekly" "$TMP/calls"

grep -Fq 'OnCalendar=*-*-* *:00:00' "$ROOT/systemd/user/qq-newspaper-hourly.timer"
grep -Fq 'OnCalendar=*-*-* 05:00:00' "$ROOT/systemd/user/qq-newspaper-daily.timer"
grep -Fq 'OnCalendar=Mon *-*-* 06:00:00' "$ROOT/systemd/user/qq-newspaper-weekly.timer"
grep -Fq 'TimeoutStartSec=6h' "$ROOT/systemd/user/qq-newspaper@.service"
grep -Fq 'WorkingDirectory=%h/projects/qq-newspaper' "$ROOT/systemd/user/qq-newspaper@.service"
systemd-analyze calendar '*-*-* *:00:00' >/dev/null
systemd-analyze calendar '*-*-* 05:00:00' >/dev/null
systemd-analyze calendar 'Mon *-*-* 06:00:00' >/dev/null

echo 'newspaper display tests passed'
