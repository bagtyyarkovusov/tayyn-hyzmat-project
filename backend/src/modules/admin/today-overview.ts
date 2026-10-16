import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';

interface TodaySnapshot {
  date: string;
  dayStart: Date;
  dayEnd: Date;
  created: number;
  completed: number;
  cancelled: number;
  samples: number;
  missing: number;
  invalid: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
  publicOrders: number;
  privateReservations: number;
  oldestSeconds: number | null;
}

// One server clock and one repeatable-read snapshot for both cohort and live queue.
// Public waiting includes regional-only visibility; it never means globally claimable.
export async function getTodayOverview() {
  const now = new Date();
  const [rows] = await prisma.$transaction([
    prisma.$queryRaw<TodaySnapshot[]>`
      WITH bounds AS (
        SELECT (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC') AS now,
          (${now.toISOString()}::timestamptz AT TIME ZONE 'Asia/Ashgabat')::date AS day
      ), reporting AS (
        SELECT now, day,
          (day::timestamp AT TIME ZONE 'Asia/Ashgabat') AT TIME ZONE 'UTC' AS start,
          ((day + 1)::timestamp AT TIME ZONE 'Asia/Ashgabat') AT TIME ZONE 'UTC' AS finish
        FROM bounds
      ), cohort AS (
        SELECT orders.* FROM orders, reporting
        WHERE created_at >= reporting.start AND created_at < reporting.finish
      ), outcomes AS (
        SELECT COUNT(*)::int AS created,
          COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
          COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
          COUNT(*) FILTER (WHERE accepted_at >= created_at)::int AS samples,
          COUNT(*) FILTER (WHERE accepted_at IS NULL)::int AS missing,
          COUNT(*) FILTER (WHERE accepted_at < created_at)::int AS invalid,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (accepted_at - created_at)))
            FILTER (WHERE accepted_at >= created_at)::float8 AS median,
          percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (accepted_at - created_at)))
            FILTER (WHERE accepted_at >= created_at)::float8 AS p90
        FROM cohort
      ), waiting AS (
        SELECT created_at,
          (private_offer_driver_id IS NOT NULL AND private_offer_expires_at IS NOT NULL
            AND private_offer_expires_at > reporting.now) AS reserved
        FROM orders, reporting WHERE status = 'NEW'
      ), queue AS (
        SELECT COUNT(*) FILTER (WHERE NOT reserved)::int AS public,
          COUNT(*) FILTER (WHERE reserved)::int AS private,
          MIN(created_at) FILTER (WHERE NOT reserved) AS oldest
        FROM waiting
      )
      SELECT reporting.day::text AS date, reporting.start AS "dayStart", reporting.finish AS "dayEnd",
        outcomes.created, completed, cancelled, samples, missing, invalid,
        median AS "medianSeconds", p90 AS "p90Seconds",
        queue.public AS "publicOrders", queue.private AS "privateReservations",
        CASE WHEN queue.oldest IS NULL THEN NULL
          ELSE GREATEST(0, EXTRACT(EPOCH FROM (reporting.now - queue.oldest)))::float8 END AS "oldestSeconds"
      FROM reporting, outcomes, queue
    `
  ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  const snapshot = rows[0];
  const terminal = snapshot.completed + snapshot.cancelled;
  return {
    asOf: now.toISOString(),
    timeZone: 'Asia/Ashgabat',
    date: snapshot.date,
    dayStart: snapshot.dayStart.toISOString(),
    dayEnd: snapshot.dayEnd.toISOString(),
    cohort: {
      created: snapshot.created, completed: snapshot.completed, cancelled: snapshot.cancelled,
      unfinished: snapshot.created - terminal, terminal,
      completionRate: terminal ? snapshot.completed / terminal : null,
      cancellationRate: terminal ? snapshot.cancelled / terminal : null
    },
    acceptance: {
      samples: snapshot.samples, missing: snapshot.missing, invalid: snapshot.invalid,
      medianSeconds: snapshot.medianSeconds, p90Seconds: snapshot.p90Seconds
    },
    waiting: {
      publicOrders: snapshot.publicOrders, privateReservations: snapshot.privateReservations,
      oldestSeconds: snapshot.oldestSeconds
    }
  };
}
