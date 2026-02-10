const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');
const { v4: uuidv4 } = require('uuid');
const { sheets, auth } = require('@googleapis/sheets');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'db.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const plaidEnv = process.env.PLAID_ENV || 'sandbox';
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[plaidEnv],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID || '',
      'PLAID-SECRET': process.env.PLAID_SECRET || ''
    }
  }
});
const plaidClient = new PlaidApi(plaidConfig);

async function ensureDb() {
  try {
    await fs.access(DB_PATH);
  } catch {
    const starter = {
      plaidItems: [],
      plaidHoldings: [],
      manualInvestments: [],
      lastSyncAt: null
    };
    await fs.writeFile(DB_PATH, JSON.stringify(starter, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const raw = await fs.readFile(DB_PATH, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(nextDb) {
  await fs.writeFile(DB_PATH, JSON.stringify(nextDb, null, 2));
}

function toNumber(input) {
  const value = Number(input);
  return Number.isFinite(value) ? value : 0;
}

function normalizeManualEntry(raw = {}) {
  const account = String(raw.account || '').trim();
  const symbol = String(raw.symbol || '').trim().toUpperCase();
  const name = String(raw.name || '').trim();

  if (!account || !symbol || !name) {
    return null;
  }

  return {
    id: uuidv4(),
    account,
    symbol,
    name,
    quantity: toNumber(raw.quantity),
    price: toNumber(raw.price),
    costBasis: toNumber(raw.costBasis),
    updatedAt: new Date().toISOString()
  };
}

function mergedPositions(db) {
  const plaidRows = db.plaidHoldings.map((holding) => ({
    id: holding.id,
    source: 'Plaid',
    account: holding.accountName,
    symbol: holding.symbol,
    name: holding.name,
    quantity: holding.quantity,
    price: holding.price,
    value: holding.value,
    costBasis: holding.costBasis,
    lastUpdated: holding.lastUpdated
  }));

  const manualRows = db.manualInvestments.map((manual) => ({
    id: manual.id,
    source: 'Manual',
    account: manual.account,
    symbol: manual.symbol,
    name: manual.name,
    quantity: manual.quantity,
    price: manual.price,
    value: manual.quantity * manual.price,
    costBasis: manual.costBasis,
    lastUpdated: manual.updatedAt
  }));

  return [...plaidRows, ...manualRows];
}

function groupBy(rows, key) {
  return rows.reduce((acc, row) => {
    const bucket = row[key] || 'Unknown';
    acc[bucket] = (acc[bucket] || 0) + toNumber(row.value);
    return acc;
  }, {});
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/config', (_req, res) => {
  res.json({
    plaidEnv,
    hasPlaidCredentials: Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET),
    hasGoogleSheetsConfig: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_SHEET_ID)
  });
});

app.post('/api/plaid/create_link_token', async (_req, res) => {
  try {
    if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
      return res.status(400).json({ error: 'Missing PLAID_CLIENT_ID or PLAID_SECRET.' });
    }

    const products = (process.env.PLAID_PRODUCTS || 'investments')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => Products[p.toUpperCase()] || p);

    const countries = (process.env.PLAID_COUNTRY_CODES || 'US')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => CountryCode[c.toUpperCase()] || c);

    const tokenResponse = await plaidClient.linkTokenCreate({
      user: {
        client_user_id: 'stonk-app-user'
      },
      client_name: 'Stonk App',
      products,
      country_codes: countries,
      language: 'en',
      redirect_uri: process.env.PLAID_REDIRECT_URI
    });

    return res.json({ link_token: tokenResponse.data.link_token });
  } catch (error) {
    const message = error.response?.data || error.message;
    return res.status(500).json({ error: message });
  }
});

app.post('/api/plaid/exchange_public_token', async (req, res) => {
  try {
    const { publicToken, institutionName } = req.body;

    if (!publicToken) {
      return res.status(400).json({ error: 'publicToken is required.' });
    }

    const exchangeResponse = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken
    });

    const accessToken = exchangeResponse.data.access_token;

    const db = await readDb();
    db.plaidItems.push({
      id: uuidv4(),
      institutionName: institutionName || 'Connected account',
      accessToken,
      createdAt: new Date().toISOString()
    });
    await writeDb(db);

    return res.json({ ok: true });
  } catch (error) {
    const message = error.response?.data || error.message;
    return res.status(500).json({ error: message });
  }
});

