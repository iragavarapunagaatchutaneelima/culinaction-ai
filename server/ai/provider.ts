// AI explanation layer. The model only EXPLAINS numbers the deterministic engine already
// computed. It never decides safety, never changes quantities and never approves anything.

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import type { Recommendation } from '../../shared/types';

export const ExplanationSchema = z.object({
  summary: z.string().min(1).max(600),
  why: z.array(z.string().max(400)).min(1).max(6),
  tradeoffs: z
    .array(
      z.object({
        option: z.string().max(10),
        pros: z.array(z.string().max(300)).max(4),
        cons: z.array(z.string().max(300)).max(4),
      }),
    )
    .max(5),
  uncertainty: z.array(z.string().max(400)).max(5),
  information_to_collect: z.array(z.string().max(300)).max(6),
  suggested_next_step: z.string().max(400),
});
export type Explanation = z.infer<typeof ExplanationSchema>;

export type AiErrorCode =
  | 'not_configured'
  | 'timeout'
  | 'rate_limited'
  | 'auth'
  | 'network'
  | 'provider_error'
  | 'invalid_output'
  | 'refused';

export type ExplainResult =
  | { ok: true; explanation: Explanation; model: string; unmatchedNumbers: string[] }
  | { ok: false; code: AiErrorCode; message: string };

export interface AiStatus {
  configured: boolean;
  provider: string | null;
  model: string | null;
  reason: string;
}

export interface AiProvider {
  status(): AiStatus;
  explain(rec: Recommendation, context: { outletType: string; city: string }): Promise<ExplainResult>;
}

const SYSTEM = `You explain restaurant inventory recommendations to busy kitchen owners in Hyderabad, India, in simple English.
You receive a recommendation that a deterministic calculator already produced from the restaurant's own records.
Rules:
- Explain only what is in the input. Do NOT invent stock quantities, sales, recipes, costs, prices, dates or percentages.
- Any number you mention must appear in the input exactly as written there. Prefer referring to options by their key (A, B, C).
- Do not decide whether food is safe. Do not suggest using any batch the input marks unsafe, expired or needing a check.
- Do not recommend new recipes, promotions, price changes or supplier orders beyond the options listed.
- Keep allergen statements exactly as given; never claim a dish is allergen-free.
- Point out uncertainty and missing information plainly.`;

/** Strip the payload down to what the explanation needs (limits data sent to the provider). */
export function promptPayload(rec: Recommendation, context: { outletType: string; city: string }) {
  return {
    outlet: context,
    recommendation: {
      title: rec.title,
      problem: rec.problem,
      calculation: rec.calculation,
      assumptions: rec.assumptions,
      options: rec.options.map((o) => ({
        key: o.key,
        label: o.label,
        description: o.description,
        feasible: o.feasible,
        infeasible_reason: o.infeasibleReason ?? null,
        effects: o.effects,
      })),
      confidence: rec.confidence,
      missing_information: rec.missingInfo,
      safety_checks: rec.safetyChecks,
      impact: rec.impactLabel,
    },
  };
}

/** Numbers in the explanation that do not appear anywhere in the input — shown to the user as a warning. */
export function unmatchedNumbers(explanation: Explanation, input: unknown): string[] {
  const norm = (s: string) => s.replace(/,/g, '');
  const inputNums = new Set(
    (norm(JSON.stringify(input)).match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n))),
  );
  const outNums = norm(JSON.stringify(explanation)).match(/\d+(?:\.\d+)?/g) ?? [];
  return [...new Set(outNums.map((n) => String(Number(n))))].filter((n) => !inputNums.has(n));
}

export interface AnthropicProviderOptions {
  apiKey: string | undefined;
  model: string;
  timeoutMs: number;
  baseURL?: string;
  fetch?: typeof fetch; // injectable for tests of error handling
}

