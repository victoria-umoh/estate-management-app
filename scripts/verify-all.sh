#!/usr/bin/env bash
#
# Every gate, in the order that fails fastest and cheapest first.
#
# The order is deliberate. Typecheck and lint take seconds and catch most
# mistakes; the unit suite takes a minute; the build takes two and also checks
# navigation coverage and bundle budgets; smoke and the end-to-end suite need a
# running server with seeded data and take longest. Running them the other way
# round means waiting five minutes to be told about a missing import.
#
# `pnpm build` and `pnpm dev` write incompatible output to the same `.next`, so
# this stops the dev server, builds, then starts it fresh for the checks that
# need one. Doing it any other way leaves every route returning 500 with
# `routes-manifest.json` missing — which cost three separate debugging detours
# before anyone wrote it down.
#
#   ./scripts/verify-all.sh            # everything
#   ./scripts/verify-all.sh --fast     # skip the end-to-end suite
set -uo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-3800}"
BASE="http://localhost:${PORT}"
FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

failed=()
step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
check() { if [ "$1" -eq 0 ]; then echo "   ok"; else echo "   FAILED"; failed+=("$2"); fi; }

stop_dev() { lsof -ti:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true; sleep 2; }

start_dev() {
  stop_dev
  nohup pnpm dev >/tmp/verify-dev.log 2>&1 &
  # Wait for readiness rather than sleeping a guessed interval: a cold compile
  # after `clean` is much slower than a warm start.
  for _ in $(seq 1 60); do
    if curl -sf -o /dev/null "${BASE}/api/health"; then return 0; fi
    sleep 2
  done
  echo "   dev server never became healthy; see /tmp/verify-dev.log"
  return 1
}

step "Typecheck"
pnpm typecheck >/dev/null 2>&1; check $? typecheck

step "Lint"
pnpm lint >/dev/null 2>&1; check $? lint

step "Unit and integration tests"
pnpm test 2>&1 | tail -3; check "${PIPESTATUS[0]}" tests

step "Build, navigation coverage and bundle budgets"
stop_dev
pnpm clean >/dev/null 2>&1
pnpm build 2>&1 | grep -E "Navigation:|within budget|over budget|shared by all"
check "${PIPESTATUS[0]}" build

step "Starting a fresh dev server"
pnpm clean >/dev/null 2>&1
start_dev; check $? "dev server"

step "Database indexes"
pnpm db:indexes 2>&1 | grep -E "total|FAIL"; check "${PIPESTATUS[0]}" indexes

step "Index audit: query plans and tenant scoping"
pnpm audit:indexes 2>&1 | tail -2; check "${PIPESTATUS[0]}" "index audit"

step "Seeding the demo estate"
pnpm seed:demo --reset >/dev/null 2>&1; check $? seed

step "OpenAPI document is current"
pnpm openapi >/dev/null 2>&1 && pnpm openapi --check >/dev/null 2>&1; check $? openapi

step "Smoke: every screen and permission boundary, per role"
BASE_URL="$BASE" pnpm smoke 2>&1 | tail -3; check "${PIPESTATUS[0]}" smoke

if [ "$FAST" -eq 0 ]; then
  step "End to end"
  E2E_BASE_URL="$BASE" pnpm test:e2e --reporter=list 2>&1 | tail -3
  check "${PIPESTATUS[0]}" e2e
fi

printf '\n\033[1m== Result ==\033[0m\n'
if [ "${#failed[@]}" -eq 0 ]; then
  echo "   Everything passed."
  exit 0
fi

echo "   Failed: ${failed[*]}"
exit 1
