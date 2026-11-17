#!/usr/bin/env bash
# Vercel build. In demo mode (ELISTER_DEMO=1) it first loads synthetic demo data into MONGODB_DB (idempotent), then builds.
set -euo pipefail
if [[ "${ELISTER_DEMO:-}" == "1" && -n "${MONGODB_URI:-}" ]]; then
  export SEED_PASSWORD="${SEED_PASSWORD:-elister123}" SEED_DEMO_ACTIVITY=1
  echo "▶ Demo mode: seeding ${MONGODB_DB:-healthos_dev}"
  npx tsx scripts/seed.ts
  npx tsx scripts/seed-books.ts
  npx tsx scripts/seed-accounts.ts
  # recent days of clinic activity for dashboards and the assistant's report (tops up each deploy; never fails the build)
  npx tsx scripts/seed-rolling.ts || echo "seed-rolling skipped"
fi
npx next build
