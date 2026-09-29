import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { availableCents } from '../src/ledger.js';
import { creditInbound, createOutboundTransfer } from '../src/transfers.js';
import { processOutbox } from '../src/outbox.js';
import * as provider from '../src/providers.js';
import { faults } from '../src/faults.js';

async function fresh() {
  provider.resetProvider();
  const db = await openDb();
  await db.query(`insert into accounts(id,name) values ('A','Test')`);
  await creditInbound(db, { account_id: 'A', amount_cents: 100000 });
  return db;
}

// TICKET-201: dos requests concurrentes con el mismo idempotency_key
// solo deben crear UN transfer y UN hold
test('[201] concurrent requests with same idempotency key create only one transfer', async () => {
  const db = await fresh();

  const [a, b] = await Promise.all([
    createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 10000, idempotency_key: 'race-key' }),
    createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 10000, idempotency_key: 'race-key' }),
  ]);

  // ambos deben devolver el mismo transfer
  assert.equal(a.id, b.id);

  // solo debe existir UNO en la DB
  const count = (await db.query<any>(`select count(*)::int as n from transfers where idempotency_key='race-key'`)).rows[0].n;
  assert.equal(count, 1);

  // el saldo debe estar descontado solo una vez ($100 + $2.90 fee = $102.90)
  // saldo esperado: $1000 - $102.90 = $897.10 = 89710 centavos
  assert.equal(await availableCents(db, 'A'), 89710);
});

// TICKET-202: un pago con status 'reversed' debe liberar el hold y
// llegar a un estado terminal — sin el fix queda en 'submitted' para siempre
test('[202] a reversed payout releases the hold and reaches a terminal status', async () => {
  const db = await fresh();

  const t = await createOutboundTransfer(db, {
    account_id: 'A',
    rail: 'crypto',
    amount_cents: 60000,
    idempotency_key: 'idem-202',
    scenario: 'reversed',
  });

  // el worker envía al proveedor y entrega el webhook reversed
  await processOutbox(db);

  const row = (await db.query<any>(`select status from transfers where id=$1`, [t.id])).rows[0];

  // debe llegar a un estado terminal (returned), no quedarse en submitted
  assert.equal(row.status, 'returned');

  // el hold debe haberse liberado — saldo vuelve a 100000
  assert.equal(await availableCents(db, 'A'), 100000);
});

// TICKET-203: webhooks fuera de orden [settled, failed] no deben inflar el saldo
// ni sobreescribir un estado terminal
test('[203] out-of-order webhooks do not overwrite a terminal status or inflate the balance', async () => {
  const db = await fresh();

  const t = await createOutboundTransfer(db, {
    account_id: 'A',
    rail: 'ach',
    amount_cents: 75000,
    idempotency_key: 'idem-203',
    scenario: 'out_of_order',
  });

  // el worker envía al proveedor y entrega los webhooks [settled, failed]
  await processOutbox(db);

  const row = (await db.query<any>(`select status from transfers where id=$1`, [t.id])).rows[0];

  // debe quedar settled, no failed
  assert.equal(row.status, 'settled');

  // saldo: 100000 - 75000 - fee(75000=2175) = 22825
  assert.equal(await availableCents(db, 'A'), 22825);
});

// TICKET-204: un crash después de insertar el transfer+hold pero antes de encolar el outbox
// deja el transfer atascado en 'created' para siempre — el worker debe recuperarlo
test('[204] worker recovers a transfer stuck in created after a crash', async () => {
  const db = await fresh();

  // simular crash justo antes de encolar el outbox
  faults.crashMidRequestFor = 'idem-204';
  await assert.rejects(
    () => createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 40000, idempotency_key: 'idem-204' }),
    /process crashed/
  );
  faults.crashMidRequestFor = undefined;

  // transfer existe en 'created' pero no hay entrada en outbox
  const before = (await db.query<any>(`select status from transfers where idempotency_key='idem-204'`)).rows[0];
  assert.equal(before.status, 'created');
  const outboxCount = (await db.query<any>(`select count(*)::int as n from outbox where transfer_id=$1`, [before.id])).rows[0].n;
  assert.equal(outboxCount, 0);

  // el worker debe recuperar el transfer y procesarlo
  await processOutbox(db);

  const after = (await db.query<any>(`select status from transfers where idempotency_key='idem-204'`)).rows[0];
  assert.notEqual(after.status, 'created');
});
