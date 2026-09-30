import type { PGlite } from '@electric-sql/pglite';
import { reconcile } from './reconciliation.js';
export async function opsMonitor(db: PGlite) {
  const [stuckInCreated, stuckInSubmitted, unreleasedHolds, recon] = await Promise.all([
    checkStuckInCreated(db),
    checkStuckInSubmitted(db),
    checkUnreleasedHolds(db),
    reconcile(db),
  ]);

  const reconAlert =
    recon.diffCents !== 0 || recon.feeMismatches.length > 0 || recon.statementOnly.length > 0;

  return {
    ok:
      stuckInCreated.length === 0 &&
      stuckInSubmitted.length === 0 &&
      unreleasedHolds.length === 0 &&
      !reconAlert,
    checks: {
      stuck_in_created: {
        alert: stuckInCreated.length > 0,
        description:
          'Transferencias outbound en estado "created" sin entrada en outbox — probablemente crashearon antes de encolar',
        transfers: stuckInCreated,
      },
      stuck_in_submitted: {
        alert: stuckInSubmitted.length > 0,
        description:
          'Transferencias enviadas al proveedor sin webhook terminal después de 30 minutos — fondos potencialmente bloqueados',
        transfers: stuckInSubmitted,
      },
      unreleased_holds: {
        alert: unreleasedHolds.length > 0,
        description:
          'Transferencias en estado terminal con hold no liberado — saldo disponible puede estar subestimado',
        transfers: unreleasedHolds,
      },
      reconciliation: {
        alert: reconAlert,
        description:
          'Diferencias entre el ledger y el extracto del proveedor — fees, pagos sin registrar, o registros sin pago',
        diff_cents: recon.diffCents,
        fee_mismatches: recon.feeMismatches,
        statement_only: recon.statementOnly,
        ledger_only: recon.ledgerOnly,
      },
    },
  };
}

async function checkStuckInCreated(db: PGlite): Promise<string[]> {
  const rows = (
    await db.query<{ id: string }>(
      `select t.id from transfers t
       left join outbox o on o.transfer_id = t.id
       where t.status = 'created' and t.direction = 'outbound' and o.id is null`
    )
  ).rows;
  return rows.map((r) => r.id);
}

async function checkStuckInSubmitted(db: PGlite): Promise<string[]> {
  const rows = (
    await db.query<{ id: string }>(
      `select id from transfers
       where status = 'submitted'
       and updated_at < now() - interval '30 minutes'`
    )
  ).rows;
  return rows.map((r) => r.id);
}

async function checkUnreleasedHolds(db: PGlite): Promise<string[]> {
  const rows = (
    await db.query<{ id: string }>(
      `select t.id from transfers t
       where t.status in ('settled', 'failed', 'returned')
       and (
         select coalesce(sum(case when entry_type='hold' then amount_cents else 0 end)
                       - sum(case when entry_type='release' then amount_cents else 0 end), 0)
         from ledger_entries
         where transfer_id = t.id
       ) <> 0`
    )
  ).rows;
  return rows.map((r) => r.id);
}

