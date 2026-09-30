// Demo server: seeds the DB with transfers in buggy states to show the ops monitor in alert mode.
// Run with: npm run dev:buggy
import { openDb } from './db.js';
import { createApp } from './app.js';
import * as provider from './providers.js';

const db = await openDb();

await db.query(`insert into accounts(id, name) values ('DEMO', 'Marea Pay S.A.')`);

// stuck in created (bug 204): crashed before outbox enqueue — funds held, worker never picks it up
await db.query(`
  insert into transfers(id, account_id, direction, rail, amount_cents, fee_cents, status, idempotency_key)
  values ('TX-0041', 'DEMO', 'outbound', 'ach', 40000, 1160, 'created', 'idem-crash-204a')
`);
await db.query(`
  insert into ledger_entries(transfer_id, account_id, entry_type, amount_cents, memo)
  values ('TX-0041', 'DEMO', 'hold', 41160, 'reserve outbound')
`);

await db.query(`
  insert into transfers(id, account_id, direction, rail, amount_cents, fee_cents, status, idempotency_key)
  values ('TX-0045', 'DEMO', 'outbound', 'crypto', 85000, 2465, 'created', 'idem-crash-204b')
`);
await db.query(`
  insert into ledger_entries(transfer_id, account_id, entry_type, amount_cents, memo)
  values ('TX-0045', 'DEMO', 'hold', 87465, 'reserve outbound')
`);

// stuck in submitted (bug 202): reversed webhook arrived but status was not handled — stuck 2h ago
await db.query(`
  insert into transfers(id, account_id, direction, rail, amount_cents, fee_cents, status, provider_ref, idempotency_key)
  values ('TX-0042', 'DEMO', 'outbound', 'crypto', 60000, 1740, 'submitted', 'PROV-8821', 'idem-reversed-202')
`);
await db.query(`update transfers set updated_at = now() - interval '2 hours' where id = 'TX-0042'`);
await db.query(`
  insert into ledger_entries(transfer_id, account_id, entry_type, amount_cents, memo)
  values ('TX-0042', 'DEMO', 'hold', 61740, 'reserve outbound')
`);

// unreleased hold (bug 203): out-of-order webhooks — second webhook released hold twice, first set failed
await db.query(`
  insert into transfers(id, account_id, direction, rail, amount_cents, fee_cents, status, provider_ref, idempotency_key)
  values ('TX-0043', 'DEMO', 'outbound', 'ach', 75000, 2175, 'failed', 'PROV-9934', 'idem-outoforder-203a')
`);
await db.query(`
  insert into ledger_entries(transfer_id, account_id, entry_type, amount_cents, memo)
  values ('TX-0043', 'DEMO', 'hold', 77175, 'reserve outbound')
`);

await db.query(`
  insert into transfers(id, account_id, direction, rail, amount_cents, fee_cents, status, provider_ref, idempotency_key)
  values ('TX-0046', 'DEMO', 'outbound', 'ach', 120000, 3480, 'returned', 'PROV-6621', 'idem-outoforder-203b')
`);
await db.query(`
  insert into ledger_entries(transfer_id, account_id, entry_type, amount_cents, memo)
  values ('TX-0046', 'DEMO', 'hold', 123480, 'reserve outbound')
`);
// no release entry → hold stays open

// reconciliation mismatch (bug 206): settled transfer with wrong fee (Math.floor vs Math.floor+0.5)
// amount 155500 * 0.029 = 4509.5 → our fee: 4509, provider fee: 4510 → 1 cent diff
await db.query(`
  insert into transfers(id, account_id, direction, rail, amount_cents, fee_cents, status, provider_ref, idempotency_key)
  values ('TX-0044', 'DEMO', 'outbound', 'ach', 155500, 4509, 'settled', 'PROV-7712', 'idem-fee-206')
`);
await db.query(`
  insert into ledger_entries(transfer_id, account_id, entry_type, amount_cents, memo)
  values ('TX-0044', 'DEMO', 'hold', 159009, 'reserve outbound'),
         ('TX-0044', 'DEMO', 'debit', 159009, 'settle outbound'),
         ('TX-0044', 'DEMO', 'release', 159009, 'release hold (settled)')
`);
// provider statement has fee 4510 (round half-up) — 1 cent more than our ledger
provider.submissions.push({
  provider_ref: 'PROV-7712',
  transfer_id: 'TX-0044',
  amount_cents: 155500,
  idem_key: 'idem-fee-206a',
  accepted_at: new Date().toISOString(),
  outcome: 'settled',
});

// second reconciliation mismatch — amount 172400 * 0.029 = 4999.6 → no diff, but let's use 250900
// 250900 * 0.029 = 7276.1 → our fee: 7276, provider fee: 7276 → actually no diff there
// use 172400: 172400 * 0.029 = 4999.6 → floor=4999, floor+0.5=5000 → 1 cent diff
await db.query(`
  insert into transfers(id, account_id, direction, rail, amount_cents, fee_cents, status, provider_ref, idempotency_key)
  values ('TX-0047', 'DEMO', 'outbound', 'ach', 172400, 4999, 'settled', 'PROV-5501', 'idem-fee-206b')
`);
await db.query(`
  insert into ledger_entries(transfer_id, account_id, entry_type, amount_cents, memo)
  values ('TX-0047', 'DEMO', 'hold', 177399, 'reserve outbound'),
         ('TX-0047', 'DEMO', 'debit', 177399, 'settle outbound'),
         ('TX-0047', 'DEMO', 'release', 177399, 'release hold (settled)')
`);
provider.submissions.push({
  provider_ref: 'PROV-5501',
  transfer_id: 'TX-0047',
  amount_cents: 172400,
  idem_key: 'idem-fee-206b',
  accepted_at: new Date().toISOString(),
  outcome: 'settled',
});


const app = createApp(db);
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`kira-accounts-ops-service [BUGGY DEMO] on :${port}`));
