# Security notes

## Model

- **Authentication:** Better Auth, server-side sessions (8h, refreshed), optional TOTP. `src/proxy.ts` only does an optimistic cookie redirect; it is not a security boundary.
- **Authorization:** every service function calls `assertPermission(ctx, "resource:action")`; every page that shows data checks permission first and renders an "Access restricted" state otherwise. Hiding navigation items is cosmetic.
- **Tenancy:** `ctx.orgId` comes from the server-side membership record, never from the client. Module code reaches the database only through `tenantCol(orgId, name)`, which forces `orgId` on filters and inserts and forbids rewriting it. ESLint bans raw collection access in `src/modules`, `src/app` and `src/ui`.
- **Money:** `Decimal128` in the database, `decimal.js` in code. Amounts with more than 2 decimals are rejected.
- **Ledger:** posted entries are inserted, never updated or deleted; corrections are reversing entries; period locks are enforced at posting time; idempotency keys make retries safe.
- **Clinical records:** signed notes cannot be edited; amendments create a new linked version. Clinical reads are audited.
- **Secrets:** `.env.local` is git-ignored; `.env.example` holds placeholders only. `FIELD_ENCRYPTION_KEY` must be 32 random bytes, base64.

## Local demo only

`npm run dev:local` starts an in-memory database with synthetic users (`*@demo.local`) and a documented demo password. Never use those credentials or that runner outside a laptop.

## Reporting

This is pre-release software with no external security review. Treat `compliance-gap-register.md` as the open-issues list.
