import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol } from "@/core/db";
import { toDecimal128, money, fromDecimal128, sum } from "@/core/money";
import { ctxFor } from "@/test/helpers";
import { ensureChartOfAccounts } from "@/modules/ledger/accounts";
import { trialBalance } from "@/modules/reports/trialBalance";
import { createPatient } from "@/modules/patients/service";
import { finalizeInvoice, issueCreditNote } from "@/modules/billing/invoice";
import { recordPayment, refundPayment } from "@/modules/billing/payment";
import type { Invoice } from "@/modules/billing/types";

const ORG = "org-reconcile";
const reg = ctxFor(["receptionist"], ORG, "recep", "br1");
const fin = ctxFor(["finance_manager"], ORG, "fin", "br1");

// Deterministic PRNG so a failure is reproducible.
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

beforeAll(async () => {
  await ensureIndexes();
  await ensureChartOfAccounts(ORG);
  const y = new Date().getUTCFullYear();
  for (const year of [y - 1, y, y + 1]) for (let m = 1; m <= 12; m++)
    await tenantCol<any>(ORG, "fiscal_periods").insertOne({ _id: `${ORG}:${year}-${m}`, year, month: m, status: "open", start: new Date(Date.UTC(year, m - 1, 1, -4)), end: new Date(Date.UTC(year, m, 1, -4)) });
});
afterAll(async () => { await closeClient(); });

describe("AR sub-ledger reconciles to GL", () => {
  for (const seed of [1, 7, 42]) {
    it(`random invoice/payment/refund/credit-note sequence (seed ${seed})`, async () => {
      const r = rng(seed);
      const invs: Invoice[] = [];
      const pays: { id: string; remaining: number }[] = [];
      let n = 0;
      for (let step = 0; step < 40; step++) {
        const roll = r();
        if (roll < 0.35 || invs.length === 0) {
          const p = (await createPatient(reg, { fullName: `Rec ${seed}-${n}`, dob: "1980-01-01", sex: "male", phone: `+97156${seed}${String(100000 + n++).slice(1)}` }))._id;
          const price = (Math.floor(r() * 50000) / 100 + 1).toFixed(2); // 1.00 .. 501.00
          const rate = ["0", "5"][Math.floor(r() * 2)];
          const id = `rc-${seed}-${n}`;
          await tenantCol<any>(ORG, "charges").insertOne({ _id: id, patientId: p, encounterId: "e", serviceId: "s", serviceCode: "X", name: "X", kind: "consultation", qty: 1 + Math.floor(r() * 3), unitPrice: toDecimal128(money(price)), taxCode: "STD", taxRate: toDecimal128(money(rate)), revenueAccountSystem: "rev_consultation", status: "unbilled", createdAt: new Date(), createdBy: "x" });
          invs.push(await finalizeInvoice(reg, { patientId: p, chargeIds: [id] }));
        } else if (roll < 0.75) {
          const inv = invs[Math.floor(r() * invs.length)];
          const cur = await tenantCol<any>(ORG, "invoices").findOne({ _id: inv._id });
          if (cur.status === "credited" || fromDecimal128(cur.balance).lte(0)) continue;
          const bal = Number(fromDecimal128(cur.balance));
          const amt = Math.min(bal * (0.2 + r() * 0.9), bal + 20); // sometimes overpays
          const pay = await recordPayment(reg, { invoiceId: inv._id, method: (["cash", "card", "bank"] as const)[Math.floor(r() * 3)], amount: amt.toFixed(2), idempotencyKey: `rc-pay-${seed}-${step}` });
          pays.push({ id: pay._id, remaining: Number(fromDecimal128(pay.amount)) });
        } else if (roll < 0.9 && pays.length) {
          const pay = pays[Math.floor(r() * pays.length)];
          if (pay.remaining < 0.02) continue;
          const amt = Math.min(pay.remaining, 1 + r() * 30).toFixed(2);
          await refundPayment(fin, { paymentId: pay.id, amount: amt, reason: "test", idempotencyKey: `rc-ref-${seed}-${step}` });
          pay.remaining = Number((pay.remaining - Number(amt)).toFixed(2));
        } else {
          const inv = invs[Math.floor(r() * invs.length)];
          const cur = await tenantCol<any>(ORG, "invoices").findOne({ _id: inv._id });
          if (cur.status !== "finalized") continue;
          await issueCreditNote(fin, { invoiceId: inv._id, reason: "test" });
        }
      }

      // sub-ledger: sum of open invoice balances; GL: balance of the AR account
      const all = await tenantCol<Invoice>(ORG, "invoices").find({});
      const sub = sum(all.map((i) => fromDecimal128(i.balance)));
      const tb = await trialBalance(fin, {});
      const ar = tb.rows.find((x) => x.code === "1100")?.balance ?? money(0);
      expect(ar.toFixed(2)).toBe(sub.toFixed(2));
      expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
      // no invoice ever has a negative balance
      for (const i of all) expect(fromDecimal128(i.balance).gte(0)).toBe(true);
    });
  }
});
