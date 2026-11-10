import { tenantCol } from "@/core/db";

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
export type Account = {
  _id: string; code: string; name: string; type: AccountType;
  normal: "debit" | "credit"; active: boolean; system?: string;
};

const D = "debit", C = "credit";
/** `system` keys are how posting code finds well-known accounts. */
export const DEFAULT_COA: Omit<Account, "_id" | "active">[] = [
  { code: "1000", name: "Cash on Hand", type: "asset", normal: D, system: "cash" },
  { code: "1010", name: "Bank - Current Account", type: "asset", normal: D, system: "bank" },
  { code: "1020", name: "Card Settlement Clearing", type: "asset", normal: D, system: "card_clearing" },
  { code: "1100", name: "Accounts Receivable - Patients", type: "asset", normal: D, system: "ar_patient" },
  { code: "1110", name: "Accounts Receivable - Insurance", type: "asset", normal: D, system: "ar_insurance" },
  { code: "1200", name: "Inventory - Pharmacy", type: "asset", normal: D, system: "inventory_pharmacy" },
  { code: "1210", name: "Inventory - Consumables", type: "asset", normal: D, system: "inventory_consumables" },
  { code: "1300", name: "Prepaid Expenses", type: "asset", normal: D },
  { code: "1310", name: "Employee Advances", type: "asset", normal: D, system: "employee_advances" },
  { code: "1500", name: "Fixed Assets", type: "asset", normal: D },
  { code: "1510", name: "Accumulated Depreciation", type: "asset", normal: C },
  { code: "1600", name: "Input VAT Recoverable", type: "asset", normal: D, system: "vat_input" },
  { code: "2000", name: "Accounts Payable", type: "liability", normal: C, system: "ap" },
  { code: "2010", name: "Goods Received Not Invoiced", type: "liability", normal: C, system: "grni" },
  { code: "2100", name: "Output VAT Payable", type: "liability", normal: C, system: "vat_output" },
  { code: "2200", name: "Payroll Liabilities", type: "liability", normal: C, system: "payroll_liability" },
  { code: "2300", name: "Accrued Expenses", type: "liability", normal: C },
  { code: "2400", name: "Customer Advances", type: "liability", normal: C, system: "customer_advance" },
  { code: "3000", name: "Capital", type: "equity", normal: C },
  { code: "3100", name: "Retained Earnings", type: "equity", normal: C, system: "retained_earnings" },
  { code: "4000", name: "Consultation Revenue", type: "income", normal: C, system: "rev_consultation" },
  { code: "4100", name: "Procedure Revenue", type: "income", normal: C, system: "rev_procedure" },
  { code: "4200", name: "Laboratory Revenue", type: "income", normal: C, system: "rev_laboratory" },
  { code: "4300", name: "Pharmacy Revenue", type: "income", normal: C, system: "rev_pharmacy" },
  { code: "4400", name: "Dental Revenue", type: "income", normal: C, system: "rev_dental" },
  { code: "4900", name: "Other Service Revenue", type: "income", normal: C, system: "rev_other" },
  { code: "4950", name: "Discounts and Write-offs", type: "income", normal: D, system: "discounts" },
  { code: "5000", name: "Salaries", type: "expense", normal: D, system: "salaries" },
  { code: "5100", name: "Rent", type: "expense", normal: D },
  { code: "5200", name: "Utilities", type: "expense", normal: D },
  { code: "5300", name: "Medical Consumables", type: "expense", normal: D },
  { code: "5310", name: "Purchase Price Variance", type: "expense", normal: D, system: "purchase_variance" },
  { code: "5320", name: "Stock Adjustments and Wastage", type: "expense", normal: D, system: "stock_adjustment" },
  { code: "5400", name: "Pharmacy Cost of Goods Sold", type: "expense", normal: D, system: "cogs_pharmacy" },
  { code: "5500", name: "Laboratory Expenses", type: "expense", normal: D },
  { code: "5600", name: "Equipment Maintenance", type: "expense", normal: D },
  { code: "5700", name: "Marketing", type: "expense", normal: D },
  { code: "5800", name: "Administrative Expenses", type: "expense", normal: D },
  { code: "5330", name: "Cash Over and Short", type: "expense", normal: D, system: "cash_variance" },
  { code: "5810", name: "Bank and Card Charges", type: "expense", normal: D, system: "bank_charges" },
  { code: "5900", name: "Depreciation", type: "expense", normal: D },
  { code: "5950", name: "Bad Debt and Insurance Write-offs", type: "expense", normal: D, system: "writeoff" },
  { code: "1015", name: "Petty Cash", type: "asset", normal: D, system: "petty_cash" },
  { code: "1016", name: "Bank - Savings Account", type: "asset", normal: D, system: "bank_savings" },
  { code: "1120", name: "Accounts Receivable - Corporate Clients", type: "asset", normal: D, system: "ar_trade" },
  { code: "4500", name: "Corporate and Occupational Health Revenue", type: "income", normal: C, system: "rev_corporate" },
  { code: "4800", name: "Other Income", type: "income", normal: C, system: "other_income" },
];

export async function ensureChartOfAccounts(orgId: string): Promise<void> {
  const col = tenantCol<Account>(orgId, "accounts");
  for (const a of DEFAULT_COA) {
    await col.updateOne({ code: a.code }, { $setOnInsert: { _id: `${orgId}:${a.code}`, ...a, active: true } } as never, undefined, { upsert: true });
  }
}

export async function accountBySystem(orgId: string, system: string): Promise<Account> {
  const a = await tenantCol<Account>(orgId, "accounts").findOne({ system });
  if (!a) throw new Error(`System account '${system}' missing for org ${orgId}`);
  return a;
}
