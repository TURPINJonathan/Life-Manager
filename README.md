# Life Manager

Outil pour organiser le quotidien : comptes, budgets et travail, et d'autres modules ensuite.

Monorepo :

- `api/` — Symfony 8.1, API Platform, PostgreSQL, JWT Lexik
- `front/` — React Router, Tailwind, gardes de session et shell applicatif
- `docs/` — conventions détaillées
- `.cursor/rules/` — règles courtes pour l'agent

## Démarrage

Depuis WSL, à la racine :

```bash
cd api
make up
make install
make jwt-keys
make migrate
make user EMAIL=turpin.j@hotmail.fr PASSWORD='ChangeMe123!'
```

Le front écoute sur le port **9200** (volontairement éloigné de FYNX : 5173 / 5174) :

```bash
cd front
npm install
npm run dev
```

| Service | URL |
| --- | --- |
| API | http://localhost:9100 |
| OpenAPI | http://localhost:9100/api |
| Front | http://localhost:9200 |
| PostgreSQL | localhost:9432 (`lm` / `lm`, base `life_manager`) |

Node 22 est installé dans WSL sous `~/.local/node`. Ouvre un nouveau terminal si `node` n'est pas dans le `PATH`.

Les commandes `make` se lancent dans `api/`. Les commandes npm se lancent dans `front/`.

## Utiliser sur le téléphone (LAN / iOS)

L’app s’ouvre sur le Wi‑Fi local et s’installe via **Safari → Partager → Sur l’écran d’accueil** (PWA, pas l’App Store).

En dev, le front proxyfie `/api` vers `http://127.0.0.1:9100` : le téléphone n’a besoin que du port **9200** (pas d’IP API séparée, pas de CORS téléphone→API).

### 1. Exposer le port 9200 (WSL2)

`host: true` / `--host 0.0.0.0` ne suffisent **pas** sous WSL2 : l’IP Wi‑Fi Windows ne relaie pas automatiquement vers Vite. Choisir **une** option :

**A — Networking mirrored** (Windows 11) : dans `%UserProfile%\.wslconfig` :

```ini
[wsl2]
networkingMode=mirrored
```

Puis `wsl --shutdown` et rouvrir WSL. Les ports WSL sont alors sur l’IP Windows.

**B — Portproxy** (PowerShell **admin** côté Windows) :

```powershell
$wslIp = (wsl -d Ubuntu hostname -I).Trim().Split(" ")[0]
netsh interface portproxy add v4tov4 listenport=9200 listenaddress=0.0.0.0 connectport=9200 connectaddress=$wslIp
New-NetFirewallRule -DisplayName "Life Manager Vite 9200" -Direction Inbound -Protocol TCP -LocalPort 9200 -Action Allow -Profile Private
```

(`$wslIp` change parfois après reboot : refaire le `portproxy` ou passer en mirrored.)

### 2. Lancer et ouvrir

1. PC et iPhone sur le **même Wi‑Fi**.
2. `make up` (API) + `npm run dev` dans `front/` (ne pas fixer `VITE_API_URL` vers `localhost` : laisser vide pour le proxy).
3. IP Windows : `ipconfig` → IPv4 Wi‑Fi (ex. `192.168.1.20`).
4. iPhone Safari → `http://192.168.1.20:9200` → login → **Partager → Sur l’écran d’accueil**.

Si la page ne charge pas : pare-feu Windows (règle ci-dessus) ou IP WSL obsolète (refaire B). Si la page charge mais le login échoue : API Docker (`make up`) et proxy Vite actifs.
