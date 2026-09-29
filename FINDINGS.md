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
