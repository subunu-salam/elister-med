# UAE Healthcare OS — Phases 0–4 (Scenario A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (user chose native execution, no approval pauses). Steps use checkbox syntax.

**Goal:** A runnable multi-tenant clinic platform where a self-pay patient goes register → book → check-in → consult → charge → invoice → pay → ledger → dashboard, all persisted, permission-checked and audited.

**Architecture:** Next.js App Router modular monolith. MongoDB Atlas via the official driver with Zod schemas. All data access goes through a tenant-scoped layer. Mutations follow authorize → validate → transact → audit → outbox event. Ledger is append-only, posted in a Mongo transaction with idempotency keys.

**Tech Stack:** Next.js, TypeScript strict, Tailwind, shadcn/Radix, Motion, TanStack Query/Table, React Hook Form + Zod, Recharts, FullCalendar, `mongodb`, Better Auth (+TOTP), decimal.js, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-03-uae-healthcare-os-design.md`

## Global Constraints

- TypeScript `strict: true`. Currency AED, timezone Asia/Dubai, languages en + ar (RTL).
- Money: `Decimal128` in DB, `decimal.js` in code. No `number` arithmetic on money.
- Every document has `orgId`; no raw collection access outside `src/core/db`.
- Every mutation: authorize → Zod validate → transaction → audit → outbox event.
- Posted journal entries and signed notes are immutable; corrections are new linked records.
- Secrets only in `.env.local` (gitignored); `.env.example` has placeholders.
- Synthetic data only. No claim of regulatory certification or live government integration.
- Dashboards read real data; deterministic.

## Review Focus

- Two parallel bookings for the same doctor slot → exactly one succeeds.
- User of org A requests org B record by id → not-found, never data.
- Payment request retried with same idempotency key → one ledger entry.
- Posting into a locked fiscal period → rejected.
- Arabic name / RTL / empty-state / zero-invoice dashboard → renders, no NaN.

---

### Task 0: Scaffold and tooling

**Files:** Create `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `.env.local` (untracked), `vitest.config.ts`, `playwright.config.ts`, `src/app/layout.tsx`, `src/app/page.tsx`.

**Interfaces:** Produces `npm run dev|test|test:e2e|lint|typecheck`.

- [ ] Step 1: Scaffold Next.js (TS, Tailwind, App Router, `src/`) in repo root with `create-next-app`; add deps listed in Tech Stack; init shadcn.
- [ ] Step 2: Write `.env.local` with `MONGODB_URI` (Atlas, user-supplied), `MONGODB_DB=healthos_dev`, `AUTH_SECRET` (random), `FIELD_ENCRYPTION_KEY` (random 32 bytes b64); `.env.example` with placeholders; ensure `.env*.local` gitignored.
- [ ] Step 3: Verify `npm run typecheck && npm run lint && npm test` pass on an empty smoke test.
- [ ] Step 4: Commit `chore: scaffold app`.

### Task 1: Core primitives (money, errors, ids, time)

**Files:** Create `src/core/money.ts`, `src/core/errors.ts`, `src/core/ids.ts`, `src/core/time.ts`; Test `src/core/money.test.ts`.

**Interfaces:** Produces `Money` helpers: `money(v: string|number): Decimal`, `toDecimal128(d: Decimal): Decimal128`, `fromDecimal128(x): Decimal`, `sum(ds: Decimal[]): Decimal`, `round2(d): Decimal`; `AppError(code, message, status)` with codes `FORBIDDEN|NOT_FOUND|CONFLICT|VALIDATION|PERIOD_LOCKED|UNBALANCED`; `newId(): string` (ObjectId hex); `dubaiDayRange(date): {start: Date, end: Date}`.

- [ ] Step 1: Tests: `money('0.1').plus('0.2').equals('0.3')`; Decimal128 round trip; `dubaiDayRange` boundaries at UTC+4.
- [ ] Step 2: Run, see fail. Step 3: Implement. Step 4: Run, pass. Step 5: Commit.

### Task 2: Tenant-scoped data layer

**Files:** Create `src/core/db/client.ts`, `src/core/db/tenant.ts`, `src/core/db/indexes.ts`; Test `src/core/db/tenant.test.ts` (against Atlas test DB `healthos_test`).

**Interfaces:** Produces `getClient()`, `withTransaction<T>(fn: (s: ClientSession) => Promise<T>): Promise<T>`, `tenantCol<T>(orgId: string, name: string): TenantCollection<T>` with `find/findOne/insertOne/updateOne/count` that always inject `orgId`; `ensureIndexes()`.

