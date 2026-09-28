# Rulings for SP3-SP7 (autonomous mode, 2026-09-28)

- SP4 quota period: calendar month in a configured IANA timezone (ENTITLEMENTS_QUOTA_TIMEZONE, default Asia/Ho_Chi_Minh), not the billing anniversary.
  Why: simple, predictable, and needs no billing coupling.
  If wrong: SP5 adds a billing-cycle period type; the table is unchanged.
- SP5 S5-Q1..Q3 (money/legal): adopt the conservative defaults, which the user may override.
  - Q1: retain money records forever after an org hard-delete.
  - Q2: no mid-period proration; a plan change takes effect next period.
  - Q3: an SP5 invoice is NOT a VAT/e-invoice; e-invoice is out of scope.
  Why: each is the safest and reversible choice (retention can be shortened later; proration can be added).
  All three are flagged to the user.
- SP6 C1-C4: adopt the defaults.
  - C1: audit retention 13 months, with a 6-month hard floor.
  - C2: keep the id-only audit of hard-deleted orgs until expiry.
  - C3: no IP in the login audit.
  - C4: default org storage 1 GiB (config).
- SP6 C5 (sharp, LGPL-3.0): NOT included in v1.
  Image EXIF stripping sits behind a port with a no-op default, and projects may add a sharp adapter.
  Why: the legal answer is still pending, and sharp costs 20MB against the 400MB ceiling (the SP6 estimate is 389MB).
  If wrong: add the adapter later without a schema change.

## Cross-SP rulings after SP4-7 review round 1 (2026-09-28)

- **R-X1: the SP4↔SP5 contract.** Adopt the interface review's proposal (C-1).
  - SP5 calls `PlanAssignments.assign` inside the billing transaction.
  - The sequence comes from `billing_accounts.plan_assignment_seq`.
  - There is no future-dated assignment. Billing calls `assign` when the paid period starts (the `PERIOD_STARTED` step of `advance-org`).
  - SP5 handles all four results with an exhaustive switch. When `assign` is rejected, the invoice stays PAID and a warning event is audited.
  - Prices reference `plans(id)` through a foreign key.
  - `defaultPlanKey()` replaces `BILLING_FALLBACK_PLAN_KEY`.
- **R-X2: one platform-staff decorator.** Identity/tenancy owns `@PlatformStaffAction()`, and it ships in 3D next to staff-step-up. SP4, SP5 and SP6 consume it.
  - The decorator writes the admin access audit through a port. The port's default is a no-op until SP6 6B lands.
  - A boot check enforces that every `/v1/admin/**` route carries the decorator.
- **R-X3: event flags.** `defineEvent` requires explicit `audit` and `webhook` flags. There is no default.
- **R-X4: one sweep mechanism.** Use one `sweep_definer` role and one shared helper that sweeps the due orgs, then enqueues a per-org job.
  - It uses one `jobId` dedup scheme and ships in SP6 plan 6.0 (core).
  - SP4, SP5 and SP7 reuse it.
  - `billing_definer` stays only if billing still has a non-sweep reason for a definer role.
- **R-X5: purge participant order.** The values come from a registry in the SP3 amendments:

  | Participant | Order |
  |---|---|
  | SP4 entitlements | 100 |
  | SP6 files | 110 |
  | SP7 sample | 200 |
  | tenancy core | 1000 (last) |

  Audit and billing are not purge participants: audit is kept, and money is kept (expire/void only).
- **R-X6: ADR numbers.** 0018 is SP4, 0019 is SP5, 0020 is SP6 and 0021 is SP7. ADR 0008 does not exist.
- **R-X7: global order.** Waves W1..W8 from the interface review:
  1. W1: 3A
  2. W2: 3B ∥ 4A ∥ 6.0 ∥ 7A
  3. W3: 3C ∥ 3D ∥ 6A ∥ 6C ∥ 7B
  4. W4: 4B ∥ 4C ∥ 6B ∥ 7C
  5. W5: 5A ∥ 6D ∥ 7D
  6. W6: 5B
  7. W7: 5C
  8. W8: 7E

  Each spec states its real per-plan dependencies.
- **R-X8: storage quota.** It is an SP4 LIMIT fed through a port adapter, the same way `tenancy.seats` is. There is no second counter.
- **R-X9: no `sharp`.** Reaffirmed.
- **R-X10: env name.** The name is `ENTITLEMENTS_QUOTA_TIMEZONE`.
- **R-X12: SP3 addendum for 3D.** The SP3 spec must gain an addendum before plan 3D is written. It adds:
  - `@PlatformStaffAction()`, which exports decorator metadata;
  - the `PlatformAccessAudit` port (`@Global` with an `@Optional` no-op);
  - the purge-order registry, which includes integrations at order 120.

  3D owns all three. SP6 6B implements the port and the boot inventory.
## Rulings after SP4-7 review round 2

- **R-X13 (X2-1): storage limit port.**
  - One port, `FileStorageLimit`, owned by SP6 as the consumer.
  - SP4 ships its adapter in its `integrations/files.ts` entry.
  - SP7's composition wires that entry when both modules are enabled.
  - When entitlements is enabled and the adapter is missing, the boot check fails.
- **R-X14 (X2-2): sweep helper.** SP6's signature is authoritative.
  - The helper takes the name of a SQL function with a fixed signature, `(after, limit)`, plus optional extra params passed by name.
  - SP5 and SP7 adapt their functions to that signature.
- **R-X15 (X2-3): dual control.**
  - SP6 provides `@RequiresApproval()`.
  - SP5 owns putting it on its three manual-money routes.
- **R-X16 (X2-4): SP7 module obligations.** SP4, SP5 and SP6 each adopt these SP7 obligations:
  - `markModuleLoaded`;
  - a `MODULE_REQUIRES` row;
  - `.meta({ secret })` on every secret field.

  SP6 admin reaches the files/integrations ports through a token that a small shared core-level contract file exports, not through their `index.ts`.
- **R-X17 (X2-5): SP3 addendum for 3D.**
  - The controller writes the SP3 addendum before the 3D plan.
  - The boot inventory check lives in SP6 6B, as R-X12 already says.
- **R-X18 (X2-6): billing reasserts the plan every period.**
  - Billing calls `assign` at EVERY paid-period start, renewals included. Same plan → `UNCHANGED`.
  - A staff manual assignment is therefore overwritten at the next paid period, unless it is an SP4 override.
- **R-X19 (X2-m1, X2-m2): error classes and the starter-prices migration.**
  - SP4 exports its named error classes, and SP5 catches only errors that exist.
  - The SP7 sample does not copy SP5's `_starter_prices`; it documents seeding prices instead.
- **R-X11: SP3 reference.** Every spec cites the committed SP3 r8 spec, `docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md`.
