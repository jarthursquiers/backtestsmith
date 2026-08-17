import { z } from 'zod'

/**
 * Runtime schemas for Massive REST responses.
 *
 * These are intentionally permissive about unknown keys (`looseObject`) so the
 * provider keeps working if Massive adds fields, but strict about the fields we
 * actually depend on. A validation failure is reported as a diagnostic rather
 * than swallowed, per the project rule that documentation/behavior mismatches
 * must be visible instead of hidden.
 *
 * Verified against https://massive.com/docs/rest/options/contracts/all-contracts
 * and https://massive.com/docs/rest/options/aggregates/custom-bars
 */

export const contractTypeSchema = z.enum(['call', 'put', 'other'])

export const massiveContractSchema = z.looseObject({
  ticker: z.string(),
  underlying_ticker: z.string(),
  contract_type: contractTypeSchema,
  strike_price: z.number(),
  expiration_date: z.string(),
  exercise_style: z.string().optional(),
  shares_per_contract: z.number().optional(),
  primary_exchange: z.string().optional(),
  cfi: z.string().optional()
})

export type MassiveContract = z.infer<typeof massiveContractSchema>

export const massiveContractsResponseSchema = z.looseObject({
  status: z.string().optional(),
  request_id: z.string().optional(),
  // Omitted entirely when a query matches nothing.
  results: z.array(massiveContractSchema).optional(),
  next_url: z.string().optional()
})

export type MassiveContractsResponse = z.infer<typeof massiveContractsResponseSchema>

/**
 * Aggregate bar. Field names are the compact Polygon-style keys:
 *   t=timestamp(ms) o=open h=high l=low c=close v=volume vw=vwap n=transactions
 */
export const massiveAggregateSchema = z.looseObject({
  t: z.number(),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number().optional(),
  vw: z.number().optional(),
  n: z.number().optional()
})

export type MassiveAggregate = z.infer<typeof massiveAggregateSchema>

export const massiveAggregatesResponseSchema = z.looseObject({
  ticker: z.string().optional(),
  status: z.string().optional(),
  request_id: z.string().optional(),
  adjusted: z.boolean().optional(),
  queryCount: z.number().optional(),
  resultsCount: z.number().optional(),
  /**
   * Absent rather than empty when no qualifying trade occurred in the window.
   * This is exactly the "a missing bar is not a zero price" case the research
   * engine must handle explicitly.
   */
  results: z.array(massiveAggregateSchema).optional(),
  next_url: z.string().optional()
})

export type MassiveAggregatesResponse = z.infer<typeof massiveAggregatesResponseSchema>

/** Error envelope returned alongside non-2xx statuses. */
export const massiveErrorResponseSchema = z.looseObject({
  status: z.string().optional(),
  request_id: z.string().optional(),
  error: z.string().optional(),
  message: z.string().optional()
})

/** Extracts the most useful human-readable message from an error body. */
export function describeMassiveError(body: unknown): string | null {
  const parsed = massiveErrorResponseSchema.safeParse(body)
  if (!parsed.success) return null
  return parsed.data.error ?? parsed.data.message ?? null
}
