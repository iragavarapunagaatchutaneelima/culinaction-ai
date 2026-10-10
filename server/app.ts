import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import express from 'express';
import type { AiProvider } from './ai/provider';
import { csrfGuard, loadUser, outletAccess } from './auth';
import type { Db } from './db/database';
import { errorHandler, notFound } from './http';
import { authRoutes } from './routes/auth';
import { demoRoutes, demoScenarioRoutes } from './routes/demo';
import { orderRoutes } from './routes/orders';
import { whatIfRoutes } from './routes/whatif';
import { decisionRoutes } from './routes/decisions';
import { insightRoutes } from './routes/insights';
import { inventoryRoutes } from './routes/inventory';
import { menuRoutes } from './routes/menu';
import { operationsRoutes } from './routes/operations';
import { outletRoutes } from './routes/outlets';
import { salesRoutes } from './routes/sales';

export interface AppOptions {
  db: Db;
  ai: AiProvider;
  now?: () => Date;
  staticDir?: string | null;
  secureCookies?: boolean;
}

export function createApp(opts: AppOptions) {
  const deps = { db: opts.db, now: opts.now ?? (() => new Date()), ai: opts.ai };
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  const api = express.Router();
  api.use(express.json({ limit: '1.5mb' }));
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); // private operational data must not be cached
    next();
  });
  api.use(loadUser(deps.db, deps.now));
  api.use(csrfGuard);
  api.get('/health', (_req, res) => res.json({ ok: true }));
  api.use('/auth', authRoutes(deps, !!opts.secureCookies));
  api.use('/demo', demoRoutes(deps, !!opts.secureCookies));

  const { outletsRouter, outletScoped } = outletRoutes(deps);
  api.use('/outlets', outletsRouter);
  api.use(
    '/outlets/:oid',
    outletAccess(deps.db),
    outletScoped,
    inventoryRoutes(deps),
    menuRoutes(deps),
    salesRoutes(deps),
    operationsRoutes(deps),
    decisionRoutes(deps),
    orderRoutes(deps),
    whatIfRoutes(deps),
    demoScenarioRoutes(deps),
    insightRoutes(deps),
  );
  api.use((_req, _res, next) => next(notFound('API route')));
  api.use(errorHandler);
  app.use('/api', api);

  if (opts.staticDir && existsSync(opts.staticDir)) {
    const dir = resolve(opts.staticDir);
    app.use(express.static(dir, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(dir, 'index.html'));
    });
  }
  return app;
}
