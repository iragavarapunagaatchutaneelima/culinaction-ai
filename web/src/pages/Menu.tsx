import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { post, put } from '../api';
import {
  formatDateTime,
  formatINR,
  formatQty,
  num,
  unitCostLabel,
  unitsForBase,
  type BaseUnit,
} from '../fmt';
import { useForm, useQuery } from '../hooks';
import { Icon } from '../icons';
import { useOutlet } from '../session';
import {
  Alert,
  Badge,
  Button,
  Card,
  Check,
  Dialog,
  Empty,
  ErrorState,
  FormError,
  Loading,
  PageHead,
  Prov,
  TextField,
  useToast,
} from '../ui';
import type { IngredientSummary } from './Inventory';

interface MenuItem {
  id: number;
  name: string;
  category: string;
  pricePaise: number | null;
  allergens: string | null;
  allergensVerified: boolean;
  active: boolean;
  recipe: {
    exists: boolean;
    lineCount: number;
    verified: boolean;
    verifiedAt: string | null;
    verifiedBy: string | null;
    yieldPortions: number | null;
    notes: string | null;
    invalidLines: number;
  };
  costPerPortionPaise: number | null;
  costMissingFor: string[];
  foodCostPct: number | null;
}
interface RecipeLine {
  ingredientId: number;
  ingredientName: string;
  baseUnit: BaseUnit;
  qty: number;
  unit: string;
  lossPct: number;
  grossBase: number | null;
  unitCostPaise: number | null;
  lineCostPaise: number | null;
  usableQty: number;
  error: string | null;
  sharedWith: { id: number; name: string }[];
}
interface MenuItemDetail extends MenuItem {
  lines: RecipeLine[];
}

function recipeBadge(m: MenuItem) {
  if (!m.recipe.exists) return <Badge kind="warn">No recipe</Badge>;
  if (m.recipe.invalidLines) return <Badge kind="danger">Unit problem</Badge>;
  if (!m.recipe.verified) return <Badge kind="warn">Recipe not verified</Badge>;
  return <Badge kind="ok">Recipe verified</Badge>;
}

