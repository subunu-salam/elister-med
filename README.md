# Elister Med — clinic management platform

A multi-tenant clinic / medical-centre platform for the UAE (AED, Asia/Dubai, English + Arabic with RTL). Next.js App Router, TypeScript strict, MongoDB, Better Auth.

**Read `docs/status.md` first**: it states exactly what is built and tested, and what is not. All modules in the brief have working domain logic, tests and UI (patients through hospital extensions). External integrations are sandbox-only.

All data is synthetic. Nothing here claims regulatory certification or a live government integration.

## Quick start (no database account needed)

```bash
npm install
npm run dev:local      # in-memory MongoDB replica set + seeded demo org + Next.js on :3000
```

Sign in at http://localhost:3000 with `admin@demo.local`, `reception@demo.local`, `dr.amina@demo.local`, `nurse@demo.local`, `accountant@demo.local`, `finance@demo.local`, `pharmacist@demo.local`, `lab1@demo.local`, `insurance@demo.local`, `inventory@demo.local`, `hr@demo.local`, `director@demo.local`, `auditor@demo.local` or `patient@demo.local` (portal). Password (demo only): `Demo-Only-Pass-2026!`. Data is discarded when you stop it.

## Against MongoDB Atlas

1. Copy `.env.example` to `.env.local` and fill in `MONGODB_URI` (use a UAE region cluster), `MONGODB_DB`, `AUTH_SECRET` (random, 32+ chars) and `FIELD_ENCRYPTION_KEY` (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`). Also set `BETTER_AUTH_URL` to the app's public URL.
2. Allow your IP in Atlas network access. Transactions need a replica set (all Atlas tiers have one).
3. `npm run seed` then `npm run dev`.

## Scripts

| Command | What |
|---|---|
| `npm run dev` | Next.js dev server (needs `.env.local`) |
| `npm run dev:local` | Self-contained dev environment (in-memory DB) |
| `npm run seed` | Idempotent synthetic org, users, chart of accounts, periods, services |
| `npm test` | Vitest (209 tests, in-memory replica set, never touches Atlas) |
| `npm run test:e2e` | Playwright (Scenario A and E, access control, RTL, smoke of every module page, portal) |
| `npm run typecheck`, `npm run lint`, `npm run build` | Static checks and production build |

## Layout

```
src/core/      db (tenant layer), auth, rbac, audit, outbox/worker, money, time, crypto, locks
src/modules/   org, patients, appointments, queue, emr, billing, ledger, finance, reports, dashboard, insurance,
               pharmacy, inventory, procurement, laboratory, radiology, hr, crm, communications, compliance,
               integrations, specialty, hospital, ai, portal, prefs
src/app/       routes, server actions, SSE and search endpoints
src/ui/        design kit and application shell
docs/          spec, plan, status, compliance gaps, integration readiness, security
```

Rule for modules: authorize → validate (Zod) → transact → audit → emit event. Modules call each other's service functions, not each other's collections.

## Docs

`docs/superpowers/specs/…design.md` (decisions) · `docs/superpowers/plans/…` (build plan) · `docs/status.md` · `docs/compliance-gap-register.md` · `docs/integration-readiness.md` · `docs/security.md`