app.post('/api/sync/plaid', async (_req, res) => {
  try {
    const db = await readDb();
    const holdings = [];

    for (const item of db.plaidItems) {
      const response = await plaidClient.investmentsHoldingsGet({
        access_token: item.accessToken
      });

      const accountsById = Object.fromEntries(response.data.accounts.map((a) => [a.account_id, a]));
      const securitiesById = Object.fromEntries(response.data.securities.map((s) => [s.security_id, s]));

      for (const holding of response.data.holdings) {
        const account = accountsById[holding.account_id] || {};
        const security = securitiesById[holding.security_id] || {};
        holdings.push({
          id: `${item.id}:${holding.account_id}:${holding.security_id}`,
          itemId: item.id,
          accountName: account.name || item.institutionName,
          symbol: security.ticker_symbol || 'N/A',
          name: security.name || 'Unknown security',
          quantity: toNumber(holding.quantity),
          price: toNumber(holding.institution_price),
          value: toNumber(holding.institution_value),
          costBasis: toNumber(holding.cost_basis),
          lastUpdated: new Date().toISOString()
        });
      }
    }

    db.plaidHoldings = holdings;
    db.lastSyncAt = new Date().toISOString();
    await writeDb(db);

    return res.json({ ok: true, syncedHoldings: holdings.length, syncedAt: db.lastSyncAt });
  } catch (error) {
    const message = error.response?.data || error.message;
    return res.status(500).json({ error: message });
  }
});

app.get('/api/manual-investments', async (_req, res) => {
  const db = await readDb();
  res.json(db.manualInvestments);
});

app.post('/api/manual-investments', async (req, res) => {
  const { account, symbol, name, quantity, price, costBasis } = req.body;

  if (!account || !symbol || !name) {
    return res.status(400).json({ error: 'account, symbol, and name are required.' });
  }

  const entry = normalizeManualEntry({ account, symbol, name, quantity, price, costBasis });

  const db = await readDb();
  db.manualInvestments.push(entry);
  await writeDb(db);

  return res.status(201).json(entry);
});

app.post('/api/manual-investments/import', async (req, res) => {
  const { rows } = req.body;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'rows array is required.' });
  }

  const entries = rows
    .map((row) => normalizeManualEntry(row))
    .filter(Boolean);

  if (entries.length === 0) {
    return res.status(400).json({
      error: 'No valid rows found. Each row needs account, symbol, and name.'
    });
  }

  const db = await readDb();
  db.manualInvestments.push(...entries);
  await writeDb(db);

  return res.status(201).json({ imported: entries.length, entries });
});

app.delete('/api/manual-investments/:id', async (req, res) => {
  const db = await readDb();
  const before = db.manualInvestments.length;
  db.manualInvestments = db.manualInvestments.filter((x) => x.id !== req.params.id);
  await writeDb(db);
  return res.json({ removed: before !== db.manualInvestments.length });
});

app.get('/api/portfolio', async (_req, res) => {
  const db = await readDb();
  const positions = mergedPositions(db);
  const totalValue = positions.reduce((sum, row) => sum + toNumber(row.value), 0);

  res.json({
    totalValue,
    positions,
    breakdownBySource: groupBy(positions, 'source'),
    breakdownByAccount: groupBy(positions, 'account'),
    lastPlaidSyncAt: db.lastSyncAt
  });
});

app.post('/api/google-sheets/sync', async (_req, res) => {
  try {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.GOOGLE_SHEET_ID) {
      return res.status(400).json({
        error: 'Missing GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SHEET_ID.'
      });
    }

    const db = await readDb();
    const positions = mergedPositions(db);

    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const googleAuth = new auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheetsClient = sheets({ version: 'v4', auth: googleAuth });

    const rows = [
      ['Source', 'Account', 'Symbol', 'Name', 'Quantity', 'Price', 'Value', 'Cost Basis', 'Last Updated'],
      ...positions.map((p) => [
        p.source,
        p.account,
        p.symbol,
        p.name,
        p.quantity,
        p.price,
        p.value,
        p.costBasis,
        p.lastUpdated
      ])
    ];

    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Portfolio!A1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows }
    });

    return res.json({ ok: true, rowsWritten: rows.length - 1 });
  } catch (error) {
    const message = error.response?.data || error.message;
    return res.status(500).json({ error: message });
  }
});

app.listen(PORT, async () => {
  await ensureDb();
  console.log(`Stonk App running on http://localhost:${PORT}`);
});
