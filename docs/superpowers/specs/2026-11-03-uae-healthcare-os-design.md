# UAE Healthcare OS — Design Spec

Date: 2026-11-03
Status: Draft for user review
Source brief: the user's master build prompt (Parts 1–26). This spec records the decisions agreed in brainstorming. It does not restate the brief.

## 1. Intent

Build a real, multi-tenant clinic/medical-centre management platform for the UAE. The first tenant is a Dubai multi-specialty clinic (AED, Asia/Dubai, English/Arabic). Hospital modules are optional add-ons, off by default.

User wants the **complete** product, not a demo. Phases below are build order only. Nothing is dropped. Each phase must end working, tested and runnable.

Success criteria:
- Scenario A (self-pay consultation) works end to end with real persisted data and a balanced ledger. Scenarios B–E follow in later phases.
- Every action is permission-checked server-side and audited.
- Dashboards read only from real data. No random or static KPIs.
- No claim of regulatory certification or live government integration. Unavailable integrations are labelled sandbox adapters.

## 2. Decisions (approved)

| Area | Decision |
|---|---|
| Shape | One Next.js (App Router, TS strict) modular monolith. Not microservices. |
| Database | MongoDB Atlas (user-supplied cluster, dev only, synthetic data only). |
| DB access | Official `mongodb` driver + Zod schemas. **Not Prisma** (weak Mongo support: no FK constraints, limited transactions/migrations). |
| Money | `Decimal128` in DB, `decimal.js` in code. No floats. |
| Ledger | Append-only journal. Posting in a Mongo transaction. Idempotency keys + unique indexes. Corrections = reversing entries. |
| Auth | Better Auth, server-side sessions, TOTP MFA. |
| Authorization | Permission check in every server action/route handler via one `authorize()` helper. Navigation hiding is cosmetic only. |
| Tenancy | Every document has `orgId` (and `branchId` where relevant). One data-access layer injects `orgId`. Raw collection access outside it is lint-banned. |
| Realtime | Server-Sent Events (queue board, notifications). |
| Jobs | Mongo-backed outbox/queue with retries. Redis deferred until load needs it. |
| UI | Tailwind, shadcn/Radix, Motion, TanStack Query/Table, React Hook Form + Zod, Recharts, FullCalendar. |
| Tests | Vitest (domain/ledger/permissions), Playwright (workflows). |
| i18n | English + Arabic with RTL from day one. |

Risks to verify at scaffold time: Atlas network access for the dev IP, Atlas region (UAE preferred), Mongo transaction behaviour on the chosen tier, current stable library versions.

## 3. Module layout

```
src/
  core/        auth, tenancy, rbac, audit, config, events, jobs, errors
  modules/
    patients/ appointments/ queue/ emr/ billing/ ledger/ accounting/
    insurance/ pharmacy/ laboratory/ radiology/ inventory/ procurement/
    hr/ crm/ communications/ compliance/ integrations/ ai/ hospital/
  app/         routes, server actions, SSE endpoints
  ui/          design system, shell, shared components
```

Rules:
- A module exposes a typed service API and emits domain events. Other modules call the service API or subscribe to events. They never touch another module's collections.
- Modules are feature-flagged per organization. Hospital modules default off.
- Every mutation: authorize → validate (Zod) → transact → audit → emit event.

## 4. Core platform

**Identity and access.** Roles from the brief (18). Permission = `resource:action` (view/create/update/approve/export/audit). Roles map to permission sets, stored per org and editable. A patient-data access policy sits on top of resource permissions (purpose-limited; marketing roles never see clinical data). Break-glass: time-boxed, reason required, flagged for review.

**Audit.** Append-only `audit_log` (actor, orgId, action, resource, before/after hash, ip, time). Clinical reads are logged. No update or delete path exists in the data layer.

**Config.** Per-org: jurisdiction (DHA/DOH/MOHAP/DHCC), currency, timezone, language, enabled modules, tax rules, numbering sequences.

**Events and jobs.** Domain events written to an outbox in the same transaction as the change. A worker delivers them (notifications, projections, integration messages) with retry and a dead-letter state.

## 5. Clinical front office

- **Patients:** MRN sequence per org, bilingual names, identifiers (Emirates ID / passport) encrypted at field level, guardians, allergies, alerts, consents, communication preferences. Fuzzy search (name, phone, MRN, ID) with duplicate warning.
- **Appointments:** doctor availability, leave, holidays, rooms, durations, buffers. Double-booking prevented by a transactional slot check plus a unique index on (resource, slot). Drag-and-drop reschedule calls the same server check.
- **Queue:** check-in creates a token. State machine: waiting → called → in-consultation → completed/skipped. Wait estimate from actual queue data. Public board shows token numbers only.
- **EMR:** encounter workspace (SOAP, vitals, diagnoses, orders, prescriptions, follow-up). Note states: draft → signed. Signed notes are immutable. Amendments create new versions linked to the original. Templates per specialty. AI output stays draft until a clinician approves.
- **Billable capture:** a completed service creates a *charge*. Charges, invoices and payments are separate steps, per the brief.

