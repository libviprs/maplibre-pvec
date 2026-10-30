#!/usr/bin/env bash
# Runs the browser grid (#81) in one throw-away Playwright container on the docker host and copies the
# JSON reports back into job-reports/. Firefox gets WebGL2 from xvfb-run, WebKit and Chromium run as is.
#   tools/run-grid.sh                 pinned Chromium 130, Firefox 131, WebKit 18.0 plus an older Chromium
#   CHROMIUM_MIN_PW=1.31.2 tools/run-grid.sh   pick which Playwright release supplies the older Chromium
# The grid projects pass or fail on their own. The isolated (COOP/COEP) projects are informational: their
# report is written, and a failure there does not change this script's exit code.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
NASSH=${NASSH:-/Users/rom/workspace/libviprs/tools/nas.sh}
NAS=${NAS:-devshell@192.168.0.100}
NAME=mlp-grid-$$
PW_IMAGE=${PW_IMAGE:-mcr.microsoft.com/playwright:v1.48.2-jammy}
OLD=${CHROMIUM_MIN_PW:-1.31.2}
trap '"$NASSH" clean "$NAME" >/dev/null 2>&1 || true' EXIT
"$NASSH" push "$HERE" "$NAME"
cmd="npm ci --no-audit --no-fund >/dev/null 2>&1 && mkdir -p job-reports"
# The older Chromium comes from an older Playwright release, installed into its own browsers path.
cmd="$cmd && PLAYWRIGHT_BROWSERS_PATH=/old npx --yes playwright@$OLD install chromium >/dev/null 2>&1"
cmd="$cmd && export PW_CHROMIUM_MIN=\$(ls -d /old/chromium-*/chrome-linux/chrome | head -1) && echo old chromium: \$(\$PW_CHROMIUM_MIN --version)"
cmd="$cmd && { PLAYWRIGHT_JSON_OUTPUT_NAME=job-reports/grid.json xvfb-run -a npx playwright test --reporter=json,list --project=grid-chromium --project=grid-chromium-min --project=grid-firefox --project=grid-webkit; echo GRID-EXIT=\$?; }"
cmd="$cmd ; { PLAYWRIGHT_JSON_OUTPUT_NAME=job-reports/isolated.json xvfb-run -a npx playwright test --reporter=json,list --project=isolated-chromium --project=isolated-firefox --project=isolated-webkit; echo ISOLATED-EXIT=\$?; }"
out=$("$NASSH" run "$NAME" "$PW_IMAGE" "$cmd" 2>&1) || true
echo "$out" | grep -v '^{' | tail -80
mkdir -p "$HERE/job-reports"
for f in grid isolated; do
  ssh -o BatchMode=yes -o LogLevel=ERROR "$NAS" "cat /work/nas-work/$NAME/job-reports/$f.json" > "$HERE/job-reports/$f.json.new" && mv "$HERE/job-reports/$f.json.new" "$HERE/job-reports/$f.json" || echo "no $f report"
done
echo "$out" | grep -q 'GRID-EXIT=0' || { echo "grid failed" >&2; exit 1; }
