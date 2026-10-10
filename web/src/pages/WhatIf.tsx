import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { post } from '../api';
import { addDays, formatDate, formatINR, formatQty, todayIST, unitsForBase, type BaseUnit } from '../fmt';
import { useQuery } from '../hooks';
import { useOutlet } from '../session';
import { Alert, Badge, Button, Card, Loading, PageHead, Prov, QtyField, SelectField, TextField } from '../ui';
import type { IngredientSummary } from './Inventory';

interface PrepScenario {
  portions: number;
  ingredients: {
    ingredientId: number;
    name: string;
    baseUnit: BaseUnit;
    needed: number;
    usable: number;
    otherDemand: number;
    remainingAfter: number;
    shortfall: number;
    costPaise: number | null;
  }[];
  stockFeasible: boolean;
  maxPortionsFromStock: number;
  ingredientCostPaise: number | null;
  history: null | {
    days: number;
    daysShort: number;
    daysSurplus: number;
    avgSurplusPortions: number;
    avgShortPortions: number;
    estSurplusCostPaise: number | null;
    estLostSalesPaise: number | null;
  };
}
interface PrepResult {
  date: string;
  item: { id: number; name: string; pricePaise: number | null };
  forecast: {
    method: string;
    methodLabel: string;
    mean: number | null;
    min: number | null;
    max: number | null;
    daysUsed: number;
    values: { date: string; qty: number }[];
    explanation: string;
  };
  suggestions: number[];
  scenarios: PrepScenario[];
  method: string;
}

