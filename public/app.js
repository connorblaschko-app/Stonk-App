let chart;

const $ = (id) => document.getElementById(id);

function money(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value || 0);
}

function setStatus(message) {
  $('statusText').textContent = message;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error));
  return payload;
}

function parseCsv(csvText) {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error('CSV must include a header row and at least one data row.');
  }

  const headers = lines[0].split(',').map((header) => header.trim());
  const rows = lines.slice(1).map((line) => line.split(',').map((cell) => cell.trim()));

  return rows.map((cells) => {
    const row = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] || '';
    });
    return row;
  });
}

async function loadPortfolio() {
  const portfolio = await fetchJson('/api/portfolio');
  $('totalValue').textContent = money(portfolio.totalValue);
  $('lastSync').textContent = `Plaid sync: ${portfolio.lastPlaidSyncAt || 'never'}`;

  const tbody = $('positionsTable');
  tbody.innerHTML = '';

  for (const row of portfolio.positions) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${row.source}</td>
      <td>${row.account}</td>
      <td>${row.symbol}</td>
      <td>${row.name}</td>
      <td>${row.quantity}</td>
      <td>${money(row.price)}</td>
      <td>${money(row.value)}</td>
      <td>${row.source === 'Manual' ? `<button data-id="${row.id}" class="delete-btn">Delete</button>` : ''}</td>
    `;
    tbody.appendChild(tr);
  }

  document.querySelectorAll('.delete-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      await fetchJson(`/api/manual-investments/${button.dataset.id}`, { method: 'DELETE' });
      await loadPortfolio();
    });
  });

  const labels = Object.keys(portfolio.breakdownBySource);
  const values = Object.values(portfolio.breakdownBySource);
  const ctx = $('sourceChart').getContext('2d');

  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: values }]
    }
  });
}

async function connectPlaid() {
  setStatus('Creating Plaid link token...');
  const { link_token } = await fetchJson('/api/plaid/create_link_token', { method: 'POST' });

  const handler = Plaid.create({
    token: link_token,
    onSuccess: async (publicToken, metadata) => {
      setStatus('Exchanging public token...');
      await fetchJson('/api/plaid/exchange_public_token', {
        method: 'POST',
        body: JSON.stringify({ publicToken, institutionName: metadata.institution?.name })
      });
      setStatus('Plaid account connected.');
    },
    onExit: () => setStatus('Plaid link closed.')
  });

  handler.open();
}

async function wireUp() {
  $('connectPlaidBtn').addEventListener('click', async () => {
    try {
      await connectPlaid();
    } catch (error) {
      setStatus(`Plaid connect failed: ${error.message}`);
    }
  });

  $('syncPlaidBtn').addEventListener('click', async () => {
    try {
      setStatus('Syncing Plaid holdings...');
      const result = await fetchJson('/api/sync/plaid', { method: 'POST' });
      setStatus(`Synced ${result.syncedHoldings} holdings from Plaid.`);
      await loadPortfolio();
    } catch (error) {
      setStatus(`Plaid sync failed: ${error.message}`);
    }
  });

  $('syncSheetsBtn').addEventListener('click', async () => {
    try {
      setStatus('Syncing to Google Sheets...');
      const result = await fetchJson('/api/google-sheets/sync', { method: 'POST' });
      setStatus(`Synced ${result.rowsWritten} rows to Google Sheets.`);
    } catch (error) {
      setStatus(`Google Sheets sync failed: ${error.message}`);
    }
  });

  $('manualForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const payload = Object.fromEntries(formData.entries());

    try {
      await fetchJson('/api/manual-investments', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      event.currentTarget.reset();
      setStatus('Manual investment added.');
      await loadPortfolio();
    } catch (error) {
      setStatus(`Could not add manual investment: ${error.message}`);
    }
  });

  $('importCsvBtn').addEventListener('click', async () => {
    const fileInput = $('manualCsvFile');
    const file = fileInput.files?.[0];

    if (!file) {
      setStatus('Select a CSV file before importing.');
      return;
    }

    try {
      setStatus('Reading CSV file...');
      const csvText = await file.text();
      const rows = parseCsv(csvText);

      setStatus('Importing manual investments...');
      const result = await fetchJson('/api/manual-investments/import', {
        method: 'POST',
        body: JSON.stringify({ rows })
      });

      fileInput.value = '';
      setStatus(`Imported ${result.imported} manual investments from CSV.`);
      await loadPortfolio();
    } catch (error) {
      setStatus(`CSV import failed: ${error.message}`);
    }
  });

  await loadPortfolio();
}

wireUp().catch((error) => setStatus(`Initial load failed: ${error.message}`));
