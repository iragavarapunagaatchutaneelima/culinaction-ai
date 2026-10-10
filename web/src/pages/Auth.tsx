import { post } from '../api';
import { useForm } from '../hooks';
import { Logo } from '../icons';
import { useSession } from '../session';
import { Button, FormError, TextField } from '../ui';

export function AuthPage({ mode }: { mode: 'setup' | 'login' }) {
  const { refresh } = useSession();
  const f = useForm({ username: '', displayName: '', password: '', confirm: '' });
  const setup = mode === 'setup';

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void f.submit(
      async (v) => {
        if (setup)
          await post('/auth/setup', {
            username: v.username,
            displayName: v.displayName,
            password: v.password,
          });
        else await post('/auth/login', { username: v.username, password: v.password });
        await refresh();
      },
      (v) => {
        const e: Record<string, string> = {};
        if (!v.username.trim()) e.username = 'Required';
        if (!v.password) e.password = 'Required';
        if (setup) {
          if (!v.displayName.trim()) e.displayName = 'Required';
          if (v.password.length < 8) e.password = 'At least 8 characters';
          if (v.password !== v.confirm) e.confirm = 'Passwords do not match';
        }
        return e;
      },
    );
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brandmark">
          <Logo size={30} /> CulinAction AI
        </div>
        <p className="tagline">Smarter kitchen decisions. Less avoidable waste.</p>
        <form className="card card-pad form" onSubmit={onSubmit} noValidate>
          <div>
            <h1>{setup ? 'Create the owner account' : 'Sign in'}</h1>
            <p className="muted small" style={{ marginTop: 4 }}>
              {setup
                ? 'This is the first account on this server. It will own the outlets you create. Data is stored only on this server.'
                : 'Use the account created for you by your outlet owner.'}
            </p>
          </div>
          <FormError message={f.formError} />
          <TextField
            label="Username"
            value={f.values.username}
            onChange={(v) => f.set('username', v)}
            error={f.errors.username}
            autoComplete="username"
            required
            autoFocus
          />
          {setup && (
            <TextField
              label="Your name"
              value={f.values.displayName}
              onChange={(v) => f.set('displayName', v)}
              error={f.errors.displayName}
              autoComplete="name"
              required
            />
          )}
          <TextField
            label="Password"
            type="password"
            value={f.values.password}
            onChange={(v) => f.set('password', v)}
            error={f.errors.password}
            autoComplete={setup ? 'new-password' : 'current-password'}
            required
            hint={setup ? 'At least 8 characters' : undefined}
          />
          {setup && (
            <TextField
              label="Confirm password"
              type="password"
              value={f.values.confirm}
              onChange={(v) => f.set('confirm', v)}
              error={f.errors.confirm}
              autoComplete="new-password"
              required
            />
          )}
          <Button className="primary block" type="submit" busy={f.submitting}>
            {setup ? 'Create account' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  );
}
