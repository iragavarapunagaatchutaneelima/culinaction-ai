import { Router } from 'express';
import { z } from 'zod';
import { OUTLET_TYPES } from '../../shared/types';
import { hashPassword, requireAuth, requireRealUser, requireRole, type OutletRow } from '../auth';
import { badRequest, conflict, idParam, notFound, parse } from '../http';
import { audit, iso, type Deps } from '../services';
import { optText, reqText } from '../validation';
import { passwordField } from './auth';

export function outletDto(o: OutletRow, role?: string) {
  return {
    id: o.id,
    name: o.name,
    outletType: o.outlet_type,
    city: o.city,
    locality: o.locality,
    timezone: o.timezone,
    currency: o.currency,
    preferredMassUnit: o.preferred_mass_unit,
    preferredVolumeUnit: o.preferred_volume_unit,
    servicePeriods: JSON.parse(o.service_periods) as string[],
    operatingHours: o.operating_hours,
    notes: o.notes,
    expiryWarnDays: o.expiry_warn_days,
    excessCoverDays: o.excess_cover_days,
    staleCountDays: o.stale_count_days,
    purchaseBufferPct: o.purchase_buffer_pct,
    managersCanApprove: !!o.managers_can_approve,
    prepWarnMin: o.prep_warn_min,
    readyWaitWarnMin: o.ready_wait_warn_min,
    readyWaitHighMin: o.ready_wait_high_min,
    deliveryTargetMin: o.delivery_target_min,
    isIllustrative: !!o.is_illustrative,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    role,
  };
}

const TIMEZONES = ['Asia/Kolkata'];

export const outletSchema = z
  .object({
    name: reqText(80, 'Outlet name'),
    outletType: z.enum(OUTLET_TYPES, { errorMap: () => ({ message: 'Choose an outlet type' }) }),
    city: reqText(60, 'City'),
    locality: optText(80),
    timezone: z.enum(TIMEZONES as [string]).default('Asia/Kolkata'),
    preferredMassUnit: z.enum(['g', 'kg']).default('kg'),
    preferredVolumeUnit: z.enum(['ml', 'L']).default('L'),
    servicePeriods: z
      .array(z.string().trim().min(1).max(30))
      .max(8, 'At most 8 service periods')
      .default([])
      .refine(
        (a) => new Set(a.map((s) => s.toLowerCase())).size === a.length,
        'Service periods must be unique',
      ),
    operatingHours: optText(120),
    notes: optText(500),
    expiryWarnDays: z.coerce.number().int().min(0).max(30).default(2),
    excessCoverDays: z.coerce.number().int().min(1).max(90).default(7),
    staleCountDays: z.coerce.number().int().min(1).max(60).default(3),
    purchaseBufferPct: z.coerce.number().int().min(0).max(100).default(10),
    managersCanApprove: z.boolean().default(true),
    prepWarnMin: z.coerce.number().int().min(1).max(240).default(25),
    readyWaitWarnMin: z.coerce.number().int().min(1).max(240).default(10),
    readyWaitHighMin: z.coerce.number().int().min(1).max(240).default(20),
    deliveryTargetMin: z.coerce.number().int().min(5).max(480).default(45),
  })
  .refine((v) => v.readyWaitHighMin > v.readyWaitWarnMin, {
    message: 'The high threshold must be greater than the warning threshold',
    path: ['readyWaitHighMin'],
  });

