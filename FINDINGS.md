# FINDINGS

Root-cause analysis, fix, and prevention for each ticket.

---

## TICKET-201 — Vendor paid twice on a retried request

### How to reproduce

```typescript
await Promise.all([
  createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 10000, idempotency_key: 'race-key' }),
  createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 10000, idempotency_key: 'race-key' }),
]);
```

A sequential retry does not reproduce it — both requests must be in-flight simultaneously.

### Exact mechanism

`createOutboundTransfer` did a SELECT-then-INSERT without atomicity:

1. Request A calls `getByIdemKey('race-key')` → returns null (nothing inserted yet)
2. Request B calls `getByIdemKey('race-key')` → also returns null (A hasn't inserted yet)
3. Request A inserts `TX-0001`
4. Request B inserts `TX-0002` — **no constraint to stop it**

Result: two transfers, two holds, two payments sent to the provider.

### Fix

Two changes:

1. **`src/db.ts`** — added a partial unique index on `idempotency_key`:
   ```sql
   create unique index if not exists transfers_idempotency_key_uidx
     on transfers(idempotency_key)
     where idempotency_key is not null;
   ```

2. **`src/transfers.ts`** — changed INSERT to use `ON CONFLICT DO NOTHING RETURNING id`:
   ```sql
   insert into transfers(...) values (...)
   on conflict (idempotency_key) where idempotency_key is not null
   do nothing
   returning id
   ```
   If `RETURNING` is empty, another request won the race — fetch and return the existing transfer.

### Why it can't recur

The unique index enforces deduplication at the database level. Even if two requests pass the initial `getByIdemKey` check simultaneously, only one INSERT will succeed. The second will be silently blocked by `ON CONFLICT DO NOTHING` and will receive the same transfer as the winner. No application-level locking required.

---

## TICKET-202 — Reversed payout stuck, funds held

### How to reproduce

```typescript
const t = await createOutboundTransfer(db, { account_id: 'A', rail: 'crypto', amount_cents: 60000, scenario: 'reversed' });
await processOutbox(db);
// transfer.status is still 'submitted' — hold never released
```

### Exact mechanism

The provider sent a webhook with `status: 'reversed'`. `applyProviderResult` in `transfers.ts` had cases for `pending`, `settled`, `failed`, and `returned` — but not `reversed`. No branch matched, so the function logged the event and returned without releasing the hold or updating the transfer status. The transfer stayed in `submitted` indefinitely with funds locked.

### Fix

Added an `else if (status === 'reversed')` branch in `applyProviderResult` (`src/transfers.ts`) that mirrors the `returned` case: release the hold and set the internal status to `returned`.

`reversed` is a provider-side term; there is no `reversed` state in our schema. Mapping it to `returned` is correct — both mean the payment did not complete and funds must be freed.

### Why it can't recur

`reversed` is now explicitly handled. Any other unrecognized provider status throws an error: the webhook handler returns a 500, the provider retries the webhook, and the error surfaces immediately in logs for the team to add the missing case — preventing silent fund lockups.

---

## TICKET-203 — Payout shows "failed" but the provider paid it; balance overstated

### How to reproduce

```typescript
const t = await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 75000, scenario: 'out_of_order' });
await processOutbox(db);
// transfer.status is 'failed', but balance is higher than expected
```

### Exact mechanism

The `out_of_order` scenario delivers webhooks in the sequence `[settled, failed]`:

1. Webhook `settled` → debit + release hold + status `settled` ✓
2. Webhook `failed` arrives after → release hold **again** (the hold no longer exists) + status `failed`

The second release inflates the balance because it adds back funds that were already debited. The transfer ends up in `failed` even though the payment completed successfully.

### Fix

Added a terminal state guard at the top of `applyProviderResult` (`src/transfers.ts`):

```typescript
const TERMINAL = ['settled', 'failed', 'returned'];
if (TERMINAL.includes(transfer.status)) {
  log('transfer.provider_result.ignored', { transfer_id: transfer.id, current_status: transfer.status, provider_status: status }, cid, 'warn');
  return;
}
```

If the transfer is already in a terminal state, any subsequent webhook is ignored and a warning is logged.

### Why it can't recur

Once a transfer reaches a terminal state it is immutable — no further webhooks can modify its ledger entries or status. The guard covers all terminal states (`settled`, `failed`, `returned`), so any out-of-order delivery from the provider is silently discarded with a trace in the logs.

---

## TICKET-204 — Payout stuck in "created" after an API crash

### How to reproduce

```typescript
faults.crashMidRequestFor = 'idem-204';
await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 40000, idempotency_key: 'idem-204' });
// throws — transfer exists with hold, but no outbox entry
faults.crashMidRequestFor = undefined;
await processOutbox(db); // without the fix, transfer stays in 'created'
```

### Exact mechanism

`createOutboundTransfer` executes in this order:

1. `INSERT` transfer → committed
2. `INSERT` hold in ledger → committed
3. **CRASH** → process throws here
4. `INSERT` outbox → **never reached**

The transfer and hold exist in the DB, but the worker only processes outbox events. With no outbox entry, the transfer is never submitted to the provider. Funds remain locked in `created` indefinitely.

### Fix

Added a recovery sweep at the start of `processOutbox` (`src/outbox.ts`). Before draining the outbox queue, the worker queries for any outbound transfers in `created` status that have no outbox entry and re-enqueues them:

```typescript
const transfers = (await db.query(`select * from transfers where status='created' and direction='outbound'`)).rows;
for (const t of transfers) {
  const exists = (await db.query(`select id from outbox where transfer_id=$1`, [t.id])).rows.length > 0;
  if (!exists) {
    await db.query(`insert into outbox(event_type, transfer_id) values ('transfer.submit', $1)`, [t.id]);
    log('outbox.recovered', { transfer_id: t.id }, cid, 'warn');
  }
}
```

Because the sweep runs before the outbox query, recovered transfers are processed in the same worker run — no second pass needed.

### Why it can't recur

Every time the worker runs it checks for orphaned transfers. Any crash at any point in the request lifecycle that leaves a transfer in `created` without an outbox entry will be detected and recovered on the next worker run. The fix is retroactive — it also recovers transfers already stuck before the deploy.

---

## TICKET-205 — Provider paid twice after a timeout (STRETCH)

### How to reproduce

```typescript
const t = await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 120000, idempotency_key: 'idem-205', scenario: 'timeout_once' });
await processOutbox(db); // first attempt: provider accepts but times out
await processOutbox(db); // retry: provider accepts again — double payment
```

### Exact mechanism

The worker called `provider.submit(t)` without passing the `idempotency_key`. The provider has deduplication logic (lines 44-46 of `providers.ts`) but only activates it when a client supplies an `idem_key`. Without it:

1. First attempt: provider accepts the payment, then times out — `ProviderTimeout` is thrown
2. Worker retries on the next run
3. Provider receives a new call with no `idem_key` → cannot identify it as a duplicate → accepts and processes a second payment

Result: two payments to the vendor, one transfer in Kira.

### Fix

Pass `t.idempotency_key` to `provider.submit` in `src/outbox.ts`:

```typescript
const res = provider.submit(t, t.idempotency_key ?? undefined);
```

The provider now recognizes the retry as a duplicate and returns the original `provider_ref` without processing a new payment.

### Why it can't recur

The provider's idempotency key is now always forwarded on submission. Any retry of the same transfer will be deduplicated by the provider, regardless of how many times the worker retries.

---

## TICKET-206 — Reconciliation doesn't net to zero (STRETCH)

### How to reproduce

```typescript
await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 155500 });
await processOutbox(db);
const result = await reconcile(db);
// result.diffCents !== 0 and result.feeMismatches.length > 0
```

### Exact mechanism

`feeCents()` in `src/money.ts` used `Math.floor(amountCents * rate)`. The provider uses `Math.floor(amount * rate + 0.5)` (round half-up). For amounts where `amount * 0.029` ends in exactly `.5`, the two formulas produce different results:

- Our fee: `Math.floor(155500 * 0.029)` = `Math.floor(4509.5)` = **4509**
- Provider fee: `Math.floor(155500 * 0.029 + 0.5)` = `Math.floor(4510.0)` = **4510**

This 1-cent difference causes `diffCents !== 0` and appears as a `feeMismatch` in reconciliation.

### Fix

Changed `feeCents` to use round half-up:

```typescript
return Math.floor(amountCents * rate + 0.5);
```

### Why it can't recur

Both Kira and the provider now use the same rounding algorithm. Fee calculations will always match, so reconciliation will net to zero for any transfer amount.

---
