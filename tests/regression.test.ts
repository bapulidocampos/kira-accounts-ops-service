import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { availableCents } from '../src/ledger.js';
import { creditInbound, createOutboundTransfer } from '../src/transfers.js';
import * as provider from '../src/providers.js';

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
