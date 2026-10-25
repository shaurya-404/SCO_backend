# SCO Backend

Express API for SmartCloud Optimizer. It stores application data in a local
DuckDB database, imports the simulator CSV data, and generates optimization
recommendations.

## Requirements

- Node.js and npm
- Python 3 (needed by the simulator and the regenerate endpoint)

## Start locally

From the repository root:

```sh
npm ci
npm start
```

The server listens on port `5001` by default. On startup it creates the local
database, initializes any missing tables and demo users, and imports
`simulator/generated/resources.csv` and `simulator/generated/metrics.csv`.
The default database file is `DATABASE/local_metrics.duckdb`; the directory is
created automatically.

Check that the API is running:

```sh
curl http://localhost:5001/
```

The root endpoint responds with `{"status":200}`.

### Configuration

The backend reads these optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5001` | HTTP port |
| `DB_PATH` | `DATABASE/local_metrics.duckdb` | DuckDB file path; relative paths are resolved from the current working directory |
| `JWT_SECRET` | `fallback_secret` | Secret used to sign authentication tokens; set a strong local value |
| `GEMINI_API_KEY` | unset | Optional Gemini key for AI explanations |
| `OPENAI_API_KEY` | unset | Optional OpenAI key for AI explanations |

For example, in macOS/Linux:

```sh
export PORT=5001
export DB_PATH=./DATABASE/local_metrics.duckdb
export JWT_SECRET='replace-with-a-local-random-secret'
npm start
```

`.env.example` is a configuration reference; this project does not load `.env`
files automatically. Set variables in your shell or run configuration. Do not
use the fallback JWT secret outside local development.

## npm scripts

| Command | What it does |
| --- | --- |
| `npm start` | Starts `index.js` with Nodemon, which restarts the server when files change. |
| `npm test` | Runs the Node.js test suite (`node --test`). |
| `npm run seed` | Recreates and populates demo database tables, then imports generated simulator data. **Destructive:** existing users, company settings, inventory, metrics, and recommendations in the selected database are dropped/replaced. |
| `npm run reset:recommendations` | Sets every recommendation status back to `Pending` in the selected database. |

## Simulator

The simulator is a Python script rather than an npm script. It writes
`resources.csv`, `metrics.csv`, and `assumptions.json` under
`simulator/generated/` by default:

```sh
python3 simulator/simulator.py
```

To use a repeatable random seed or a different output folder:

```sh
python3 simulator/simulator.py --seed 42
python3 simulator/simulator.py --seed 42 --output-dir /tmp/sco-generated
```

The default dataset contains 100 resources and 30 days of metrics sampled every
15 minutes. After generating data in the default folder, restart the server or
call the authenticated `POST /api/recommendations/regenerate` endpoint to
import the generated CSV files and refresh recommendations. That endpoint also
runs the simulator and therefore requires `python3` to be available.

## API overview

The API base path is `/api`. Except for login and registration, the API routes
are protected by JWT authentication. Sign in with `POST /api/auth/login` and
send the returned token in the `Authorization` header using the `Bearer`
scheme (for example, `Authorization: Bearer YOUR_JWT_TOKEN`).

Main route groups:

- `/api/auth` — registration, login, profile
- `/api/company` — company settings
- `/api/inventory`, `/api/resources` — inventory and resource details
- `/api/metrics` — utilization, percentiles, anomalies, fleet metrics
- `/api/recommendations` — list, refresh, regenerate, apply, dismiss
- `/api/costs` — cost summary, breakdown, forecast, before/after
- `/api/alerts`, `/api/forecast`, `/api/optimization` — alerts and optimization
- `/api/simulator` — what-if simulation
- `/api/ai` — recommendation explanations
- `/api/export`, `/api/sustainability` — exports and sustainability data

The seeded local demo accounts are `engineer@cloud.com`,
`finance@cloud.com`, and `admin@cloud.com`, each with password
`password123`. These credentials are for local demonstration only.