export function createAnthropicProvider(opts: AnthropicProviderOptions): AiProvider {
  const configured = Boolean(opts.apiKey && opts.apiKey.trim());
  // Explicit baseURL so an unrelated ANTHROPIC_BASE_URL in the environment is never picked up.
  const client = configured
    ? new Anthropic({
        apiKey: opts.apiKey,
        baseURL: opts.baseURL ?? 'https://api.anthropic.com',
        timeout: opts.timeoutMs,
        maxRetries: 1,
        fetch: opts.fetch,
      })
    : null;

  return {
    status() {
      return configured
        ? {
            configured: true,
            provider: 'anthropic',
            model: opts.model,
            reason: 'API key present in server environment (not yet verified until a request succeeds).',
          }
        : {
            configured: false,
            provider: null,
            model: null,
            reason:
              'ANTHROPIC_API_KEY is not set on the server. AI explanations are disabled; all calculations still work.',
          };
    },

    async explain(rec, context) {
      if (!client)
        return {
          ok: false,
          code: 'not_configured',
          message: 'AI explanation is not configured on this server.',
        };
      const payload = promptPayload(rec, context);
      try {
        const response = await client.beta.messages.parse({
          model: opts.model,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: SYSTEM,
          output_config: { effort: 'low', format: betaZodOutputFormat(ExplanationSchema) },
          messages: [{ role: 'user', content: `Explain this recommendation.\n\n${JSON.stringify(payload)}` }],
        });
        if (response.stop_reason === 'refusal')
          return { ok: false, code: 'refused', message: 'The AI provider declined to answer this request.' };
        if (response.stop_reason === 'max_tokens')
          return {
            ok: false,
            code: 'invalid_output',
            message: 'The AI response was cut off before it was complete.',
          };
        const parsed = ExplanationSchema.safeParse(response.parsed_output);
        if (!parsed.success)
          return {
            ok: false,
            code: 'invalid_output',
            message: 'The AI response did not match the expected structure and was discarded.',
          };
        return {
          ok: true,
          explanation: parsed.data,
          model: response.model,
          unmatchedNumbers: unmatchedNumbers(parsed.data, payload),
        };
      } catch (e) {
        return mapError(e);
      }
    },
  };
}

export function mapError(e: unknown): ExplainResult {
  if (e instanceof Anthropic.APIConnectionTimeoutError)
    return { ok: false, code: 'timeout', message: 'The AI provider did not respond in time.' };
  if (e instanceof Anthropic.RateLimitError)
    return {
      ok: false,
      code: 'rate_limited',
      message: 'The AI provider is rate-limiting requests. Try again shortly.',
    };
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return {
      ok: false,
      code: 'auth',
      message: 'The AI provider rejected the server’s API key. Check ANTHROPIC_API_KEY.',
    };
  }
  if (e instanceof Anthropic.APIConnectionError)
    return { ok: false, code: 'network', message: 'Could not reach the AI provider (network error).' };
  if (e instanceof Anthropic.APIError)
    return {
      ok: false,
      code: 'provider_error',
      message: `The AI provider returned an error (HTTP ${e.status ?? 'unknown'}).`,
    };
  if (e instanceof SyntaxError || (e instanceof Error && /parse|JSON|schema/i.test(e.message))) {
    return {
      ok: false,
      code: 'invalid_output',
      message: 'The AI response was not valid structured output and was discarded.',
    };
  }
  return { ok: false, code: 'provider_error', message: 'Unexpected error while calling the AI provider.' };
}

export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): AiProvider {
  const provider = (env.AI_PROVIDER || 'anthropic').toLowerCase();
  if (provider !== 'anthropic') {
    return {
      status: () => ({
        configured: false,
        provider,
        model: null,
        reason: `AI_PROVIDER "${provider}" is not supported. Supported: anthropic.`,
      }),
      explain: async () => ({
        ok: false,
        code: 'not_configured',
        message: `AI provider "${provider}" is not supported.`,
      }),
    };
  }
  return createAnthropicProvider({
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.AI_MODEL || 'claude-opus-5-5',
    timeoutMs: Number(env.AI_TIMEOUT_MS) || 20000,
    baseURL: env.AI_BASE_URL || undefined,
  });
}
