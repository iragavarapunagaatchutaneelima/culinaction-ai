import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { post } from '../api';
import { OUTLET_TYPE_LABELS } from '../fmt';
import { useForm } from '../hooks';
import { Icon, Logo } from '../icons';
import { useSession, type Outlet } from '../session';
import {
  Badge,
  Button,
  Card,
  Check,
  FormError,
  NumberField,
  PageHead,
  SelectField,
  TextArea,
  TextField,
  useToast,
} from '../ui';

export interface OutletFormValues extends Record<string, unknown> {
  name: string;
  outletType: string;
  city: string;
  locality: string;
  preferredMassUnit: string;
  preferredVolumeUnit: string;
  servicePeriods: string;
  operatingHours: string;
  notes: string;
  expiryWarnDays: string;
  excessCoverDays: string;
  staleCountDays: string;
  purchaseBufferPct: string;
  managersCanApprove: boolean;
  prepWarnMin: string;
  readyWaitWarnMin: string;
  readyWaitHighMin: string;
  deliveryTargetMin: string;
}

export function outletToForm(o?: Outlet): OutletFormValues {
  return {
    name: o?.name ?? '',
    outletType: o?.outletType ?? '',
    city: o?.city ?? 'Hyderabad',
    locality: o?.locality ?? '',
    preferredMassUnit: o?.preferredMassUnit ?? 'kg',
    preferredVolumeUnit: o?.preferredVolumeUnit ?? 'L',
    servicePeriods: o ? o.servicePeriods.join(', ') : 'Breakfast, Lunch, Dinner',
    operatingHours: o?.operatingHours ?? '',
    notes: o?.notes ?? '',
    expiryWarnDays: String(o?.expiryWarnDays ?? 2),
    excessCoverDays: String(o?.excessCoverDays ?? 7),
    staleCountDays: String(o?.staleCountDays ?? 3),
    purchaseBufferPct: String(o?.purchaseBufferPct ?? 10),
    managersCanApprove: o?.managersCanApprove ?? true,
    prepWarnMin: String(o?.prepWarnMin ?? 25),
    readyWaitWarnMin: String(o?.readyWaitWarnMin ?? 10),
    readyWaitHighMin: String(o?.readyWaitHighMin ?? 20),
    deliveryTargetMin: String(o?.deliveryTargetMin ?? 45),
  };
}

export function formToOutlet(v: OutletFormValues) {
  return {
    name: v.name,
    outletType: v.outletType,
    city: v.city,
    locality: v.locality,
    timezone: 'Asia/Kolkata',
    preferredMassUnit: v.preferredMassUnit,
    preferredVolumeUnit: v.preferredVolumeUnit,
    servicePeriods: v.servicePeriods
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    operatingHours: v.operatingHours,
    notes: v.notes,
    expiryWarnDays: v.expiryWarnDays,
    excessCoverDays: v.excessCoverDays,
    staleCountDays: v.staleCountDays,
    purchaseBufferPct: v.purchaseBufferPct,
    managersCanApprove: v.managersCanApprove,
    prepWarnMin: v.prepWarnMin,
    readyWaitWarnMin: v.readyWaitWarnMin,
    readyWaitHighMin: v.readyWaitHighMin,
    deliveryTargetMin: v.deliveryTargetMin,
  };
}

export function validateOutlet(v: OutletFormValues) {
  const e: Record<string, string> = {};
  if (!v.name.trim()) e.name = 'Outlet name is required';
  if (!v.outletType) e.outletType = 'Choose an outlet type';
  if (!v.city.trim()) e.city = 'City is required';
  return e;
}

