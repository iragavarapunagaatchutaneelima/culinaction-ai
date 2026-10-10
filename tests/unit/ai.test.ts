// Tests of the AI adapter's ERROR HANDLING and validation using injected transports.
// These do not and cannot show that a live provider works — no real API key is used.
import { describe, expect, it } from 'vitest';
import {
  createAnthropicProvider,
  providerFromEnv,
  unmatchedNumbers,
  type Explanation,
} from '../../server/ai/provider';
import type { Recommendation } from '../../shared/types';

const rec = {
  title: 'Paneer may go unused',
  problem: '2 kg left, use-by 11/10/2026',
  calculation: ['At risk = 2 kg − 1 kg = 1 kg', 'Value at risk = ₹400.00'],
  assumptions: [],
  options: [
    {
      key: 'A',
      label: 'Prioritise',
      description: '',
      feasible: true,
      effects: [],
      estimatedCostPaise: null,
      lines: [],
    },
  ],
  confidence: 'medium',
  missingInfo: [],
  safetyChecks: [],
  impactLabel: 'Estimated value at risk',
} as unknown as Recommendation;

const messageWithText = (text: string) =>
  (async () =>
    new Response(
      JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;

const make = (fetchImpl: typeof fetch, timeoutMs = 2000) =>
  createAnthropicProvider({
    apiKey: 'test-key-not-real',
    model: 'claude-opus-5-5',
    timeoutMs,
    fetch: fetchImpl,
  });

describe('AI provider adapter', () => {
  it('reports not configured without a key and never calls out', async () => {
    const p = providerFromEnv({});
    expect(p.status().configured).toBe(false);
    expect(await p.explain(rec, { outletType: 'cafe', city: 'Hyderabad' })).toMatchObject({
      ok: false,
      code: 'not_configured',
    });
  });

  it('rejects unsupported providers', () => {
    expect(providerFromEnv({ AI_PROVIDER: 'other' }).status()).toMatchObject({
      configured: false,
      provider: 'other',
    });
  });

  it('discards output that is not valid JSON', async () => {
    const r = await make(messageWithText('Sure! Here is an explanation without JSON.')).explain(rec, {
      outletType: 'cafe',
      city: 'Hyderabad',
    });
    expect(r).toMatchObject({ ok: false, code: 'invalid_output' });
  });

  it('discards JSON that does not match the schema', async () => {
    const r = await make(messageWithText(JSON.stringify({ summary: 'x' }))).explain(rec, {
      outletType: 'cafe',
      city: 'Hyderabad',
    });
    expect(r).toMatchObject({ ok: false, code: 'invalid_output' });
  });

  it('times out instead of hanging', async () => {
    const hang = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      )) as typeof fetch;
    const r = await make(hang, 150).explain(rec, { outletType: 'cafe', city: 'Hyderabad' });
    expect(r.ok).toBe(false);
    expect(['timeout', 'network']).toContain((r as { code: string }).code);
  }, 15000);

  it('flags numbers in an explanation that do not appear in the calculation', () => {
    const e: Explanation = {
      summary: 'About 1 kg (₹400.00) may be wasted, roughly 25% of stock',
      why: ['x'],
      tradeoffs: [],
      uncertainty: [],
      information_to_collect: [],
      suggested_next_step: 'Option A',
    };
    expect(unmatchedNumbers(e, { calc: rec.calculation })).toEqual(['25']);
  });
});
