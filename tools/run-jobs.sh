#!/usr/bin/env bash
# Runs the four conformance jobs one after another, each with its own JSON report, then prints
# the independent results. Launch through /Users/rom/workspace/xdg-pw-lock.sh.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p job-reports
for job in math range rendering interaction; do
  PLAYWRIGHT_JSON_OUTPUT_NAME="job-reports/$job.json" \
    npx playwright test --reporter=json,list --pass-with-no-tests \
    --project="$job-chromium" --project="$job-firefox" --project="$job-webkit" || true
done
node tools/check-jobs.mjs job-reports