export function MenuList() {
  const { api, base, canEdit } = useOutlet();
  const { data, error, loading, reload } = useQuery<MenuItem[]>(`${api}/menu-items`);
  const [adding, setAdding] = useState(false);
  const nav = useNavigate();
  const groups = new Map<string, MenuItem[]>();
  for (const m of data ?? []) groups.set(m.category, [...(groups.get(m.category) ?? []), m]);

  return (
    <div className="stack">
      <PageHead
        title="Menu & recipes"
        sub="Only recipes you mark as verified are used in calculations. Quantities must come from your kitchen — CulinAction does not guess recipes."
        actions={
          canEdit && (
            <button className="btn primary" onClick={() => setAdding(true)}>
              <Icon.Plus size={18} /> Add menu item
            </button>
          )
        }
      />
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <Card>
          <Empty
            icon={<Icon.Menu />}
            title="No menu items yet"
            action={
              canEdit && (
                <button className="btn primary" onClick={() => setAdding(true)}>
                  Add a menu item
                </button>
              )
            }
          >
            Add the dishes you sell, then enter the ingredient quantity per serving that your kitchen actually
            uses.
          </Empty>
        </Card>
      ) : (
        [...groups.entries()].map(([cat, items]) => (
          <Card key={cat} title={cat}>
            <ul className="list">
              {items.map((m) => (
                <li key={m.id}>
                  <Link className="list-item" to={`${base}/menu/${m.id}`}>
                    <div className="grow">
                      <div className="title">
                        {m.name} {!m.active && <span className="badge outline">Inactive</span>}
                      </div>
                      <div className="meta">
                        {m.pricePaise !== null ? formatINR(m.pricePaise) : 'No price'} · {m.recipe.lineCount}{' '}
                        ingredient(s)
                        {m.costPerPortionPaise !== null &&
                          ` · ingredient cost ${formatINR(m.costPerPortionPaise)}`}
                        {m.foodCostPct !== null && ` (${m.foodCostPct}%)`}
                      </div>
                    </div>
                    {recipeBadge(m)}
                    <Icon.Chevron className="chev" />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ))
      )}
      {adding && (
        <MenuItemDialog onClose={() => setAdding(false)} onSaved={(m) => nav(`${base}/menu/${m.id}`)} />
      )}
    </div>
  );
}

function MenuItemDialog({
  item,
  onClose,
  onSaved,
}: {
  item?: MenuItem;
  onClose: () => void;
  onSaved: (m: MenuItem) => void;
}) {
  const { api } = useOutlet();
  const toast = useToast();
  const f = useForm({
    name: item?.name ?? '',
    category: item?.category ?? '',
    priceInr: item?.pricePaise != null ? String(item.pricePaise / 100) : '',
    allergens: item?.allergens ?? '',
    allergensVerified: item?.allergensVerified ?? false,
    active: item?.active ?? true,
  });
  const submit = () =>
    void f.submit(
      async (v) => {
        const m = item
          ? await put<MenuItem>(`${api}/menu-items/${item.id}`, v)
          : await post<MenuItem>(`${api}/menu-items`, v);
        toast(item ? 'Menu item updated' : 'Menu item added');
        onSaved(m);
      },
      (v) => {
        const e: Record<string, string> = {};
        if (!v.name.trim()) e.name = 'Required';
        if (!v.category.trim()) e.category = 'Required';
        if (v.priceInr && !/^\d+(\.\d{1,2})?$/.test(v.priceInr))
          e.priceInr = 'Enter rupees, e.g. 70 or 70.50';
        return e;
      },
    );
  return (
    <Dialog
      title={item ? 'Edit menu item' : 'Add menu item'}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <Button className="primary" busy={f.submitting} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <form className="form" onSubmit={(e) => (e.preventDefault(), submit())} noValidate>
        <FormError message={f.formError} />
        <TextField
          label="Name"
          value={f.values.name}
          onChange={(v) => f.set('name', v)}
          error={f.errors.name}
          required
          placeholder="e.g. Masala Dosa"
        />
        <TextField
          label="Category"
          value={f.values.category}
          onChange={(v) => f.set('category', v)}
          error={f.errors.category}
          required
          placeholder="e.g. Dosa, Beverages, Biryani"
        />
        <TextField
          label="Selling price (₹)"
          inputMode="decimal"
          value={f.values.priceInr}
          onChange={(v) => f.set('priceInr', v)}
          error={f.errors.priceInr}
          hint="Optional. Used to estimate sales value at risk."
        />
        <TextField
          label="Allergens (optional)"
          value={f.values.allergens}
          onChange={(v) => f.set('allergens', v)}
          hint="Exactly as confirmed by your kitchen, e.g. milk, peanuts, gluten"
        />
        <Check
          label="Allergen information has been verified by the kitchen"
          checked={f.values.allergensVerified}
          onChange={(v) => f.set('allergensVerified', v)}
        />
        <Check label="Active on the menu" checked={f.values.active} onChange={(v) => f.set('active', v)} />
      </form>
    </Dialog>
  );
}

interface LineDraft {
  ingredientId: string;
  qty: string;
  unit: string;
  lossPct: string;
}

export function MenuItemPage() {
  const { id } = useParams();
  const { api, base, canEdit } = useOutlet();
  const toast = useToast();
  const { data: m, error, loading, reload, setData } = useQuery<MenuItemDetail>(`${api}/menu-items/${id}`);
  const ings = useQuery<{ items: IngredientSummary[] }>(`${api}/ingredients`);
  const [editing, setEditing] = useState(false);
  const [editItem, setEditItem] = useState(false);
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [verified, setVerified] = useState(false);
  const [yieldPortions, setYield] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !m) return <Loading />;
  if (!m) return null;

  const ingById = new Map((ings.data?.items ?? []).map((i) => [i.id, i]));
  const startEdit = () => {
    setLines(
      m.lines.map((l) => ({
        ingredientId: String(l.ingredientId),
        qty: String(l.qty),
        unit: l.unit,
        lossPct: String(l.lossPct),
      })),
    );
    setVerified(m.recipe.verified);
    setYield(m.recipe.yieldPortions ? String(m.recipe.yieldPortions) : '');
    setNotes(m.recipe.notes ?? '');
    setErrors({});
    setFormError(null);
    setEditing(true);
  };
  const updateLine = (i: number, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const save = async () => {
    const e: Record<string, string> = {};
    lines.forEach((l, i) => {
      if (!l.ingredientId) e[`lines.${i}.ingredientId`] = 'Choose an ingredient';
      const q = num(l.qty);
      if (q === null || Number.isNaN(q) || q <= 0) e[`lines.${i}.qty`] = 'Enter a quantity > 0';
      const lp = num(l.lossPct || '0');
      if (lp === null || Number.isNaN(lp) || lp < 0 || lp >= 100) e[`lines.${i}.lossPct`] = '0–99';
    });
    if (Object.keys(e).length) {
      setErrors(e);
      setFormError('Please fix the highlighted lines.');
      return;
    }
    setSaving(true);
    try {
      await put(`${api}/menu-items/${m.id}/recipe`, {
        verified,
        yieldPortions: yieldPortions || null,
        notes,
        lines: lines.map((l) => ({
          ingredientId: Number(l.ingredientId),
          qty: l.qty,
          unit: l.unit,
          lossPct: l.lossPct || 0,
        })),
      });
      toast('Recipe saved');
      setEditing(false);
      await reload();
    } catch (err) {
      const ae = err as { fields?: Record<string, string>; message: string };
      setErrors(ae.fields ?? {});
      setFormError(ae.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack">
      <PageHead
        title={m.name}
        sub={`${m.category} · ${m.pricePaise !== null ? formatINR(m.pricePaise) : 'no price recorded'}${m.active ? '' : ' · inactive'}`}
        crumb={{ to: `${base}/menu`, label: 'Menu' }}
        actions={
          canEdit && (
            <button className="btn sm" onClick={() => setEditItem(true)}>
              Edit details
            </button>
          )
        }
      />
      <div className="grid-3">
        <div className="card stat">
          <div className="label">Recipe</div>
          <div style={{ marginTop: 6 }}>{recipeBadge(m)}</div>
          <div className="foot">
            {m.recipe.verified
              ? `Verified ${formatDateTime(m.recipe.verifiedAt)}${m.recipe.verifiedBy ? ` by ${m.recipe.verifiedBy}` : ''}`
              : 'Excluded from calculations until verified'}
          </div>
        </div>
        <div className="card stat">
          <div className="label">
            Ingredient cost / portion <Prov kind="estimate" title="From recorded batch costs" />
          </div>
          <div className={`value ${m.costPerPortionPaise === null ? 'unavailable' : ''}`}>
            {m.costPerPortionPaise === null ? 'Unavailable' : formatINR(m.costPerPortionPaise)}
          </div>
          <div className="foot">
            {m.costPerPortionPaise === null
              ? m.costMissingFor.length
                ? `No cost for ${m.costMissingFor.join(', ')}`
                : 'Needs a recipe'
              : m.foodCostPct !== null
                ? `${m.foodCostPct}% of selling price`
                : 'No selling price'}
          </div>
        </div>
        <div className="card stat">
          <div className="label">Allergens</div>
          <div className="small" style={{ marginTop: 6 }}>
            {m.allergens ?? <span className="muted">Not recorded</span>}
          </div>
          <div className="foot">
            {m.allergens
              ? m.allergensVerified
                ? 'Verified by kitchen'
                : 'Not verified'
              : 'CulinAction never infers allergens'}
          </div>
        </div>
      </div>

      {!editing ? (
        <Card
          title="Recipe — quantity per serving"
          actions={
            canEdit && (
              <button className="btn sm primary" onClick={startEdit}>
                {m.lines.length ? 'Edit recipe' : 'Enter recipe'}
              </button>
            )
          }
        >
          {m.lines.length === 0 ? (
            <Empty title="No recipe entered">
              Enter the quantity of each ingredient used for one serving, as measured in your kitchen.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Ingredient</th>
                    <th className="num">Per serving</th>
                    <th className="num">Prep loss</th>
                    <th className="num">Gross used</th>
                    <th className="num">Cost</th>
                    <th>Also used in</th>
                  </tr>
                </thead>
                <tbody>
                  {m.lines.map((l) => (
                    <tr key={l.ingredientId} className={l.error ? 'row-bad' : ''}>
                      <td>
                        <Link to={`${base}/inventory/${l.ingredientId}`}>{l.ingredientName}</Link>
                        {l.error && (
                          <div className="tiny" style={{ color: 'var(--danger)' }}>
                            {l.error}
                          </div>
                        )}
                        <div className="tiny muted">
                          {formatQty(l.usableQty, l.baseUnit)} usable ·{' '}
                          {unitCostLabel(l.unitCostPaise, l.baseUnit)}
                        </div>
                      </td>
                      <td className="num">
                        {l.qty} {l.unit}
                      </td>
                      <td className="num">{l.lossPct ? `${l.lossPct}%` : '—'}</td>
                      <td className="num">
                        {l.grossBase === null ? '—' : formatQty(l.grossBase, l.baseUnit)}
                      </td>
                      <td className="num">
                        {l.lineCostPaise === null ? (
                          <span className="muted">Unknown</span>
                        ) : (
                          formatINR(l.lineCostPaise)
                        )}
                      </td>
                      <td className="small">
                        {l.sharedWith.length ? (
                          l.sharedWith.map((s) => s.name).join(', ')
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {m.recipe.notes && <div className="card-foot small muted">{m.recipe.notes}</div>}
        </Card>
      ) : (
        <Card title="Edit recipe">
          <div className="card-body stack">
            <FormError message={formError} />
            {ings.data?.items.length === 0 && <Alert kind="warn">Add ingredients in Inventory first.</Alert>}
            {lines.map((l, i) => {
              const ing = ingById.get(Number(l.ingredientId));
              const units = ing ? unitsForBase(ing.baseUnit) : ['g', 'kg', 'ml', 'L', 'pc'];
              return (
                <div key={i} className="card card-pad" style={{ boxShadow: 'none' }}>
                  <div className="form-grid">
                    <div className={`field span-2 ${errors[`lines.${i}.ingredientId`] ? 'invalid' : ''}`}>
                      <label htmlFor={`ing-${i}`}>Ingredient</label>
                      <select
                        id={`ing-${i}`}
                        className="input"
                        value={l.ingredientId}
                        onChange={(e) => {
                          const n = ingById.get(Number(e.target.value));
                          updateLine(i, {
                            ingredientId: e.target.value,
                            unit: n ? (n.baseUnit === 'pc' ? 'pc' : n.baseUnit) : l.unit,
                          });
                        }}
                      >
                        <option value="">Choose…</option>
                        {ings.data?.items.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                      </select>
                      {errors[`lines.${i}.ingredientId`] && (
                        <div className="error">{errors[`lines.${i}.ingredientId`]}</div>
                      )}
                    </div>
                    <div
                      className={`field ${errors[`lines.${i}.qty`] || errors[`lines.${i}.unit`] ? 'invalid' : ''}`}
                    >
                      <label htmlFor={`qty-${i}`}>Quantity per serving</label>
                      <div className="qty-input">
                        <input
                          id={`qty-${i}`}
                          className="input"
                          inputMode="decimal"
                          value={l.qty}
                          onChange={(e) => updateLine(i, { qty: e.target.value })}
                        />
                        <select
                          className="input"
                          aria-label="Unit"
                          value={l.unit}
                          onChange={(e) => updateLine(i, { unit: e.target.value })}
                        >
                          {units.map((u) => (
                            <option key={u}>{u}</option>
                          ))}
                        </select>
                      </div>
                      {(errors[`lines.${i}.qty`] || errors[`lines.${i}.unit`]) && (
                        <div className="error">{errors[`lines.${i}.qty`] ?? errors[`lines.${i}.unit`]}</div>
                      )}
                    </div>
                    <div className={`field ${errors[`lines.${i}.lossPct`] ? 'invalid' : ''}`}>
                      <label htmlFor={`loss-${i}`}>Prep loss % (optional)</label>
                      <input
                        id={`loss-${i}`}
                        className="input"
                        inputMode="decimal"
                        value={l.lossPct}
                        onChange={(e) => updateLine(i, { lossPct: e.target.value })}
                        placeholder="0"
                      />
                      {errors[`lines.${i}.lossPct`] ? (
                        <div className="error">{errors[`lines.${i}.lossPct`]}</div>
                      ) : (
                        <div className="hint">Peeling, trimming, cooking loss</div>
                      )}
                    </div>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                    >
                      Remove line
                    </button>
                  </div>
                </div>
              );
            })}
            <div>
              <button
                type="button"
                className="btn sm"
                onClick={() =>
                  setLines((ls) => [...ls, { ingredientId: '', qty: '', unit: 'g', lossPct: '' }])
                }
              >
                <Icon.Plus size={16} /> Add ingredient line
              </button>
            </div>
            <div className="form-grid">
              <TextField
                label="Batch yield in portions (optional)"
                inputMode="decimal"
                value={yieldPortions}
                onChange={setYield}
                hint="If you cook in batches, how many portions one batch makes"
              />
              <TextField label="Recipe notes (optional)" value={notes} onChange={setNotes} />
            </div>
            <Check
              label="These quantities are verified — they match what our kitchen actually uses"
              checked={verified}
              onChange={setVerified}
              hint="Only verified recipes are used for stock, cost and recommendation calculations. Editing a recipe without ticking this removes verification."
            />
            {errors.verified && <div className="error small">{errors.verified}</div>}
            <div className="row">
              <Button className="primary" busy={saving} onClick={save}>
                Save recipe
              </Button>
              <button className="btn ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        </Card>
      )}
      {editItem && (
        <MenuItemDialog
          item={m}
          onClose={() => setEditItem(false)}
          onSaved={(x) => {
            setEditItem(false);
            setData({ ...m, ...x });
          }}
        />
      )}
    </div>
  );
}
