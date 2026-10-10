import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';
import { TransitionError } from '../shared/planState';
import { IncompatibleUnitError, UnknownUnitError } from '../shared/units';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'error',
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Record') => new HttpError(404, `${what} not found`, 'not_found');
export const forbidden = (msg = 'You do not have permission to do this.') =>
  new HttpError(403, msg, 'forbidden');
export const conflict = (msg: string, details?: unknown) => new HttpError(409, msg, 'conflict', details);
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, 'validation', details);

function zodDetails(e: ZodError) {
  const fields: Record<string, string> = {};
  for (const i of e.issues) {
    const k = i.path.join('.') || '_';
    if (!fields[k]) fields[k] = i.message;
  }
  return { fields };
}

export function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success)
    throw new HttpError(
      400,
      'Some fields are invalid. Please check and try again.',
      'validation',
      zodDetails(r.error),
    );
  return r.data;
}

export function idParam(req: Request, name: string): number {
  const v = Number(req.params[name]);
  if (!Number.isInteger(v) || v <= 0) throw notFound();
  return v;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res
      .status(400)
      .json({ error: { code: 'validation', message: 'Invalid input', details: zodDetails(err) } });
    return;
  }
  if (err instanceof TransitionError) {
    res
      .status(err.code === 'forbidden' ? 403 : err.code === 'reason_required' ? 400 : 409)
      .json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof IncompatibleUnitError || err instanceof UnknownUnitError) {
    res.status(400).json({ error: { code: 'unit', message: err.message } });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed/.test(msg)) {
    res
      .status(409)
      .json({ error: { code: 'duplicate', message: 'A record with the same details already exists.' } });
    return;
  }
  if (/FOREIGN KEY constraint failed/.test(msg)) {
    res.status(409).json({
      error: {
        code: 'in_use',
        message: 'This record is referenced by other records and cannot be changed this way.',
      },
    });
    return;
  }
  if ((err as { type?: string })?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'too_large', message: 'Upload is too large.' } });
    return;
  }
  if ((err as { type?: string })?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'bad_json', message: 'Request body is not valid JSON.' } });
    return;
  }
  console.error('[error]', err instanceof Error ? err.stack : err);
  res.status(500).json({
    error: {
      code: 'internal',
      message: 'Something went wrong on the server. Nothing was saved if the action failed part-way.',
    },
  });
}
