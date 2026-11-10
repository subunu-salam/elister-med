# Implementation and feature status

Last verified: 2026-11-03. 209 unit/integration tests, 8 browser tests (Scenario A, Scenario E, access control, RTL, smoke over every module page, portal), `tsc`, `eslint` (0 errors) and `next build` all pass.

Nothing here claims regulatory certification or a live government/payer integration. Every external boundary is a labelled **sandbox** adapter that transmits nothing.

## 1. Implemented and tested (domain logic + UI)

| Area | What exists | Evidence |
|---|---|---|
| Platform | Tenant isolation (`orgId` everywhere, lint-banned raw db), Better Auth + optional TOTP, 18 roles / `resource:action` RBAC enforced in services and page gates, append-only audit, transactional outbox, notifications, attachments (typed, size-capped, audited) | core tests, e2e access tests |
| Patients / CRM | Registration (3-step), encrypted Emirates ID, duplicate hints, Arabic search; enquiries, follow-ups, consent-aware recall (contact data only), feedback/NPS, complaints, referral analysis | patients, crm tests |
| Appointments / queue | Race-free booking, hours/leave/holidays, state machine, drag-and-drop reschedule, tokens, wait estimate, org-scoped SSE, public display, QR kiosk | appointments, queue, portal tests |
| EMR | Encounter workspace, SOAP sign/amend versioning, allergy alerts, diagnoses, vitals, specialty template framework (versioned forms) | emr, specialty tests |
| Specialties | Dental FDI chart + multi-visit plans, packages, physio, paediatric growth/vaccination, chronic care plans, dermatology with photo consent and product use | specialty tests |
| Billing | Charges, invoices with per-line VAT, payments (split/advance), refunds, credit notes, receipts, insured split (patient/payer) | billing tests, e2e |
| Ledger / finance | Double-entry with idempotency, period locks, reversals, journal approval, year-end close, cash drawers, petty cash, transfers, bank import + reconciliation, card settlement, balance sheet, cash flow, VAT summary, budgets, branch profitability, pharmacy margin | ledger, finance tests |
| Insurance | Payers/plans/policies, eligibility records, pre-authorisation, claim validation, sandbox submission, rejection/resubmission, remittance, write-off, receivable reconciliation, denial analysis | insurance tests |
| Pharmacy / inventory | Prescriptions with allergy + duplicate alerts, pharmacist verification, FEFO dispensing, COGS + charge, returns, refills, batch stock with no negatives, valuation = ledger | pharmacy, procurement tests |
| Procurement / AP | Reorder → request → approval (four-eyes) → PO → GRN → supplier invoice with variance → payment, AP aging | procurement tests, e2e |
| Laboratory / radiology | Catalogue with approved ranges only, sample stages, four-eyes verification, critical alerts, release gating, billing; imaging order → report → second-reader release | laboratory tests |
| HR | Employees, licence/document expiry, attendance/overtime, configurable leave, advances, payroll (four-eyes, ledger posting), generic bank CSV, configured gratuity | hr tests |
| Communications | Templates with safety rules, consent/opt-out, delivery log, retries/dead-letter, reminders (sandbox gateway) | crm tests |
| Compliance | Licences, checklist with evidence, incidents, policies, access review, audit report, integration readiness matrix | integrations tests |
| Integrations | HL7 v2 ADT and FHIR Patient builders, validation, identity matching, code maps, queue with error queue (sandbox); structured e-invoice with validation and sandbox ASP | integrations tests |
| Hospital (optional, off by default) | Wards/beds, admissions, MAR, discharge billing, ER queue with escalation, theatre scheduling with safety gates | hospital tests |
| AI assistants | Local rule-based only: facility Q&A (EN/AR), slot search, booking via caller permissions, revenue summary, forecasts, anomaly detection, SOAP draft-from-dictation (draft only) | platform tests |
| Portal | One-patient-bound portal: appointments, invoices, released results, intake, queue status | platform + smoke tests |
| Groups | Consolidated P&L only for members that agreed | platform tests |
| Accounts (Business OS) | One Zoho Books-style section at `/accounts` that replaces the separate Accounting and Clinic books menu entries: Overview, AI CFO, Sales (customers, quotes, sales orders, invoices, payments received, credit notes, recurring), Purchases (vendors, expenses, bills, payments made, vendor credits), Banking, Items (catalogue with `@SKU` line entry), Accountant (chart of accounts, manual journals with approval and reversal, budgets, transaction locking), Reports (14 reports with period compare, CSV export and print). AI CFO: health score, 13-week cash forecast, anomaly and duplicate detection, collections priority with draft reminders, smart categorisation, "ask your books", month-end close readiness. All local heuristics on the ledger | accounts tests, insights-core tests, e2e smoke |
| Shell | Role-filtered sidebar, command palette, notification bell, dark mode, EN/AR + RTL, saved dashboard widgets, recent patients | e2e |

## 2. Implemented, not externally validated

- VAT defaults to 5% standard-rated with a "review required" flag on every service. Nothing is assumed zero-rated.
- Structured e-invoice uses an internal model (`internal-0.1`), not the national PINT-AE/ASP payload.
- Payroll bank file is a generic CSV, not the official WPS SIF layout. Gratuity, overtime, leave entitlements and escalation thresholds are **configuration with no defaults**.
- Field encryption uses one environment key (no KMS or rotation tooling).
- Realtime uses an in-process bus (single instance).
- Assistants use transparent heuristics (no-show risk, demand forecast) that are labelled unvalidated.

## 3. Sandbox integrations (nothing leaves the system)

Claims submission, SMS/email/WhatsApp gateway, HIE messaging (NABIDH/Malaffi/Riayati shape), e-invoice service provider, AI provider (local rules). Readiness matrix shows none beyond "adapter implemented".

## 4. Awaiting credentials, licences or regulator approval

DHA eClaimLink, DOH Shafafiya, Riayati, NABIDH, Malaffi onboarding and conformance; e-invoicing ASP contract and national format mapping; payment gateway; SMS/WhatsApp accounts; licensed drug-knowledge provider; CPT/HCPCS and UAE drug code licences (diagnosis and service codes are entered manually); PACS/DICOM.

## 5. Requires clinical or regulatory review before real use

Triage scale use and ER escalation thresholds, laboratory reference ranges, tax classification, consent wording, retention periods, controlled-medicine process (blocked electronically by design), break-glass policy (not built).

## 6. Not built / known limitations

- Controlled-medicine electronic prescribing is refused (needs the regulator's authorization integration).
- No drug-interaction checking (no licensed source); allergy matching is by name only, not drug class.
- Break-glass access, patient-rights request workflows, backup/restore automation, incident monitoring stack, hash-chained audit.
- Online card payment from the portal (no gateway). Payment links are not implemented.
- Month/week/resource calendar views (day scheduler with drag-and-drop only); FullCalendar not used.
- UI kit is hand-built Tailwind (not shadcn/Radix), charts are CSS bars; accessibility had care but no formal audit.
- The reference dashboard (shadcnuikit hospital-management) was not inspected.
- Dashboards load rows into memory for the selected range; aggregation pipelines needed at larger scale.
- Database is MongoDB (agreed in the design spec), not the PostgreSQL/Prisma/Redis in the original brief.
- Tests and local runs use an in-memory replica set. Nothing has been run against Atlas because no connection string was available in this workspace.
