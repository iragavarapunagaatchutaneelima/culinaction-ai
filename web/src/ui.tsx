import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import { getApiMode, type ApiError } from './api';
import { Icon } from './icons';

// ---------------- Toasts ----------------
type Toast = { id: number; text: string; kind: 'info' | 'error' };
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------- Layout pieces ----------------
export function PageHead({
  title,
  sub,
  crumb,
  actions,
}: {
  title: ReactNode;
  sub?: ReactNode;
  crumb?: { to: string; label: string };
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div style={{ minWidth: 0 }}>
        {crumb && (
          <Link className="crumb" to={crumb.to}>
            <Icon.Back size={16} /> {crumb.label}
          </Link>
        )}
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  tone,
  foot,
  className = '',
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  tone?: string;
  foot?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${tone ? `tone-${tone}` : ''} ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions}
        </div>
      )}
      {children}
      {foot && <div className="card-foot">{foot}</div>}
    </section>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" /> {label}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError | Error; onRetry?: () => void }) {
  const notFound = (error as ApiError).status === 404;
  return (
    <div className="card card-pad stack-sm" role="alert">
      <div className="row">
        <Icon.Alert />
        <h2>{notFound ? 'Not found' : 'Could not load this page'}</h2>
      </div>
      <p className="muted">
        {notFound ? 'This record does not exist, or you do not have access to it.' : error.message}
      </p>
      {onRetry && !notFound && (
        <div>
          <button className="btn sm" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="icon">{icon ?? <Icon.Info />}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Alert({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'warn' | 'danger' | 'ok';
  children: ReactNode;
}) {
  return (
    <div className={`alert ${kind}`} role={kind === 'danger' ? 'alert' : undefined}>
      {kind === 'danger' || kind === 'warn' ? (
        <Icon.Alert size={18} />
      ) : kind === 'ok' ? (
        <Icon.Check size={18} />
      ) : (
        <Icon.Info size={18} />
      )}
      <div>{children}</div>
    </div>
  );
}

// ---------------- Labels ----------------
export type ProvKind = 'actual' | 'forecast' | 'estimate' | 'illustrative' | 'unavailable' | 'ai';
const PROV_LABEL: Record<ProvKind, string> = {
  actual: 'Actual',
  forecast: 'Forecast',
  estimate: 'Estimate',
  illustrative: 'Illustrative',
  unavailable: 'Unavailable',
  ai: 'AI-written',
};
export function Prov({ kind, title }: { kind: ProvKind; title?: string }) {
  return (
    <span className={`prov ${kind}`} title={title}>
      {PROV_LABEL[kind]}
    </span>
  );
}

export function Badge({
  kind,
  children,
  title,
}: {
  kind?: 'danger' | 'warn' | 'ok' | 'info' | 'outline';
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`badge ${kind ?? ''}`} title={title}>
      {children}
    </span>
  );
}

const BATCH_STATUS: Record<string, [string, 'danger' | 'warn' | 'ok' | 'info' | 'outline']> = {
  unsafe: ['Do not use', 'danger'],
  verify: ['Check quality', 'warn'],
  expiring: ['Use soon', 'warn'],
  ok: ['Usable', 'ok'],
  empty: ['Used up', 'outline'],
};
export function BatchStatus({ status, reason }: { status: string; reason?: string }) {
  const [label, kind] = BATCH_STATUS[status] ?? [status, 'outline'];
  return (
    <Badge kind={kind} title={reason}>
      {label}
    </Badge>
  );
}

export function Tier({ tier }: { tier: number }) {
  const names = ['', 'Food safety', 'Service risk', 'Cost', 'Data quality'];
  return (
    <span className={`tier tier-${tier}`} title={names[tier]} aria-label={`Priority ${tier}: ${names[tier]}`}>
      {tier}
    </span>
  );
}

export function Confidence({ level }: { level: 'high' | 'medium' | 'low' }) {
  const kind = level === 'high' ? 'ok' : level === 'medium' ? 'info' : 'warn';
  return <Badge kind={kind}>{level[0].toUpperCase() + level.slice(1)} confidence</Badge>;
}

// ---------------- Form controls ----------------
export function Field({
  label,
  error,
  hint,
  children,
  className = '',
  htmlFor,
}: {
  label: ReactNode;
  error?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={`field ${error ? 'invalid' : ''} ${className}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && !error && <div className="hint">{hint}</div>}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export function TextField(props: {
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: ReactNode;
  required?: boolean;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
  className?: string;
  maxLength?: number;
  inputMode?: 'decimal' | 'numeric' | 'text';
  autoFocus?: boolean;
}) {
  const id = useId();
  return (
    <Field
      label={
        <>
          {props.label}
          {props.required && <span aria-hidden="true"> *</span>}
        </>
      }
      error={props.error}
      hint={props.hint}
      className={props.className}
      htmlFor={id}
    >
      <input
        id={id}
        className="input"
        type={props.type ?? 'text'}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        required={props.required}
        placeholder={props.placeholder}
        autoComplete={props.autoComplete}
        maxLength={props.maxLength}
        inputMode={props.inputMode}
        autoFocus={props.autoFocus}
        aria-invalid={!!props.error}
      />
    </Field>
  );
}

export function NumberField(
  props: Omit<Parameters<typeof TextField>[0], 'type' | 'inputMode'> & { integer?: boolean },
) {
  return <TextField {...props} inputMode={props.integer ? 'numeric' : 'decimal'} />;
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  error,
  hint,
  required,
  className,
  placeholder,
}: {
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  error?: string;
  hint?: ReactNode;
  required?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <Field
      label={
        <>
          {label}
          {required && <span aria-hidden="true"> *</span>}
        </>
      }
      error={error}
      hint={hint}
      className={className}
      htmlFor={id}
    >
      <select
        id={id}
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  error,
  hint,
  className,
}: {
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <Field label={label} error={error} hint={hint} className={className} htmlFor={id}>
      <textarea
        id={id}
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
      />
    </Field>
  );
}

export function QtyField({
  label,
  qty,
  unit,
  units,
  onQty,
  onUnit,
  error,
  hint,
  required,
  className,
}: {
  label: ReactNode;
  qty: string;
  unit: string;
  units: string[];
  onQty: (v: string) => void;
  onUnit: (v: string) => void;
  error?: string;
  hint?: ReactNode;
  required?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <Field
      label={
        <>
          {label}
          {required && <span aria-hidden="true"> *</span>}
        </>
      }
      error={error}
      hint={hint}
      className={className}
      htmlFor={id}
    >
      <div className="qty-input">
        <input
          id={id}
          className="input"
          inputMode="decimal"
          value={qty}
          onChange={(e) => onQty(e.target.value)}
          aria-invalid={!!error}
        />
        <select className="input" value={unit} onChange={(e) => onUnit(e.target.value)} aria-label="Unit">
          {units.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </div>
    </Field>
  );
}

export function Check({
  label,
  checked,
  onChange,
  hint,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: ReactNode;
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && (
          <span className="muted small" style={{ display: 'block' }}>
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}

export function Button({
  busy,
  children,
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button className={`btn ${className}`} disabled={busy || rest.disabled} {...rest}>
      {busy && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return <Alert kind="danger">{message}</Alert>;
}

// ---------------- Dialog ----------------
export function Dialog({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>(
      'input, select, textarea, button:not([data-close])',
    );
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close" data-close>
            <Icon.Close />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function downloadUrl(path: string) {
  // Plain links cannot send headers; Demo Mode downloads select the demo session with ?mode=demo (GET only).
  return `/api${path}${getApiMode() === 'demo' ? `${path.includes('?') ? '&' : '?'}mode=demo` : ''}`;
}