export function WhatIf() {
  const { api } = useOutlet();
  const [params] = useSearchParams();
  const menu = useQuery<
    { id: number; name: string; active: boolean; recipe: { verified: boolean; invalidLines: number } }[]
  >(`${api}/menu-items`);
  const verified = (menu.data ?? []).filter((m) => m.active && m.recipe.verified && !m.recipe.invalidLines);
  const [itemId, setItemId] = useState(params.get('item') ?? '');
  const [date, setDate] = useState(todayIST());
  const [qtys, setQtys] = useState<string[]>(['', '', '']);
  const [res, setRes] = useState<PrepResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);

  useEffect(() => {
    if (!itemId && verified.length) setItemId(String(verified[0].id));
  }, [itemId, verified]);

  const run = async (override?: number[]) => {
    setErr(null);
    setBusy(true);
    try {
      let portions =
        override ??
        qtys
          .map((q) => q.trim())
          .filter(Boolean)
          .map(Number);
      if (!portions.length) {
        // first run: ask for the forecast to get suggestions, then compare them
        const first = await post<PrepResult>(`${api}/whatif/prep`, {
          menuItemId: Number(itemId),
          date,
          portions: [0],
        });
        portions = first.suggestions.length ? [...new Set(first.suggestions)] : [10];
        setQtys([...portions.map(String), '', ''].slice(0, 3));
      }
      if (portions.some((p) => !Number.isInteger(p) || p < 0))
        throw new Error('Portions must be whole numbers, 0 or more.');
      const r = await post<PrepResult>(`${api}/whatif/prep`, { menuItemId: Number(itemId), date, portions });
      setRes(r);
      setSel(0);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const s = res?.scenarios[sel];
  return (
    <div className="stack">
      <PageHead
        title="What-if simulator"
        sub="Compare quantities before deciding. Calculated from your recorded sales, verified recipes and usable stock — nothing is saved or changed."
      />
      <Card title="Preparation quantity">
        <div className="card-body stack">
          {menu.loading && !menu.data ? (
            <Loading />
          ) : !verified.length ? (
            <Alert kind="info">
              No menu item has a verified recipe yet. Verify a recipe in Menu & recipes to simulate
              preparation.
            </Alert>
          ) : (
            <form
              className="form-grid"
              onSubmit={(e) => {
                e.preventDefault();
                void run();
              }}
            >
              <SelectField
                label="Dish"
                value={itemId}
                onChange={(v) => (setItemId(v), setRes(null))}
                options={verified.map((m) => ({ value: String(m.id), label: m.name }))}
              />
              <TextField
                label="For date"
                type="date"
                value={date}
                onChange={(v) => (setDate(v), setRes(null))}
                hint={`Today to ${formatDate(addDays(todayIST(), 7))}`}
              />
              {qtys.map((q, i) => (
                <TextField
                  key={i}
                  label={`Quantity ${String.fromCharCode(65 + i)} (portions)`}
                  inputMode="numeric"
                  value={q}
                  onChange={(v) => setQtys(qtys.map((x, j) => (j === i ? v : x)))}
                  hint={i === 0 && !q ? 'Leave blank to start from the forecast' : undefined}
                />
              ))}
              <div className="span-2">
                <Button className="primary" type="submit" busy={busy}>
                  Compare quantities
                </Button>
              </div>
            </form>
          )}
          {err && <Alert kind="danger">{err}</Alert>}
        </div>
      </Card>

      {res && (
        <>
          <Card
            title={
              <h2>
                Demand for {res.item.name} on {formatDate(res.date)} <Prov kind="forecast" />
              </h2>
            }
          >
            <div className="card-body small stack-sm">
              {res.forecast.mean === null ? (
                <Alert kind="warn">
                  {res.forecast.explanation} Stock calculations are still shown; history comparison is not
                  available.
                </Alert>
              ) : (
                <>
                  <p>
                    {res.forecast.methodLabel}: <strong>{res.forecast.mean}</strong> portions (range{' '}
                    {res.forecast.min}–{res.forecast.max}) from {res.forecast.daysUsed} recorded day(s).
                  </p>
                  <p className="mono tiny muted">
                    {res.forecast.values
                      .map((v) => `${formatDate(v.date).slice(0, 5)}: ${v.qty}`)
                      .join(' · ')}
                  </p>
                </>
              )}
            </div>
          </Card>

          <Card title="Comparison">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Quantity</th>
                    <th>Stock</th>
                    <th className="num">Ingredient cost</th>
                    <th>Comparable days short</th>
                    <th className="num">Avg surplus</th>
                    <th className="num">Avg shortfall</th>
                  </tr>
                </thead>
                <tbody>
                  {res.scenarios.map((x, i) => (
                    <tr
                      key={i}
                      onClick={() => setSel(i)}
                      className={i === sel ? 'row-sel' : ''}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>
                        <button className="btn ghost sm" aria-pressed={i === sel} onClick={() => setSel(i)}>
                          {String.fromCharCode(65 + i)}: {x.portions}
                        </button>
                      </td>
                      <td>
                        {x.stockFeasible ? (
                          <Badge kind="ok">Enough usable stock</Badge>
                        ) : (
                          <Badge kind="danger">Short — max {x.maxPortionsFromStock}</Badge>
                        )}
                      </td>
                      <td className="num">
                        {x.ingredientCostPaise === null ? '—' : formatINR(x.ingredientCostPaise)}
                      </td>
                      <td>{x.history ? `${x.history.daysShort} of ${x.history.days}` : '—'}</td>
                      <td className="num">
                        {x.history ? (
                          <>
                            {x.history.avgSurplusPortions}
                            {x.history.estSurplusCostPaise !== null && (
                              <div className="tiny muted">≈ {formatINR(x.history.estSurplusCostPaise)}</div>
                            )}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="num">
                        {x.history ? (
                          <>
                            {x.history.avgShortPortions}
                            {x.history.estLostSalesPaise !== null && (
                              <div className="tiny muted">
                                ≈ {formatINR(x.history.estLostSalesPaise)} sales
                              </div>
                            )}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-foot tiny muted">
              Costs and averages are <Prov kind="estimate" /> values. “Comparable days short” replays each
              quantity against the recorded sales on the comparable days above; it is not a probability.{' '}
              {res.method}
            </div>
          </Card>

          {s && (
            <Card title={`Ingredients for ${s.portions} portions`}>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Ingredient</th>
                      <th className="num">Needed</th>
                      <th className="num">Other dishes (forecast)</th>
                      <th className="num">Usable now</th>
                      <th className="num">Left after</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.ingredients.map((g) => (
                      <tr key={g.ingredientId} className={g.shortfall ? 'row-bad' : ''}>
                        <td>{g.name}</td>
                        <td className="num">{formatQty(g.needed, g.baseUnit)}</td>
                        <td className="num">{formatQty(g.otherDemand, g.baseUnit)}</td>
                        <td className="num">{formatQty(g.usable, g.baseUnit)}</td>
                        <td className="num">
                          {g.shortfall ? (
                            <strong style={{ color: 'var(--danger)' }}>
                              −{formatQty(g.shortfall, g.baseUnit)}
                            </strong>
                          ) : (
                            formatQty(g.remainingAfter, g.baseUnit)
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}

      <PurchaseSim />
    </div>
  );
}

function PurchaseSim() {
  const { api } = useOutlet();
  const ings = useQuery<{ items: IngredientSummary[] }>(`${api}/ingredients`);
  const [id, setId] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState('kg');
  const [useBy, setUseBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [r, setR] = useState<null | {
    ingredient: { name: string; baseUnit: BaseUnit; usableQty: number; dailyUse: number | null };
    result: {
      coverDaysNow: number | null;
      coverDaysAfter: number | null;
      exceedsTargetCover: boolean | null;
      atRiskQty: number | null;
      atRiskCostPaise: number | null;
      purchaseCostPaise: number | null;
      notes: string[];
    };
    targetCoverDays: number;
  }>(null);
  const ing = ings.data?.items.find((i) => String(i.id) === id);
  const units = ing ? unitsForBase(ing.baseUnit) : ['kg'];

  const go = async () => {
    setErr(null);
    setBusy(true);
    try {
      setR(
        await post(`${api}/whatif/purchase`, {
          ingredientId: Number(id),
          qty,
          unit: units.includes(unit as never) ? unit : units[0],
          useByDays: useBy === '' ? null : Number(useBy),
        }),
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Purchase quantity">
      <div className="card-body stack">
        <div className="form-grid">
          <SelectField
            label="Ingredient"
            value={id}
            onChange={(v) => (setId(v), setR(null))}
            placeholder="Choose…"
            options={(ings.data?.items ?? []).map((i) => ({ value: String(i.id), label: i.name }))}
          />
          <QtyField
            label="Purchase quantity"
            qty={qty}
            unit={units.includes(unit as never) ? unit : units[0]}
            units={units}
            onQty={setQty}
            onUnit={setUnit}
          />
          <TextField
            label="Days until its use-by / expiry (optional)"
            inputMode="numeric"
            value={useBy}
            onChange={setUseBy}
            hint="Leave blank if the pack has no date"
          />
          <div style={{ alignSelf: 'end' }}>
            <Button className="primary" busy={busy} disabled={!id || !qty} onClick={() => void go()}>
              Calculate
            </Button>
          </div>
        </div>
        {err && <Alert kind="danger">{err}</Alert>}
        {r && (
          <div className="stack-sm small">
            <div className="grid-3">
              <div className="card stat">
                <div className="label">Days of cover now</div>
                <div className={`value ${r.result.coverDaysNow === null ? 'unavailable' : ''}`}>
                  {r.result.coverDaysNow ?? 'Unknown'}
                </div>
                <div className="foot">
                  {formatQty(r.ingredient.usableQty, r.ingredient.baseUnit)} usable ·{' '}
                  {r.ingredient.dailyUse === null
                    ? 'daily use unknown'
                    : `${formatQty(r.ingredient.dailyUse, r.ingredient.baseUnit)}/day forecast`}
                </div>
              </div>
              <div className="card stat">
                <div className="label">Days of cover after purchase</div>
                <div className={`value ${r.result.coverDaysAfter === null ? 'unavailable' : ''}`}>
                  {r.result.coverDaysAfter ?? 'Unknown'}
                </div>
                <div className="foot">
                  {r.result.exceedsTargetCover
                    ? `Above your ${r.targetCoverDays}-day target`
                    : r.result.exceedsTargetCover === false
                      ? `Within your ${r.targetCoverDays}-day target`
                      : ''}
                </div>
              </div>
              <div className="card stat">
                <div className="label">
                  Likely unused before its date <Prov kind="estimate" />
                </div>
                <div className={`value ${r.result.atRiskQty === null ? 'unavailable' : ''}`}>
                  {r.result.atRiskQty === null
                    ? 'Not calculated'
                    : formatQty(r.result.atRiskQty, r.ingredient.baseUnit)}
                </div>
                <div className="foot">
                  {r.result.atRiskCostPaise !== null ? `≈ ${formatINR(r.result.atRiskCostPaise)}` : ''}
                  {r.result.purchaseCostPaise !== null
                    ? ` · purchase ≈ ${formatINR(r.result.purchaseCostPaise)}`
                    : ''}
                </div>
              </div>
            </div>
            {r.result.notes.map((n) => (
              <p key={n} className="muted tiny">
                {n}
              </p>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
