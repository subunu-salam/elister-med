import { test, expect, type Page } from "@playwright/test";

const PASSWORD = "Demo-Only-Pass-2026!";
const RUN = Date.now().toString().slice(-6);

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard/);
}
const logout = async (page: Page) => { await page.getByRole("button", { name: "Sign out" }).click(); await page.waitForURL("**/login"); };

test("Scenario E in the browser: order, receive, invoice, approve (second person), pay", async ({ page }) => {
  test.setTimeout(240_000);

  // Inventory manager orders and receives stock
  await login(page, "inventory@demo.local");
  await page.goto("/procurement?tab=orders");
  await page.getByRole("combobox").nth(1).selectOption({ label: "Paracetamol 500mg" });
  await page.getByLabel("Quantity *").fill("100");
  await page.getByLabel("Unit cost (AED) *").fill("1.00");
  await page.getByRole("button", { name: "Create order" }).click();
  const row = page.locator("tbody tr").first();
  await expect(row).toContainText("draft");
  await row.getByRole("button", { name: "Issue" }).click();
  const issued = page.locator("tbody tr").first();
  await expect(issued).toContainText("issued");
  await issued.getByLabel("Qty *").fill("100");
  await issued.getByLabel("Batch *").fill(`E2E-${RUN}`);
  await issued.getByLabel("Expiry *").fill(`${new Date().getFullYear() + 1}-12-31`);
  await issued.getByRole("button", { name: "Receive" }).click();
  await expect(page.locator("tbody tr").first()).toContainText("received");

  await page.goto("/inventory?tab=batches");
  await expect(page.getByRole("cell", { name: `E2E-${RUN}` })).toBeVisible();

  // Same person records the supplier invoice; cannot approve it
  await page.goto("/procurement?tab=invoices");
  await page.getByLabel("Invoice no. *").fill(`E2E-INV-${RUN}`);
  await page.getByLabel("Invoice date *").fill("2026-11-01");
  await page.getByLabel("Due date *").fill("2026-12-01");
  await page.getByLabel("Net (AED) *").fill("100.00");
  await page.getByRole("button", { name: "Record", exact: true }).click();
  const inv = page.locator("tbody tr", { hasText: `E2E-INV-${RUN}` });
  await expect(inv).toContainText("pending approval");
  await inv.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator("main [role=alert]")).toContainText("cannot approve an invoice you recorded");
  await logout(page);

  // Finance approves and pays
  await login(page, "finance@demo.local");
  await page.goto("/procurement?tab=invoices");
  const fin = page.locator("tbody tr", { hasText: `E2E-INV-${RUN}` });
  await fin.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator("tbody tr", { hasText: `E2E-INV-${RUN}` })).toContainText("approved");
  await page.locator("tbody tr", { hasText: `E2E-INV-${RUN}` }).getByRole("button", { name: "Pay" }).click();
  await expect(page.locator("tbody tr", { hasText: `E2E-INV-${RUN}` })).toContainText("paid");

  // Books balance
  await page.goto("/accounting?tab=trial-balance");
  await expect(page.getByText("Balanced")).toBeVisible();
  await page.goto("/finance?tab=statements");
  await expect(page.getByText("Balanced").first()).toBeVisible();
});
