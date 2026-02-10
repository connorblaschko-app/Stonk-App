# Stonk App

A lightweight investment tracker that combines:

- **Plaid-linked investment holdings** (automatic sync)
- **Manual investments** (for private equity, real estate, pensions, etc.)
- **Google Sheets export** (to keep your sheet as a live reporting layer)

## Features

- Connect one or more brokerages via Plaid Link.
- Pull holdings data from Plaid and normalize it in one dashboard.
- Manually add/delete positions not available in Plaid.
- View total portfolio + source breakdown chart.
- Push all merged positions into a Google Sheet tab (`Portfolio!A1`).

## Quick start

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000`.

## Plaid setup

1. Create a Plaid app and collect your credentials.
2. Populate:
   - `PLAID_ENV` (`sandbox`, `development`, or `production`)
   - `PLAID_CLIENT_ID`
   - `PLAID_SECRET`
   - `PLAID_PRODUCTS=investments`
3. If required by your Plaid setup, set `PLAID_REDIRECT_URI`.

## Google Sheets setup

1. Create a Google Cloud service account with Sheets API access.
2. Share your target sheet with the service account email.
3. Populate:
   - `GOOGLE_SHEET_ID`
   - `GOOGLE_SERVICE_ACCOUNT_JSON` (inline JSON string)
4. Create a sheet tab named `Portfolio` (or update `server.js` range).

## API endpoints

- `POST /api/plaid/create_link_token`
- `POST /api/plaid/exchange_public_token`
- `POST /api/sync/plaid`
- `GET /api/portfolio`
- `POST /api/manual-investments`
- `DELETE /api/manual-investments/:id`
- `POST /api/google-sheets/sync`

## Data storage

The app stores data in `db.json` in project root. This is intentionally simple for local usage and easy backup.
