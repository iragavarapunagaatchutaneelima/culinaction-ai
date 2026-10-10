import { z } from 'zod';
import { isValidIsoDate } from '../shared/dates';
import { parseRupeesToPaise } from '../shared/money';
import { UNIT_CODES } from '../shared/units';

export const text = (max: number) => z.string().trim().max(max, `Must be at most ${max} characters`);
export const reqText = (max: number, label = 'This field') =>
  z.string().trim().min(1, `${label} is required`).max(max, `Must be at most ${max} characters`);
export const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be at most ${max} characters`)
    .nullish()
    .transform((v) => (v ? v : null));

export const isoDate = z.string().refine(isValidIsoDate, 'Enter a valid date');
export const optIsoDate = z
  .string()
  .nullish()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || isValidIsoDate(v), 'Enter a valid date');

export const positiveQty = z.coerce
  .number({ invalid_type_error: 'Enter a number' })
  .finite()
  .positive('Must be greater than zero')
  .max(10_000_000, 'Too large');
export const nonNegQty = z.coerce
  .number({ invalid_type_error: 'Enter a number' })
  .finite()
  .min(0, 'Cannot be negative')
  .max(10_000_000, 'Too large');
export const unitCode = z.enum(UNIT_CODES as [string, ...string[]], {
  errorMap: () => ({ message: 'Choose a unit' }),
});

/** Rupee amount (string or number) → integer paise, or null when blank. */
export const rupees = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v, ctx) => {
    if (v === null || v === undefined || v === '') return null;
    try {
      return parseRupeesToPaise(v);
    } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
      return z.NEVER;
    }
  });

export const dateTypeField = z
  .enum(['use_by', 'expiry', 'best_before'])
  .nullish()
  .transform((v) => v ?? null);