export function outletRoutes(deps: Deps) {
  const { db, now } = deps;
  const r = Router();
  r.use(requireAuth);

  r.post('/', requireRealUser, async (req, res) => {
    const b = parse(outletSchema, req.body);
    const ts = iso(now());
    const id = await db.tx(async () => {
      const { lastId } = await db.run(
        `INSERT INTO outlets (name, outlet_type, city, locality, timezone, preferred_mass_unit, preferred_volume_unit, service_periods, operating_hours, notes,
          expiry_warn_days, excess_cover_days, stale_count_days, purchase_buffer_pct, managers_can_approve,
          prep_warn_min, ready_wait_warn_min, ready_wait_high_min, delivery_target_min, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          b.name,
          b.outletType,
          b.city,
          b.locality,
          b.timezone,
          b.preferredMassUnit,
          b.preferredVolumeUnit,
          JSON.stringify(b.servicePeriods),
          b.operatingHours,
          b.notes,
          b.expiryWarnDays,
          b.excessCoverDays,
          b.staleCountDays,
          b.purchaseBufferPct,
          b.managersCanApprove ? 1 : 0,
          b.prepWarnMin,
          b.readyWaitWarnMin,
          b.readyWaitHighMin,
          b.deliveryTargetMin,
          ts,
          ts,
        ],
      );
      await db.run('INSERT INTO outlet_members (outlet_id, user_id, role, created_at) VALUES (?,?,?,?)', [
        lastId,
        req.user!.id,
        'owner',
        ts,
      ]);
      await audit(
        db,
        {
          outletId: lastId,
          userId: req.user!.id,
          entityType: 'outlet',
          entityId: lastId,
          action: 'create',
          details: { name: b.name },
        },
        now(),
      );
      return lastId;
    });
    res
      .status(201)
      .json(outletDto((await db.get<OutletRow>('SELECT * FROM outlets WHERE id = ?', [id]))!, 'owner'));
  });

  const o = Router({ mergeParams: true });

  o.get('/', (req, res) => res.json(outletDto(req.outlet!, req.role)));

  o.put('/', requireRole('owner'), async (req, res) => {
    const b = parse(outletSchema, req.body);
    await db.tx(async () => {
      await db.run(
        `UPDATE outlets SET name=?, outlet_type=?, city=?, locality=?, timezone=?, preferred_mass_unit=?, preferred_volume_unit=?, service_periods=?, operating_hours=?, notes=?,
          expiry_warn_days=?, excess_cover_days=?, stale_count_days=?, purchase_buffer_pct=?, managers_can_approve=?,
          prep_warn_min=?, ready_wait_warn_min=?, ready_wait_high_min=?, delivery_target_min=?, updated_at=? WHERE id=?`,
        [
          b.name,
          b.outletType,
          b.city,
          b.locality,
          b.timezone,
          b.preferredMassUnit,
          b.preferredVolumeUnit,
          JSON.stringify(b.servicePeriods),
          b.operatingHours,
          b.notes,
          b.expiryWarnDays,
          b.excessCoverDays,
          b.staleCountDays,
          b.purchaseBufferPct,
          b.managersCanApprove ? 1 : 0,
          b.prepWarnMin,
          b.readyWaitWarnMin,
          b.readyWaitHighMin,
          b.deliveryTargetMin,
          iso(now()),
          req.outlet!.id,
        ],
      );
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'outlet',
          entityId: req.outlet!.id,
          action: 'update',
          details: b,
        },
        now(),
      );
    });
    res.json(
      outletDto((await db.get<OutletRow>('SELECT * FROM outlets WHERE id = ?', [req.outlet!.id]))!, req.role),
    );
  });

  // Permanently delete the outlet and all of its records (owner only, name must be typed to confirm).
  o.delete('/', requireRealUser, requireRole('owner'), async (req, res) => {
    const b = parse(z.object({ confirmName: z.string() }), req.body);
    if (b.confirmName.trim() !== req.outlet!.name)
      throw badRequest('Type the outlet name exactly to confirm deletion.');
    await db.tx(async () => {
      await audit(
        db,
        {
          outletId: null,
          userId: req.user!.id,
          entityType: 'outlet',
          entityId: req.outlet!.id,
          action: 'delete',
          details: { name: req.outlet!.name },
        },
        now(),
      );
      await db.run('DELETE FROM outlets WHERE id = ?', [req.outlet!.id]);
    });
    res.json({ ok: true });
  });

  // ---- members (owner manages) ----
  o.get('/members', requireRole('owner', 'manager'), async (req, res) => {
    res.json(
      await db.all(
        `SELECT u.id, u.username, u.display_name AS displayName, m.role, m.created_at AS addedAt FROM outlet_members m JOIN users u ON u.id = m.user_id
         WHERE m.outlet_id = ? ORDER BY m.role, u.display_name`,
        [req.outlet!.id],
      ),
    );
  });

  o.post('/members', requireRealUser, requireRole('owner'), async (req, res) => {
    const b = parse(
      z.object({
        username: z
          .string()
          .trim()
          .min(3)
          .max(40)
          .regex(/^[a-zA-Z0-9._-]+$/, 'Use letters, numbers, dot, dash or underscore'),
        displayName: reqText(80, 'Name'),
        role: z.enum(['manager', 'staff']),
        password: passwordField.optional(),
      }),
      req.body,
    );
    const ts = iso(now());
    const userId = await db.tx(async () => {
      let user = await db.get<{ id: number }>('SELECT id FROM users WHERE username = ?', [b.username]);
      if (!user) {
        if (!b.password)
          throw badRequest('A temporary password is required for a new user.', {
            fields: { password: 'Required for a new user' },
          });
        const { lastId } = await db.run(
          'INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?,?,?,?)',
          [b.username, b.displayName, hashPassword(b.password), ts],
        );
        user = { id: lastId };
      }
      if (
        await db.get('SELECT 1 FROM outlet_members WHERE outlet_id = ? AND user_id = ?', [
          req.outlet!.id,
          user.id,
        ])
      )
        throw conflict('This user is already a member of this outlet.');
      await db.run('INSERT INTO outlet_members (outlet_id, user_id, role, created_at) VALUES (?,?,?,?)', [
        req.outlet!.id,
        user.id,
        b.role,
        ts,
      ]);
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'member',
          entityId: user.id,
          action: 'add',
          details: { username: b.username, role: b.role },
        },
        now(),
      );
      return user.id;
    });
    res.status(201).json({ id: userId, username: b.username, displayName: b.displayName, role: b.role });
  });

  o.delete('/members/:uid', requireRealUser, requireRole('owner'), async (req, res) => {
    const uid = idParam(req, 'uid');
    if (uid === req.user!.id) throw badRequest('You cannot remove yourself.');
    await db.tx(async () => {
      const { changes } = await db.run(
        "DELETE FROM outlet_members WHERE outlet_id = ? AND user_id = ? AND role != 'owner'",
        [req.outlet!.id, uid],
      );
      if (!changes) throw notFound('Member');
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'member',
          entityId: uid,
          action: 'remove',
        },
        now(),
      );
    });
    res.json({ ok: true });
  });

  return { outletsRouter: r, outletScoped: o };
}
