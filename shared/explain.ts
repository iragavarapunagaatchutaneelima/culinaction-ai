// Deterministic, rule-based explanation of a recommendation. Used when no AI provider is
// configured, or when an AI response fails validation. It only re-arranges text the engine
// already produced — it never adds numbers or facts. Always labelled "Rule-based summary".

import type { Recommendation } from './types';

export interface ExplanationShape {
  summary: string;
  why: string[];
  tradeoffs: { option: string; pros: string[]; cons: string[] }[];
  uncertainty: string[];
  information_to_collect: string[];
  suggested_next_step: string;
  recommended_option: string | null;
}

const CONF_TEXT = {
  high: 'Confidence is high: the forecast uses at least 3 comparable days and all costs are recorded.',
  medium: 'Confidence is medium: fewer comparable days were available or a cost is missing.',
  low: 'Confidence is low: some demand history or verified recipe data is missing.',
} as const;

/** First feasible option that creates an action; the engine lists options in its preferred order. */
export function defaultOption(rec: Pick<Recommendation, 'options'>): string | null {
  return rec.options.find((o) => o.feasible && o.lines.length > 0)?.key ?? null;
}

export function ruleBasedExplanation(rec: Recommendation): ExplanationShape {
  return {
    summary: rec.problem,
    why: rec.calculation.slice(0, 6).length ? rec.calculation.slice(0, 6) : [rec.title],
    tradeoffs: rec.options.map((o) => ({
      option: o.key,
      pros: o.feasible ? [o.description].filter(Boolean) : [],
      cons: o.feasible
        ? o.effects
            .filter((e) => /risk|short|unknown|still/i.test(e.label + e.value))
            .map((e) => `${e.label}: ${e.value}`)
        : [`Not feasible: ${o.infeasibleReason ?? 'see details'}`],
    })),
    uncertainty: [CONF_TEXT[rec.confidence], ...rec.assumptions.slice(0, 3)],
    information_to_collect: rec.missingInfo.slice(0, 6),
    suggested_next_step: rec.nextStep,
    recommended_option: defaultOption(rec),
  };
}
