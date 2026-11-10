import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol } from "@/core/db";
import { ctxFor } from "@/test/helpers";
import { ensureChartOfAccounts } from "@/modules/ledger/accounts";
import * as bk from "@/modules/books/service";
import { recordExpense } from "@/modules/finance/expenses";
import { createItem, expandItemLines, listItems, setItemActive } from "./items";
import { askBooks, cfoInsights } from "./insights";

const ORG = "org-accounts";
const Y = new Date().getUTCFullYear();
const acc = ctxFor(["accountant"], ORG, "acc1", "br1");
const fin = ctxFor(["finance_manager"], ORG, "fin1", "br1");

describe("accounts: items and AI CFO", () => {
  beforeAll(async () => {
    await ensureIndexes();
    await ensureChartOfAccounts(ORG);
    for (const year of [Y - 1, Y, Y + 1]) for (let m = 1; m <= 12; m++)
      await tenantCol<any>(ORG, "fiscal_periods").insertOne({ _id: `${ORG}:${year}-${m}`, year, month: m, status: "open", start: new Date(Date.UTC(year, m - 1, 1, -4)), end: new Date(Date.UTC(year, m, 1, -4)) });
  });
  afterAll(closeClient);

  it("creates items and expands @SKU lines into priced invoice lines", async () => {
    await createItem(acc, { sku: "med-pre", name: "Pre-employment medical", rate: "180", vatRate: "STD", incomeCode: "4500" });
    await expect(createItem(acc, { sku: "MED-PRE", name: "Dup", rate: "1" })).rejects.toThrow(/already exists/);
    await expect(createItem(acc, { sku: "X1", name: "Bad acct", rate: "1", incomeCode: "4999" })).rejects.toThrow(/does not exist/);
    const text = await expandItemLines(acc, "@MED-PRE | 40\n@med-pre | 2 | 150\nCustom line | 1 | 99 | ZERO");
    const lines = bk.parseLines(text, "4500");
    expect(lines[0]).toMatchObject({ description: "Pre-employment medical", qty: 40, unitPrice: "180.00", vatRate: "STD", accountCode: "4500" });
    expect(lines[1].unitPrice).toBe("150");
    expect(lines[2].vatRate).toBe("ZERO");
    const it0 = (await listItems(acc)).find((i) => i.sku === "MED-PRE")!;
    await setItemActive(acc, it0._id, false);
    await expect(expandItemLines(acc, "@MED-PRE | 1")).rejects.toThrow(/No active item/);
  });

  it("builds insights and answers questions from the ledger", async () => {
    const c = await bk.createCustomer(acc, { name: "Gulf Hotels", termsDays: 30 });
    await bk.createInvoice(acc, { customerId: c._id, lines: bk.parseLines("Medicals | 10 | 100 | STD", "4500"), issue: true, issueDate: new Date(Date.now() - 50 * 86400000), dueDate: new Date(Date.now() - 20 * 86400000), idempotencyKey: "acc-inv-1" });
    await recordExpense(acc, { category: "5100", vendor: "Landlord LLC", description: "Monthly rent", net: "5000", paidFrom: "bank", idempotencyKey: "acc-exp-1" });
    await recordExpense(acc, { category: "5100", vendor: "Landlord", description: "Monthly rent", net: "5000", paidFrom: "bank", idempotencyKey: "acc-exp-2" });
    const ai = await cfoInsights(fin);
    expect(ai.health.score).toBeGreaterThanOrEqual(0);
    expect(ai.forecast.points).toHaveLength(13);
    expect(ai.collections[0]).toMatchObject({ customer: "Gulf Hotels", stage: "Gentle reminder" });
    expect(ai.duplicates.length).toBe(1);
    const a = await askBooks(fin, "How much did we spend on rent this month?");
    expect(a.figure).toBe("AED 10,000.00");
    expect((await askBooks(fin, "who owes us money")).answer).toMatch(/owe/);
  });
});
