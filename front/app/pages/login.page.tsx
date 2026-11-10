import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button, Icon, Logo, Typography } from '@components';
import { INPUT_STATE_CLASSES } from '@constants';
import { ApiError } from '@services';
import { useAuthStore } from '@store';
import { cn } from '@utils';

const loginSchema = z.object({
  email: z.string().min(1, 'Adresse e-mail requise.'),
  password: z.string().min(1, 'Mot de passe requis.'),
});

type LoginValues = z.infer<typeof loginSchema>;

export function LoginPage() {
  const login = useAuthStore((state) => state.login);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await login(values.email, values.password);
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : 'Connexion impossible.');
    }
  });

  return (
    <main className="grid min-h-dvh place-items-center bg-page px-4">
      <form
        onSubmit={onSubmit}
        className="flex w-full max-w-form flex-col gap-stack-md rounded-panel border border-border-subtle bg-card p-8"
      >
        <Logo variant="wordmark" className="text-title" />

        <div className="flex flex-col gap-stack-xs">
          <Typography variant="display" className="text-brand dark:text-fg-primary">
            Connexion
          </Typography>
          <Typography variant="body" className="text-fg-secondary">
            Retrouve tes comptes, tes prévisions et ton travail.
          </Typography>
        </div>

        <div className="flex flex-col gap-stack-sm">
          <label className="text-control font-medium text-fg-primary" htmlFor="email">
            E-mail
          </label>
          <div
            className={cn(
              'rounded-control border bg-page transition-[border-color,box-shadow]',
              INPUT_STATE_CLASSES.default,
            )}
          >
            <input
              id="email"
              type="email"
              autoComplete="email"
              className="h-12 w-full bg-transparent px-3 text-body text-fg-primary outline-none"
              {...register('email')}
            />
          </div>
          {errors.email && <p className="text-control text-error">{errors.email.message}</p>}

          <label className="text-control font-medium text-fg-primary" htmlFor="password">
            Mot de passe
          </label>
          <div
            className={cn(
              'rounded-control border bg-page transition-[border-color,box-shadow]',
              INPUT_STATE_CLASSES.default,
            )}
          >
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              className="h-12 w-full bg-transparent px-3 text-body text-fg-primary outline-none"
              {...register('password')}
            />
          </div>
          {errors.password && <p className="text-control text-error">{errors.password.message}</p>}
        </div>

        {formError && (
          <p className="text-control text-error" role="alert">
            {formError}
          </p>
        )}

        <Button type="submit" loading={isSubmitting} loadingLabel="Connexion…">
          <Icon name="login" className="text-icon-sm" />
          Se connecter
        </Button>
      </form>
    </main>
  );
}