## 6. Finance core

**Ledger model.**
- `accounts` (chart of accounts, per org, typed, with parent and dimensions).
- `journal_entries` + `journal_lines`: entry is balanced (Σdebit = Σcredit, checked in code and in the transaction), carries period, source ref, idempotency key, and status (draft → approved → posted). Posted entries are immutable. Reversal creates a new entry that references the original.
- `fiscal_periods` with locks. Posting into a locked period is rejected.
- Dimensions: branch, department, doctor, cost centre.

**Subledgers.** Invoices, payments, allocations, credit notes, refunds, advances. AR and AP derive from these and reconcile to GL control accounts. A reconciliation test must pass in CI.

**Flow for Scenario A.** Charge → invoice finalise (Dr AR, Cr Revenue, Cr VAT where applicable) → payment (Dr Cash/Bank, Cr AR) → receipt. Each step idempotent.

**VAT.** Configurable tax codes and rules per service. No service is assumed zero-rated. Default seed rules are marked "requires review by a UAE tax professional".

**E-invoicing.** Structured invoice model and an Accredited Service Provider adapter interface. Ships as a labelled sandbox. A PDF alone is never marked compliant.

**Reports.** P&L, balance sheet, trial balance, GL, AR/AP aging, revenue by department/doctor — all computed from the ledger.

## 7. Dashboards

Role dashboards (executive, reception, doctor, accounts, pharmacy, lab, management) read through query services with date/branch/department filters and prior-period comparison. Deterministic: same data, same numbers. Click-through drills to the underlying records. Cached with invalidation on relevant domain events.

## 8. Later modules (each gets its own spec → plan cycle)

1. Insurance/claims (Scenario B): payers, eligibility records, pre-auth, claim validation workbench, remittance reconciliation. Adapters for eClaimLink, Shafafiya, Riayati ship as sandbox.
2. Pharmacy + inventory + procurement (Scenarios D, E): batch/expiry/FEFO, no negative stock unless an authorised policy allows it.
3. Laboratory and radiology (Scenario C).
4. HR/payroll prep (licence, Emirates ID, visa expiry tracking).
5. CRM, communications, patient portal/kiosk.
6. Compliance module and integration readiness matrix (NABIDH, Malaffi, Riayati adapters: sandbox only until onboarding is real).
7. AI assistants (operational first, clinical drafting later). No identifiable data to external AI without approvals.
8. Specialty plugins (dental, derm, physio, paeds, chronic) and hospital modules (inpatient, ED, theatre).

## 9. Security and compliance posture

- Encryption in transit (TLS). At rest: Atlas encryption plus field-level encryption for national IDs.
- MFA for staff. Session timeout. Rate limiting on auth.
- Secrets only in `.env.local` (gitignored). `.env.example` committed with placeholders.
- A `docs/compliance-gap-register.md` and `docs/integration-readiness.md` track what is implemented versus externally verified. Wording is "technical control implemented", never "compliant/certified".
- Retention periods are jurisdiction config, not hardcoded.
- Development uses synthetic data only.

## 10. Testing and acceptance

- **Unit (Vitest):** money math, ledger balance, period locks, idempotency, permission matrix, state machines.
- **Integration:** transactional posting, concurrent booking (parallel requests, exactly one wins), tenant isolation (user from org A cannot read org B), signed-note immutability.
- **E2E (Playwright):** Scenario A from patient creation to ledger and dashboard update.
- **Reconciliation test:** Σ subledger = GL control accounts after a randomised sequence of operations.
- A feature is done only when: UI works, validation works, data survives refresh, permission enforced, audit written, error/empty/loading states exist.

## 11. Build order (phases)

| Phase | Deliverable | Done when |
|---|---|---|
| 0 | Repo scaffold, Atlas connection, config, lint rules, CI scripts | App boots, DB connects, tests run |
| 1 | Core: auth+MFA, orgs/branches, RBAC, audit, shell, design system, i18n/RTL, seed | Roles log in and see only permitted modules; denied actions rejected server-side |
| 2 | Patients, doctors, appointments, check-in/queue | Concurrent-booking test passes; live queue board works |
| 3 | EMR encounter + charges | Signed note immutable; charges created from services |
| 4 | Finance core: COA, ledger, invoices, payments, receipts, AR, VAT, reports, executive/reception/doctor/accounts dashboards | **Scenario A passes E2E; ledger reconciles** |
| 5+ | Section 8 modules in order | Per-module spec |

## 12. Reference design

The shadcnuikit hospital-management dashboard will be inspected at the start of Phase 1 (design system step). Its information architecture is reproduced. The visual design is original.

## 13. Out of scope for this spec

Per-module detail for Section 8 modules, production deployment topology, and legal sign-off on any regulatory matter.
