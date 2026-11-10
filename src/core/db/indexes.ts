import { getDb } from "./client";

type Idx = [collection: string, keys: Record<string, 1 | -1>, opts?: { unique?: boolean; partialFilterExpression?: object }];

/** Central registry; modules append their indexes here. */
export const INDEXES: Idx[] = [
  ["t_docs", { orgId: 1 }],
  ["audit_log", { orgId: 1, at: -1 }],
  ["audit_log", { orgId: 1, resource: 1, resourceId: 1, at: -1 }],
  ["outbox", { status: 1, nextAttemptAt: 1 }],
];

INDEXES.push(
  ["appointments", { orgId: 1, doctorId: 1, start: 1 }],
  ["appointments", { orgId: 1, patientId: 1, start: -1 }],
  ["slot_locks", { orgId: 1, key: 1 }, { unique: true }],
  ["time_off", { orgId: 1, doctorId: 1, start: 1 }],
);

INDEXES.push(
  ["queue_tokens", { orgId: 1, branchId: 1, day: 1, number: 1 }, { unique: true }],
  ["queue_tokens", { orgId: 1, doctorId: 1, status: 1, priority: -1, number: 1 }],
  ["queue_tokens", { orgId: 1, appointmentId: 1 }],
);

INDEXES.push(
  ["encounters", { orgId: 1, appointmentId: 1 }, { unique: true }],
  ["encounters", { orgId: 1, patientId: 1, openedAt: -1 }],
  ["notes", { orgId: 1, encounterId: 1, version: 1 }, { unique: true }],
);

INDEXES.push(
  ["charges", { orgId: 1, patientId: 1, status: 1 }],
  ["charges", { orgId: 1, encounterId: 1, autoKey: 1 }, { unique: true, partialFilterExpression: { autoKey: { $type: "string" } } }],
);

INDEXES.push(
  ["journal_entries", { orgId: 1, idempotencyKey: 1 }, { unique: true }],
  ["journal_entries", { orgId: 1, entryNo: 1 }, { unique: true }],
  ["journal_reversals", { orgId: 1, entryId: 1 }, { unique: true }],
  ["gl_lines", { orgId: 1, accountId: 1, date: 1 }],
  ["gl_lines", { orgId: 1, entryId: 1 }],
);

INDEXES.push(
  ["invoices", { orgId: 1, number: 1 }, { unique: true }],
  ["invoices", { orgId: 1, patientId: 1, createdAt: -1 }],
  ["payments", { orgId: 1, idempotencyKey: 1 }, { unique: true }],
  ["payments", { orgId: 1, invoiceId: 1 }],
  ["refunds", { orgId: 1, idempotencyKey: 1 }, { unique: true }],
  ["credit_notes", { orgId: 1, invoiceId: 1 }, { unique: true }],
);

INDEXES.push(
  ["claims", { orgId: 1, invoiceId: 1 }, { unique: true }],
  ["claims", { orgId: 1, status: 1, createdAt: -1 }],
  ["remittances", { orgId: 1, payerId: 1, reference: 1 }, { unique: true }],
  ["policies", { orgId: 1, patientId: 1 }],
  ["eligibility_checks", { orgId: 1, policyId: 1, at: -1 }],
);

INDEXES.push(
  ["inv_items", { orgId: 1, sku: 1 }, { unique: true }],
  ["inv_batches", { orgId: 1, itemId: 1, locationId: 1, batchNo: 1 }, { unique: true }],
  ["inv_batches", { orgId: 1, itemId: 1, expiry: 1 }],
  ["inv_movements", { orgId: 1, itemId: 1, at: -1 }],
);

INDEXES.push(
  ["grns", { orgId: 1, idempotencyKey: 1 }, { unique: true }],
  ["supplier_invoices", { orgId: 1, supplierId: 1, invoiceNo: 1 }, { unique: true }],
  ["supplier_payments", { orgId: 1, idempotencyKey: 1 }, { unique: true }],
  ["purchase_orders", { orgId: 1, number: 1 }, { unique: true }],
  ["purchase_requests", { orgId: 1, number: 1 }, { unique: true }],
);

INDEXES.push(
  ["prescriptions", { orgId: 1, patientId: 1, createdAt: -1 }],
  ["prescriptions", { orgId: 1, status: 1 }],
  ["dispensings", { orgId: 1, idempotencyKey: 1 }, { unique: true }],
);

