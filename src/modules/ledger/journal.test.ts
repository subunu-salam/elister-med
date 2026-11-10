import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol } from "@/core/db";
import { fromDecimal128 } from "@/core/money";
import { ctxFor } from "@/test/helpers";
import { ensureChartOfAccounts } from "./accounts";
import * as journalModule from "./journal";
import { postJournal, reverseJournal } from "./journal";
import { lockPeriod } from "./periods";
import { trialBalance } from "@/modules/reports/trialBalance";

const ORG = "org-ledger";
const acct = (code: string) => `${ORG}:${code}`;
const acc = ctxFor(["accountant"], ORG, "acc-1");
const fin = ctxFor(["finance_manager"], ORG, "fin-1");
const d = (iso: string) => new Date(`${iso}T12:00:00+04:00`);
let k = 0;
const key = () => `k-${k++}`;

async function mkPeriod(year: number, month: number, status = "open") {
  await tenantCol<any>(ORG, "fiscal_periods").insertOne({
    _id: `${ORG}:${year}-${month}`, year, month, status,
    start: new Date(Date.UTC(year, month - 1, 1, -4)), end: new Date(Date.UTC(year, month, 1, -4)),
  });
}

beforeAll(async () => {
  await ensureIndexes();
  await ensureChartOfAccounts(ORG);
  await mkPeriod(2026, 11);
  await mkPeriod(2026, 10);
});
afterAll(async () => { await closeClient(); });

const simple = (amount: string, iso = "2026-11-05", idempotencyKey = key()) => ({
  date: d(iso), memo: "t", idempotencyKey, sourceRef: { type: "test", id: "x" },
  lines: [{ accountId: acct("1000"), debit: amount }, { accountId: acct("4000"), credit: amount }],
});

describe("postJournal", () => {
  it("accepts 0.10 + 0.20 = 0.30 exactly (no float drift)", async () => {
    const e = await postJournal(acc, {
      date: d("2026-11-05"), memo: "dec", idempotencyKey: key(), sourceRef: { type: "test", id: "1" },
      lines: [{ accountId: acct("1000"), debit: "0.1" }, { accountId: acct("1010"), debit: "0.2" }, { accountId: acct("4000"), credit: "0.3" }],
    });
    expect(e.entryNo).toBeGreaterThan(0);
  });

  it("rejects unbalanced, one-sided, >2dp and malformed lines", async () => {
    await expect(postJournal(acc, { ...simple("10"), lines: [{ accountId: acct("1000"), debit: "10" }, { accountId: acct("4000"), credit: "9.99" }] })).rejects.toMatchObject({ code: "UNBALANCED" });
    await expect(postJournal(acc, { ...simple("10"), lines: [{ accountId: acct("1000"), debit: "10" }] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(postJournal(acc, simple("10.001"))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(postJournal(acc, { ...simple("10"), lines: [{ accountId: acct("1000"), debit: "5", credit: "5" }, { accountId: acct("4000"), credit: "0" }] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(postJournal(acc, simple("-5"))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("is idempotent: same key returns the original entry, one set of lines", async () => {
    const idem = key();
    const a = await postJournal(acc, simple("50", "2026-11-05", idem));
    const b = await postJournal(acc, simple("50", "2026-11-05", idem));
    expect(b._id).toBe(a._id);
    expect(await tenantCol<any>(ORG, "gl_lines").count({ entryId: a._id })).toBe(2);
  });

  it("parallel retries with the same key still produce one entry", async () => {
    const idem = key();
    const rs = await Promise.allSettled(Array.from({ length: 6 }, () => postJournal(acc, simple("77", "2026-11-05", idem))));
    const ids = new Set(rs.filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled").map((r) => r.value._id));
    expect(ids.size).toBe(1);
    expect(await tenantCol<any>(ORG, "journal_entries").count({ idempotencyKey: idem })).toBe(1);
  });

  it("rejects posting into a locked period and into a date with no period", async () => {
    await lockPeriod(fin, 2026, 10);
    await expect(postJournal(acc, simple("5", "2026-10-15"))).rejects.toMatchObject({ code: "PERIOD_LOCKED" });
    await expect(postJournal(acc, simple("5", "2031-01-15"))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects unknown/inactive accounts and other orgs' accounts", async () => {
    await tenantCol<any>(ORG, "accounts").updateOne({ code: "5700" }, { $set: { active: false } });
    await expect(postJournal(acc, { ...simple("5"), lines: [{ accountId: acct("5700"), debit: "5" }, { accountId: acct("1000"), credit: "5" }] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(postJournal(acc, { ...simple("5"), lines: [{ accountId: "other:1000", debit: "5" }, { accountId: acct("1000"), credit: "5" }] })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("manual journals need ledger:create; lock needs ledger:approve", async () => {
    await expect(postJournal(ctxFor(["receptionist"], ORG), simple("5"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(lockPeriod(acc, 2026, 11)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("reversal and integrity", () => {
  it("reversal nets to zero, links both ways, and cannot be done twice", async () => {
    const e = await postJournal(acc, simple("123.45", "2026-11-06"));
    const r = await reverseJournal(fin, e._id, "posted in error", d("2026-11-07"));
    expect(r.reversalOf).toBe(e._id);
    const lines = await tenantCol<any>(ORG, "gl_lines").find({ entryId: { $in: [e._id, r._id] } });
    const net = lines.reduce((a, l) => a + Number(fromDecimal128(l.debit)) - Number(fromDecimal128(l.credit)), 0);
    expect(net).toBe(0);
    await expect(reverseJournal(fin, e._id, "again")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(reverseJournal(acc, r._id, "x")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("trial balance debits equal credits", async () => {
    const tb = await trialBalance(fin, {});
    expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
    expect(tb.totalDebit.gt(0)).toBe(true);
  });

  it("module exposes no update/delete for posted entries", () => {
    const names = Object.keys(journalModule);
    expect(names.filter((n) => /update|delete|remove|edit|amend/i.test(n))).toEqual([]);
  });
});
