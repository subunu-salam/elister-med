# Compliance gap register

Technical controls that exist are listed as *implemented*; none of this is independent verification of regulatory compliance. Owner is a role, not a person.

| # | Requirement area | Implemented technical control | Gap / action | Owner |
|---|---|---|---|---|
| 1 | Health data law (Federal Law 2 of 2019) and executive regulations | Server-side RBAC, audited reads, field encryption for Emirates ID | Legal review of data model; data classification; patient-rights workflows (access/correction requests) not built | Compliance lead |
| 2 | Data residency | None enforced by the app | Host Atlas and the app in a UAE region; verify Atlas region before storing anything real. Dev uses synthetic data only | Platform admin |
| 3 | Encryption at rest | Atlas encrypts at rest by default; Emirates ID additionally AES-256-GCM | Only one field is field-encrypted; evaluate client-side field-level encryption for other identifiers; key management/rotation | Security |
| 4 | Encryption in transit | Not configured in repo | TLS termination in deployment | Platform admin |
| 5 | Authentication | Email+password, 12-char minimum, optional TOTP | MFA is **optional**. Enforce for all staff roles before go-live; lockout/rate-limit policy review; password policy | Security |
| 6 | Break-glass access | Not implemented | Needs time-boxed, reason-required, reviewed access path | Medical director |
| 7 | Audit | Append-only audit rows, same-transaction | No audit viewer UI, no tamper-evidence beyond DB permissions (consider hash chain, WORM export) | Auditor |
| 8 | Retention / legal hold | Not implemented | Jurisdiction-specific periods must be legally verified before any deletion logic is written. Currently nothing is ever deleted | Compliance lead |
| 9 | Tax (VAT) | Per-line VAT, configurable rates, "review required" flag | Classification of every service by a UAE tax professional; tax invoice fields (TRN, seller/buyer details) incomplete; no input VAT, VAT return or reconciliation | Finance manager |
| 10 | E-invoicing | Not implemented | Structured invoice + ASP integration; a PDF/receipt is **not** a compliant e-invoice | Finance manager |
| 11 | Consent | Treatment consent checkbox and comms preferences stored at registration | Consent wording needs legal review; no consent history UI; marketing opt-in default is off | Compliance lead |
| 12 | Clinical record integrity | Signed notes immutable; amendments versioned and linked | Co-signature workflow, attachments, templates not built | Medical director |
| 13 | Clinical safety rules | Allergy/medical alerts shown in the workspace | Drug interaction, duplicate therapy, critical result escalation are **not** implemented (need a licensed knowledge source and clinical sign-off) | Medical director |
| 14 | Backup and recovery | Not in repo | Atlas backup configuration and restore drill | Platform admin |
| 15 | Incident monitoring | None | Logging/alerting stack, incident register | Security |
| 16 | HIE and claims integrations | Not built | See `integration-readiness.md` | Integration lead |
| 17 | Public queue display | No patient fields in the payload; shared `DISPLAY_KEY` | Single global key is weak for multi-tenant; use per-org/per-device keys | Platform admin |
| 18 | Multi-instance realtime | In-process SSE bus | Replace with shared transport before running more than one instance | Platform admin |