- [ ] Step 1: Test: insert doc under org A; `tenantCol(B).findOne({_id})` returns null; insert without orgId impossible by type.
- [ ] Step 2–4: Implement, run, pass. Add ESLint `no-restricted-imports` banning direct `mongodb` collection use outside `src/core/db`.
- [ ] Step 5: Commit.

### Task 3: Audit log and outbox

**Files:** Create `src/core/audit.ts`, `src/core/outbox.ts`, `src/core/worker.ts`; Tests alongside.

**Interfaces:** Produces `audit(s: ClientSession, e: {orgId, actorId, action, resource, resourceId, before?, after?}): Promise<void>`; `emit(s, orgId, type: string, payload: object)`; `startWorker(handlers)` with retry count and `deadLetter` status. Audit collection exposes no update/delete function.

- [ ] Steps: test audit row written inside transaction and rolled back with it; test failing handler retries then dead-letters; implement; commit.

### Task 4: Auth, RBAC, `authorize()`

**Files:** Create `src/core/auth/index.ts` (Better Auth + mongodb adapter + TOTP), `src/core/rbac/permissions.ts`, `src/core/rbac/roles.ts`, `src/core/rbac/authorize.ts`, `src/app/login/page.tsx`; Test `src/core/rbac/authorize.test.ts`.

**Interfaces:** Produces `type Permission = \`${Resource}:${'view'|'create'|'update'|'approve'|'export'|'audit'}\``; `ROLE_PERMISSIONS: Record<RoleKey, Permission[]>` for the 18 roles; `authorize(perm: Permission): Promise<Ctx>` where `Ctx = {userId, orgId, branchId, roles, permissions}`; throws `FORBIDDEN`.

- [ ] Steps: matrix tests (receptionist cannot `ledger:view`; doctor cannot `ledger:create`; auditor read-only; marketing-type access to `emr:view` denied); implement; login page with MFA enroll/verify; commit.

### Task 5: Organizations, branches, seed

**Files:** Create `src/modules/org/service.ts`, `scripts/seed.ts`; Test `src/modules/org/service.test.ts`.

**Interfaces:** Produces `createOrg`, `createBranch`, `getOrgConfig(orgId)`; seed creates a synthetic Dubai multi-specialty org, 1 branch, departments, users for each needed role, chart of accounts, open fiscal period, doctors, a service catalog with prices and tax codes (flagged "tax review required").

- [ ] Steps: test seed idempotent (run twice → same counts); implement; commit.

### Task 6: App shell and design system

**Files:** Create `src/ui/shell/*` (sidebar, command palette, org/branch selector, notifications, theme, language switcher, breadcrumbs), `src/ui/tokens.css`, `src/i18n/{en,ar}.json`, `src/i18n/index.ts`.

**Interfaces:** Produces `<AppShell nav={NavItem[]}>`; nav filtered by permissions (cosmetic only); `t(key)`; `dir` switching on `ar`.

- [ ] Steps: inspect reference site via browser, record IA in `docs/design/reference-notes.md`; build shell; Playwright test: login as receptionist → sidebar lacks Accounting; toggle Arabic → `dir="rtl"`; commit.

### Task 7: Patients

**Files:** Create `src/modules/patients/{schema,service,search}.ts`, `src/app/(app)/patients/**`; Test `service.test.ts`.

**Interfaces:** Produces `createPatient(ctx, input): Promise<Patient>` (MRN from per-org atomic counter, Emirates ID encrypted), `searchPatients(ctx, q): Promise<PatientHit[]>` (name/phone/MRN, duplicate hint), `getPatient(ctx,id)`.

- [ ] Steps: tests (unique sequential MRN under 20 parallel creates; org isolation; ID stored encrypted, not plaintext in DB; Arabic name searchable; audit written); implement multi-step registration form; commit.

### Task 8: Appointments

**Files:** Create `src/modules/appointments/{schema,service,availability}.ts`, calendar UI; Test `service.test.ts`.

**Interfaces:** Produces `bookAppointment(ctx, {patientId, doctorId, start, end, type}): Promise<Appointment>`; unique index (orgId, doctorId, slotStart) plus overlap check in transaction; `rescheduleAppointment`, `cancelAppointment`, `markNoShow`; state machine booked→checked_in→in_consult→completed|cancelled|no_show.

- [ ] Steps: test 10 parallel books of same slot → 1 success, 9 `CONFLICT`; leave/holiday blocks; invalid transition rejected; implement drag-and-drop reschedule calling same service; commit.

### Task 9: Check-in, queue, SSE

**Files:** Create `src/modules/queue/service.ts`, `src/app/api/queue/stream/route.ts`, queue board UI, public token display.