export function OutletFields({
  f,
  advanced,
}: {
  f: ReturnType<typeof useForm<OutletFormValues>>;
  advanced?: boolean;
}) {
  const { values: v, set, errors: e } = f;
  return (
    <div className="form-grid">
      <TextField
        className="span-2"
        label="Outlet name"
        value={v.name}
        onChange={(x) => set('name', x)}
        error={e.name}
        required
        maxLength={80}
      />
      <SelectField
        className="span-2"
        label="Outlet type"
        value={v.outletType}
        onChange={(x) => set('outletType', x)}
        error={e.outletType}
        required
        placeholder="Choose…"
        options={Object.entries(OUTLET_TYPE_LABELS).map(([value, label]) => ({ value, label }))}
        hint="Used only to describe your outlet. It does not add any recipes or data."
      />
      <TextField label="City" value={v.city} onChange={(x) => set('city', x)} error={e.city} required />
      <TextField
        label="Locality"
        value={v.locality}
        onChange={(x) => set('locality', x)}
        error={e.locality}
        placeholder="e.g. Kukatpally"
      />
      <TextField
        className="span-2"
        label="Service periods"
        value={v.servicePeriods}
        onChange={(x) => set('servicePeriods', x)}
        error={e.servicePeriods}
        hint="Comma-separated, e.g. Breakfast, Lunch, Dinner"
      />
      <SelectField
        label="Weight shown in"
        value={v.preferredMassUnit}
        onChange={(x) => set('preferredMassUnit', x)}
        options={[
          { value: 'kg', label: 'kg' },
          { value: 'g', label: 'g' },
        ]}
      />
      <SelectField
        label="Volume shown in"
        value={v.preferredVolumeUnit}
        onChange={(x) => set('preferredVolumeUnit', x)}
        options={[
          { value: 'L', label: 'L' },
          { value: 'ml', label: 'ml' },
        ]}
      />
      <TextField
        className="span-2"
        label="Operating hours (optional)"
        value={v.operatingHours}
        onChange={(x) => set('operatingHours', x)}
        placeholder="e.g. 6:30–11:30, 12:00–15:30"
      />
      {advanced && (
        <>
          <NumberField
            integer
            label="Warn before use-by/expiry (days)"
            value={v.expiryWarnDays}
            onChange={(x) => set('expiryWarnDays', x)}
            error={e.expiryWarnDays}
            hint="Batches within this many days are flagged ‘use soon’."
          />
          <NumberField
            integer
            label="Target stock cover (days)"
            value={v.excessCoverDays}
            onChange={(x) => set('excessCoverDays', x)}
            error={e.excessCoverDays}
            hint="Stock above this many days of forecast use is flagged as excess."
          />
          <NumberField
            integer
            label="Recount stock after (days)"
            value={v.staleCountDays}
            onChange={(x) => set('staleCountDays', x)}
            error={e.staleCountDays}
          />
          <NumberField
            integer
            label="Purchase buffer (%)"
            value={v.purchaseBufferPct}
            onChange={(x) => set('purchaseBufferPct', x)}
            error={e.purchaseBufferPct}
            hint="Added to shortfall when suggesting a purchase."
          />
          <div className="span-2">
            <Check
              label="Managers may approve action plans"
              checked={v.managersCanApprove}
              onChange={(x) => set('managersCanApprove', x)}
              hint="If unticked, only the owner can approve or reject."
            />
          </div>
          <div className="span-2">
            <h3 style={{ marginTop: 8 }}>Delivery-risk thresholds</h3>
            <p className="hint">
              Used by the rule-based delivery risk checks. Set them to match your own procedures.
            </p>
          </div>
          <NumberField
            integer
            label="Preparation guideline (min)"
            value={v.prepWarnMin}
            onChange={(x) => set('prepWarnMin', x)}
            error={e.prepWarnMin}
          />
          <NumberField
            integer
            label="Delivery target (min)"
            value={v.deliveryTargetMin}
            onChange={(x) => set('deliveryTargetMin', x)}
            error={e.deliveryTargetMin}
            hint="Order received → delivered"
          />
          <NumberField
            integer
            label="Pickup wait: warning (min)"
            value={v.readyWaitWarnMin}
            onChange={(x) => set('readyWaitWarnMin', x)}
            error={e.readyWaitWarnMin}
          />
          <NumberField
            integer
            label="Pickup wait: high (min)"
            value={v.readyWaitHighMin}
            onChange={(x) => set('readyWaitHighMin', x)}
            error={e.readyWaitHighMin}
          />
        </>
      )}
      <TextArea
        className="span-2"
        label="Notes (optional)"
        value={v.notes}
        onChange={(x) => set('notes', x)}
        error={e.notes}
      />
    </div>
  );
}

export function OutletPicker() {
  const { outlets, user, logout, refresh } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [creating, setCreating] = useState(outlets.length === 0);
  const f = useForm(outletToForm());

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    void f.submit(async (v) => {
      const o = await post<Outlet>('/outlets', formToOutlet(v));
      await refresh();
      toast('Outlet created');
      nav(`/app/o/${o.id}/today`);
    }, validateOutlet);
  };

  return (
    <div className="main" style={{ maxWidth: 720, paddingBottom: 48 }}>
      <div className="spread" style={{ marginBottom: 20 }}>
        <div className="brandmark" style={{ color: 'var(--brand)', fontSize: '1.1rem' }}>
          <Logo /> CulinAction AI
        </div>
        <button className="btn ghost sm" onClick={() => void logout()}>
          <Icon.Logout size={16} /> Sign out
        </button>
      </div>
      <PageHead
        title={`Namaste, ${user?.displayName ?? ''}`}
        sub="Choose an outlet workspace, or set up a new one."
      />

      {outlets.length > 0 && (
        <Card title="Your outlets">
          <ul className="list">
            {outlets.map((o) => (
              <li key={o.id}>
                <Link className="list-item" to={`/app/o/${o.id}/today`}>
                  <Icon.Store />
                  <div className="grow">
                    <div className="title">{o.name}</div>
                    <div className="meta">
                      {OUTLET_TYPE_LABELS[o.outletType]} · {o.city} · {o.role}
                    </div>
                  </div>
                  {o.isIllustrative && <Badge kind="warn">Illustrative data</Badge>}
                  <Icon.Chevron className="chev" />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="stack" style={{ marginTop: 16 }}>
        {!creating ? (
          <div className="row">
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Icon.Plus size={18} /> Set up a new outlet
            </button>
          </div>
        ) : (
          <form onSubmit={create} noValidate>
            <Card
              title="Set up your outlet"
              foot={
                <div className="row">
                  <Button className="primary" type="submit" busy={f.submitting}>
                    Create outlet
                  </Button>
                  {outlets.length > 0 && (
                    <button type="button" className="btn ghost" onClick={() => setCreating(false)}>
                      Cancel
                    </button>
                  )}
                </div>
              }
            >
              <div className="card-body stack">
                <p className="muted small">
                  Your outlet starts empty. You add your own ingredients, recipes and sales — CulinAction
                  never invents them. Currency is INR (₹) and dates use DD/MM/YYYY in Asia/Kolkata time.
                </p>
                <FormError message={f.formError} />
                <OutletFields f={f} />
              </div>
            </Card>
          </form>
        )}

        <Card title="Just exploring?" tone="muted">
          <div className="card-body stack-sm">
            <p className="small">
              The interactive <strong>Demo Mode</strong> has four fictional outlets with generated sample
              data. It runs in a separate sandbox and never touches this account.
            </p>
            <div>
              <Link className="btn" to="/demo">
                Open Demo Mode
              </Link>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
