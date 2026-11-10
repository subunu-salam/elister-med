import type { Decimal128 } from "mongodb";

export type InvoiceStatus = "finalized" | "partially_paid" | "paid" | "credited";

export type InvoiceLine = {
  chargeId: string;
  serviceCode: string;
  name: string;
  qty: number;
  unitPrice: Decimal128;
  taxCode: string;
  taxRate: Decimal128;
  net: Decimal128;
  vat: Decimal128;
  gross: Decimal128;
  revenueAccountSystem: string;
  doctorId?: string;
  departmentId?: string;
};

export type Invoice = {
  _id: string;
  number: string;
  patientId: string;
  status: InvoiceStatus;
  lines: InvoiceLine[];
  subtotal: Decimal128;
  vatTotal: Decimal128;
  total: Decimal128;
  paid: Decimal128;
  balance: Decimal128;
  policyId?: string;
  payerId?: string;
  payerShare?: Decimal128;
  patientShare?: Decimal128;
  journalEntryId: string;
  createdAt: Date;
  createdBy: string;
};

export type PaymentMethod = "cash" | "card" | "bank" | "link";

export type Payment = {
  _id: string;
  invoiceId: string;
  patientId: string;
  method: PaymentMethod;
  amount: Decimal128;
  applied: Decimal128;
  advance: Decimal128;
  refunded: Decimal128;
  refundedAdvance: Decimal128;
  receiptNo: string;
  idempotencyKey: string;
  journalEntryId: string;
  at: Date;
  by: string;
};

export type Refund = {
  _id: string;
  paymentId: string;
  invoiceId: string;
  amount: Decimal128;
  reason: string;
  idempotencyKey: string;
  journalEntryId: string;
  at: Date;
  by: string;
};

export type CreditNote = {
  _id: string;
  number: string;
  invoiceId: string;
  patientId: string;
  reason: string;
  total: Decimal128;
  vatTotal: Decimal128;
  journalEntryId: string;
  at: Date;
  by: string;
};