**Interfaces:** Produces `checkIn(ctx, appointmentId): Promise<Token>` (daily per-branch counter), `callNext(ctx, doctorId)`, `skip`, `estimateWaitMinutes(ctx, doctorId)` from recent actual consult durations; SSE emits `queue.updated` scoped by orgId/branch.

- [ ] Steps: tests (token numbers unique/sequential; SSE client of org B receives nothing for org A; public display payload has no name fields); implement; commit.

### Task 10: EMR encounter

**Files:** Create `src/modules/emr/{schema,service}.ts`, encounter workspace UI.

**Interfaces:** Produces `openEncounter(ctx, appointmentId)`, `saveDraftNote(ctx, encounterId, soap)`, `signNote(ctx, noteId)`, `amendNote(ctx, noteId, soap, reason): Note` (new version, `supersedes` link), `addDiagnosis`, `recordVitals`, `completeEncounter`.

- [ ] Steps: tests (edit of signed note rejected; amend creates v2 and keeps v1; non-doctor cannot sign; allergy alert surfaced in workspace payload; every read audited); implement; commit.

### Task 11: Charges

**Files:** Create `src/modules/billing/charges.ts`.

**Interfaces:** Consumes `completeEncounter`. Produces `addCharge(ctx, {encounterId, serviceId, qty}): Charge` (price + tax code from catalog, Decimal128), `listUnbilledCharges(ctx, patientId)`. Completing an encounter auto-creates the consultation charge per facility rule.

- [ ] Steps: test completing encounter yields exactly one consultation charge even if called twice; implement; commit.

### Task 12: Ledger

**Files:** Create `src/modules/ledger/{accounts,journal,periods}.ts`; Tests.

**Interfaces:** Produces `postJournal(ctx, {date, lines: {accountId, debit, credit, dims}[], sourceRef, idempotencyKey}): JournalEntry` — rejects unbalanced (`UNBALANCED`), locked period (`PERIOD_LOCKED`), inactive account; duplicate key returns original entry. `reverseJournal(ctx, entryId, reason)`. `lockPeriod`. No update/delete function for posted entries.

- [ ] Steps: tests (balance check with 0.1+0.2 amounts; idempotent retry; locked period; reversal nets to zero; trial balance sums to zero); implement; commit.

### Task 13: Invoices, payments, receipts

**Files:** Create `src/modules/billing/{invoice,payment,receipt}.ts`, billing UI (dynamic cart), PDF receipt.

**Interfaces:** Produces `finalizeInvoice(ctx, {patientId, chargeIds}): Invoice` (numbering sequence, VAT per tax code, posts Dr AR / Cr Revenue / Cr VAT via `postJournal`), `recordPayment(ctx, {invoiceId, method, amount, idempotencyKey}): Payment` (Dr Cash|Bank / Cr AR; partial and split supported), `issueCreditNote`, `refund`.

- [ ] Steps: tests (finalize twice → one invoice; payment retry with same key → one entry; overpayment becomes customer advance; invoice+payment leave AR zero; org isolation); implement; commit.

### Task 14: Reports and dashboards

**Files:** Create `src/modules/reports/{pnl,trialBalance,arAging,revenueBy}.ts`, `src/modules/dashboard/{executive,reception,doctor,accounts}.ts`, dashboard UIs with date/branch filters and prior-period comparison.

**Interfaces:** Produces query functions `(ctx, {from, to, branchId?, departmentId?}) => Result` computed from ledger and clinical collections only.

- [ ] Steps: tests with a fixed fixture (known totals; empty-range returns zeros not NaN; revenue by doctor sums to P&L revenue); implement; commit.

### Task 15: Scenario A end to end and reconciliation

**Files:** Create `e2e/scenario-a.spec.ts`, `src/modules/ledger/reconcile.test.ts`.

- [ ] Step 1: Playwright: reception creates patient → books → checks in → doctor consults, signs, completes → reception finalizes invoice, takes payment → receipt → accounts dashboard shows revenue and cash; refresh persists.
- [ ] Step 2: Property-style test: random sequence of invoices/payments/credit notes → Σ AR subledger equals GL AR balance; trial balance zero.
- [ ] Step 3: Write `docs/status.md` (implemented/tested vs sandbox vs pending), `docs/compliance-gap-register.md`, `docs/integration-readiness.md`, `README.md` setup. Commit.

## Self-review notes

- Spec §5–7 covered by Tasks 7–14; §4 by 2–5; §9 by 0, 3, 4, 15 docs; §10 by tests per task and 15; §8 deferred to later plans by design.
- Types consistent: `Ctx` from Task 4 is the first param of every service function.
