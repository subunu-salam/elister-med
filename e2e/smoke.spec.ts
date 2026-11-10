import { test, expect, type Page } from "@playwright/test";

const PASSWORD = "Demo-Only-Pass-2026!";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/(dashboard|portal)/);
}

async function visit(page: Page, path: string) {
  const errors: string[] = [];
  const onErr = (e: Error) => errors.push(e.message);
  page.on("pageerror", onErr);
  const res = await page.goto(path);
  expect(res?.status(), `${path} status`).toBeLessThan(400);
  await expect(page.locator("main h1, main [role=alert], main h2").first(), `${path} renders`).toBeVisible();
  page.off("pageerror", onErr);
  expect(errors, `${path} client errors`).toEqual([]);
}

const ADMIN_PAGES = [
  "/dashboard", "/patients", "/patients/new", "/appointments", "/queue", "/billing", "/accounting", "/accounting?tab=pnl", "/accounting?tab=aging", "/accounting?tab=journal", "/accounting?tab=periods",
  "/accounts", "/accounts/ai", "/accounts/ai?q=profit%20last%20month", "/accounts/sales", "/accounts/sales?tab=customers", "/accounts/sales?tab=quotes", "/accounts/sales?tab=orders", "/accounts/sales?tab=payments", "/accounts/sales?tab=credits", "/accounts/sales?tab=recurring",
  "/accounts/purchases", "/accounts/purchases?tab=vendors", "/accounts/purchases?tab=bills", "/accounts/purchases?tab=payments", "/accounts/purchases?tab=credits", "/accounts/banking", "/accounts/items",
  "/accounts/accountant", "/accounts/accountant?tab=journals", "/accounts/accountant?tab=budgets", "/accounts/accountant?tab=lock", "/accounts/reports",
  ...["pnl", "balance-sheet", "cash-flow", "sales-customer", "sales-item", "ar-aging", "customer-balances", "ap-aging", "vendor-balances", "expenses", "trial-balance", "general-ledger", "journal", "vat"].map((r) => `/accounts/reports?r=${r}`),
  "/insurance", "/insurance?tab=setup", "/insurance?tab=patient", "/insurance?tab=preauth", "/insurance?tab=recon",
  "/pharmacy", "/inventory", "/inventory?tab=batches", "/inventory?tab=alerts", "/procurement", "/procurement?tab=orders", "/procurement?tab=invoices", "/procurement?tab=suppliers",
  "/laboratory", "/laboratory?tab=critical", "/laboratory?tab=tests", "/radiology",
  "/finance", "/finance?tab=cash", "/finance?tab=bank", "/finance?tab=budget", "/finance?tab=journals",
  "/hr", "/hr?tab=expiry", "/hr?tab=leave", "/hr?tab=payroll", "/hr?tab=policy",
  "/crm", "/crm?tab=followups", "/crm?tab=campaigns", "/crm?tab=feedback", "/crm?tab=referrals", "/communications",
  "/hospital", "/compliance", "/compliance?tab=licences", "/compliance?tab=checklist", "/compliance?tab=incidents", "/compliance?tab=policies", "/compliance?tab=integrations", "/compliance?tab=audit",
  "/ai", "/notifications", "/settings/security",
];

test("admin can open every module page without server or client errors", async ({ page }) => {
  test.setTimeout(600_000);
  await login(page, "admin@demo.local");
  for (const p of ADMIN_PAGES) await visit(page, p);
});

test("role-based access: each role sees only what its permissions allow", async ({ page }) => {
  test.setTimeout(240_000);
  await login(page, "pharmacist@demo.local");
  await visit(page, "/pharmacy");
  await page.goto("/accounting");
  await expect(page.getByText("Access restricted")).toBeVisible();
  await page.goto("/accounts");
  await expect(page.getByText("Access restricted")).toBeVisible();
  await page.goto("/hr");
  await expect(page.getByText("Access restricted")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/login");

  await login(page, "lab1@demo.local");
  await visit(page, "/laboratory");
  await page.goto("/finance");
  await expect(page.getByText("Access restricted")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/login");

  await login(page, "hr@demo.local");
  await visit(page, "/hr?tab=payroll");
  await page.goto("/pharmacy");
  await expect(page.getByText("Access restricted")).toBeVisible();
});

test("patient portal user is routed to the portal and cannot open staff pages", async ({ page }) => {
  await login(page, "patient@demo.local");
  await expect(page).toHaveURL(/\/portal/);
  await expect(page.getByRole("heading", { name: "My health portal" })).toBeVisible();
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/portal/);
  for (const p of ["/patients", "/billing", "/accounting", "/hr", "/pharmacy"]) {
    await page.goto(p);
    await expect(page.getByText("Access restricted")).toBeVisible();
  }
});

test("hospital modules are off by default and say so", async ({ page }) => {
  await login(page, "nurse@demo.local");
  await page.goto("/hospital");
  await expect(page.getByText(/switched off for this organisation/)).toBeVisible();
});