INDEXES.push(
  ["lab_tests", { orgId: 1, code: 1 }, { unique: true }],
  ["lab_orders", { orgId: 1, status: 1, orderedAt: 1 }],
  ["lab_orders", { orgId: 1, patientId: 1, orderedAt: -1 }],
  ["lab_critical_alerts", { orgId: 1, status: 1 }],
  ["rad_orders", { orgId: 1, status: 1, orderedAt: 1 }],
  ["notifications", { orgId: 1, userId: 1, at: -1 }],
);

INDEXES.push(
  ["register_sessions", { orgId: 1, cashierId: 1 }, { unique: true, partialFilterExpression: { status: "open" } }],
  ["bank_transactions", { orgId: 1, account: 1, status: 1, date: 1 }],
  ["budgets", { orgId: 1, year: 1, accountCode: 1 }, { unique: true }],
  ["draft_journals", { orgId: 1, status: 1 }],
);

INDEXES.push(
  ["employees", { orgId: 1, empNo: 1 }, { unique: true }],
  ["attendance", { orgId: 1, employeeId: 1, day: 1 }, { unique: true }],
  ["shifts", { orgId: 1, employeeId: 1, day: 1 }, { unique: true }],
  ["leave_types", { orgId: 1, code: 1 }, { unique: true }],
  ["payroll_runs", { orgId: 1, period: 1 }, { unique: true }],
  ["advances", { orgId: 1, key: 1 }, { unique: true }],
);

INDEXES.push(
  ["beds", { orgId: 1, wardId: 1, bedNo: 1 }, { unique: true }],
  ["admissions", { orgId: 1, patientId: 1 }, { unique: true, partialFilterExpression: { status: "admitted" } }],
  ["wards", { orgId: 1, code: 1 }, { unique: true }],
  ["theatres", { orgId: 1, code: 1 }, { unique: true }],
  ["er_visits", { orgId: 1, status: 1, arrivalAt: 1 }],
  ["surgeries", { orgId: 1, theatreId: 1, start: 1 }],
  ["mar", { orgId: 1, admissionId: 1, scheduledAt: 1 }],
);

export async function ensureIndexes(): Promise<void> {
  const db = await getDb();
  for (const [name, keys, opts] of INDEXES) await db.collection(name).createIndex(keys, opts);
}

INDEXES.push(
  ["counters", { orgId: 1, key: 1 }, { unique: true }],
  ["orgs", { orgId: 1 }, { unique: true }],
  ["branches", { orgId: 1, code: 1 }, { unique: true }],
  ["departments", { orgId: 1, code: 1 }, { unique: true }],
  ["staff", { orgId: 1, userKey: 1 }, { unique: true }],
  ["services", { orgId: 1, code: 1 }, { unique: true }],
  ["tax_codes", { orgId: 1, code: 1 }, { unique: true }],
  ["accounts", { orgId: 1, code: 1 }, { unique: true }],
  ["fiscal_periods", { orgId: 1, year: 1, month: 1 }, { unique: true }],
  ["memberships", { userId: 1 }],
  ["chat_channels", { orgId: 1, kind: 1 }],
  ["chat_messages", { orgId: 1, channelId: 1, at: 1 }],
  ["chat_reads", { orgId: 1, userId: 1 }],
  ["profile_photos", { orgId: 1, userId: 1 }, { unique: true }],
);

INDEXES.push(
  ["patients", { orgId: 1, mrn: 1 }, { unique: true }],
  ["patients", { orgId: 1, emiratesIdHash: 1 }],
  ["patients", { orgId: 1, fullName: 1, dob: 1 }],
);

INDEXES.push(
  ["customers", { orgId: 1, name: 1 }],
  ["sales_docs", { orgId: 1, number: 1 }, { unique: true }],
  ["trade_invoices", { orgId: 1, number: 1 }, { unique: true }],
  ["trade_invoices", { orgId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }],
  ["trade_invoices", { orgId: 1, customerId: 1, status: 1 }],
  ["trade_receipts", { orgId: 1, idempotencyKey: 1 }, { unique: true }],
  ["trade_credit_notes", { orgId: 1, idempotencyKey: 1 }, { unique: true }],
  ["vendor_credits", { orgId: 1, idempotencyKey: 1 }, { unique: true }],
  ["recurring_invoices", { orgId: 1, status: 1, nextDate: 1 }],
);
