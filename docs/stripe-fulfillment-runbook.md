# Stripe Fulfillment Failure Runbook

This runbook covers the high-risk case where Stripe payment succeeds but Square fulfillment fails.

## Failure Signature

- Stripe webhook receives `checkout.session.completed` or `checkout.session.async_payment_succeeded`.
- Server logs one of:
  - `Stripe webhook: Square createOrder failed`
  - `Stripe webhook incremental: Square failed`
  - `Stripe webhook: database error`
- Webhook handler responds with `5xx` and Stripe retries delivery.

## Immediate Actions

1. Identify `session_id` from logs/webhook event.
2. Inspect pending order row by `pending_order_id` in metadata.
3. Check if order already persisted (`orders.stripe_session_id` or `payment_sessions[]`).
4. If persisted, no manual refund required (idempotent duplicate event path).
5. If not persisted and fulfillment cannot be recovered quickly, issue refund using payment intent.

## Recovery Decision Tree

- **Recoverable infra outage** (temporary Square/DB):
  - Keep webhook endpoint healthy.
  - Allow Stripe retries to re-process.
  - Verify idempotent guards prevent duplicate order writes.

- **Persistent data/logic mismatch**:
  - Pause retries by fixing handler issue first.
  - Manually reconcile:
    - refund payment
    - notify customer
    - mark pending order as reconciled (internal note)

## Preventive Controls in Code

- Checkout session creation uses idempotency keys.
- Webhook fulfillment path checks for existing session before mutating state.
- Square create order uses deterministic idempotency keys (`stripe-checkout-*`, `stripe-incr-*`).
- Refund path uses idempotency key per order/session/payment intent.

## Post-Incident Checklist

- Confirm no duplicate orders for same Stripe session.
- Confirm refund visibility in Stripe dashboard.
- Add root-cause note and affected session IDs to incident log.
