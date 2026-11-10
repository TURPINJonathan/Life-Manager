import { index, layout, route, type RouteConfig } from '@react-router/dev/routes';

export default [
  layout('routes/_root.tsx', [
    layout('routes/_protected.tsx', [
      layout('routes/_app.tsx', [
        index('routes/home.tsx'),
        route('comptes', 'routes/accounts.tsx'),
        route('comptes/:subAccountId', 'routes/account-ledger.tsx'),
        route('travail', 'routes/work.tsx'),
        route('travail/:jobId', 'routes/work-job.tsx'),

        route('parametres', 'routes/settings.tsx', [
          index('routes/settings.index.tsx'),
          route(':section', 'routes/settings.$section.tsx'),
        ]),
      ]),
    ]),
    layout('routes/_guest.tsx', [route('login', 'routes/login.tsx')]),
  ]),
] satisfies RouteConfig;
