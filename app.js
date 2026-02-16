import {
  SCHEMA_VERSION,
  initializeDb,
  getSettings,
  saveSettings,
  getTrips,
  getTripById,
  upsertTrip,
  deleteTripCascade,
  getExpensesByTrip,
  getAllExpenses,
  getExpenseById,
  upsertExpense,
  deleteExpense,
  getSchemaVersion,
  restoreBackup
} from './db.js';

const state = {
  settings: { categories: [], paymentMethods: [] },
  trips: [],
  activeTripId: localStorage.getItem('activeTripId') || '',
  expenses: [],
  filters: {
    startDate: '',
    endDate: '',
    category: 'All',
    payment: 'All',
    search: ''
  },
  editingTripId: null,
  editingExpenseId: null,
  pendingRestore: null,
  saveAndClose: false,
  currentMonth: null,
  categoryChart: null
};

const els = {};

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function nowLocalDateTimeInput() {
  const d = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toInputDate(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function escapeHtml(str) {
  return String(str || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function moneyFormat(value, currency) {
  const decimals = currency === 'JPY' ? 0 : 2;
  return `${Number(value).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })} ${currency}`;
}

function roundBaseAmount(raw, baseCurrency) {
  if (baseCurrency === 'JPY') return Math.round(raw);
  return Math.round(raw * 100) / 100;
}

function parseCurrencies(input, baseCurrency) {
  const set = new Set(
    input
      .split(',')
      .map((v) => v.trim().toUpperCase())
      .filter(Boolean)
  );
  set.add((baseCurrency || '').trim().toUpperCase());
  return [...set].filter(Boolean);
}

function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'trip';
}

function downloadBlob(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function activeTrip() {
  return state.trips.find((t) => t.id === state.activeTripId) || null;
}

function setStatus(msg, timeout = 3000) {
  els.status.textContent = msg;
  if (timeout > 0) {
    window.clearTimeout(setStatus._t);
    setStatus._t = window.setTimeout(() => {
      if (els.status.textContent === msg) els.status.textContent = '';
    }, timeout);
  }
}

async function loadAll() {
  state.settings = await getSettings();
  state.trips = await getTrips();

  if (!state.activeTripId && state.trips.length) {
    state.activeTripId = state.trips[0].id;
    localStorage.setItem('activeTripId', state.activeTripId);
  }

  if (state.activeTripId && !state.trips.some((t) => t.id === state.activeTripId)) {
    state.activeTripId = state.trips[0]?.id || '';
    if (state.activeTripId) localStorage.setItem('activeTripId', state.activeTripId);
    else localStorage.removeItem('activeTripId');
  }

  await loadExpenses();
}

async function loadExpenses() {
  const trip = activeTrip();
  if (!trip) {
    state.expenses = [];
    return;
  }

  const expenses = await getExpensesByTrip(trip.id);
  expenses.sort((a, b) => {
    if (a.dateTime === b.dateTime) return (b.createdAt || 0) - (a.createdAt || 0);
    return a.dateTime < b.dateTime ? 1 : -1;
  });
  state.expenses = expenses;
}

function renderTripSelector() {
  const trip = activeTrip();
  els.activeTripSelect.innerHTML = '<option value="">Select trip</option>' + state.trips
    .map((t) => `<option value="${escapeHtml(t.id)}" ${t.id === state.activeTripId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`)
    .join('');

  els.activeTripSummary.textContent = trip
    ? `${trip.name} (${trip.startDate} to ${trip.endDate})`
    : 'No active trip';
}

function fillTripForm(trip = null) {
  const editing = Boolean(trip);
  state.editingTripId = trip?.id || null;
  els.tripFormTitle.textContent = editing ? 'Edit Trip' : 'Create Trip';

  els.tripName.value = trip?.name || '';
  els.tripStartDate.value = trip?.startDate || '';
  els.tripEndDate.value = trip?.endDate || '';
  els.tripBaseCurrency.value = trip?.baseCurrency || 'JPY';
  els.tripCurrencies.value = (trip?.currencies || ['JPY', 'HKD']).join(', ');
  els.tripBudgetEnabled.checked = trip?.budgetEnabled ?? true;
  els.tripBudgetAmount.value = trip?.budgetAmountBase ?? '';
  els.tripDailyBudgetAmount.value = trip?.dailyBudgetAmountBase ?? '';
  toggleBudgetFields();
}

function renderTripList() {
  if (!state.trips.length) {
    els.tripList.innerHTML = '<p class="empty">No trips yet. Create your first trip to start tracking expenses.</p>';
    return;
  }

  els.tripList.innerHTML = state.trips
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map((trip) => {
      const isActive = trip.id === state.activeTripId;
      return `
      <article class="card ${isActive ? 'active' : ''}">
        <h3>${escapeHtml(trip.name)}</h3>
        <p>${escapeHtml(trip.startDate)} to ${escapeHtml(trip.endDate)}</p>
        <p>Base: ${escapeHtml(trip.baseCurrency)} | Currencies: ${escapeHtml(trip.currencies.join(', '))}</p>
        <p>Budget: ${trip.budgetEnabled ? moneyFormat(trip.budgetAmountBase || 0, trip.baseCurrency) : 'Disabled'}</p>
        <div class="row-actions">
          <button data-action="set-active" data-id="${escapeHtml(trip.id)}">Set Active</button>
          <button data-action="edit" data-id="${escapeHtml(trip.id)}">Edit</button>
          <button data-action="delete" data-id="${escapeHtml(trip.id)}" class="danger">Delete</button>
        </div>
      </article>`;
    })
    .join('');
}

function applyQuickDateFilter(kind) {
  const trip = activeTrip();
  if (!trip) return;

  if (kind === 'trip') {
    state.filters.startDate = trip.startDate;
    state.filters.endDate = trip.endDate;
  }
  if (kind === 'today') {
    const today = toInputDate(Date.now());
    state.filters.startDate = today;
    state.filters.endDate = today;
  }

  syncFilterInputs();
  renderExpenseList();
  renderDashboard();
}

function syncFilterInputs() {
  els.filterStartDate.value = state.filters.startDate;
  els.filterEndDate.value = state.filters.endDate;
  els.filterCategory.value = state.filters.category;
  els.filterPayment.value = state.filters.payment;
  els.filterSearch.value = state.filters.search;
}

function renderFilterOptions() {
  els.filterCategory.innerHTML = '<option value="All">All categories</option>' + state.settings.categories
    .map((cat) => `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`)
    .join('');

  els.filterPayment.innerHTML = '<option value="All">All payment methods</option>' + state.settings.paymentMethods
    .map((pay) => `<option value="${escapeHtml(pay)}">${escapeHtml(pay)}</option>`)
    .join('');

  if (!state.settings.categories.includes(state.filters.category)) state.filters.category = 'All';
  if (!state.settings.paymentMethods.includes(state.filters.payment)) state.filters.payment = 'All';

  syncFilterInputs();
}

function filteredExpenses() {
  const search = state.filters.search.trim().toLowerCase();

  return state.expenses.filter((exp) => {
    if (state.filters.startDate && exp.dateTime.slice(0, 10) < state.filters.startDate) return false;
    if (state.filters.endDate && exp.dateTime.slice(0, 10) > state.filters.endDate) return false;
    if (state.filters.category !== 'All' && exp.category !== state.filters.category) return false;
    if (state.filters.payment !== 'All' && exp.payment !== state.filters.payment) return false;

    if (search) {
      const bag = [exp.note || '', exp.location || '', ...(exp.tags || [])].join(' ').toLowerCase();
      if (!bag.includes(search)) return false;
    }

    return true;
  });
}

function renderExpenseFormSelectors() {
  const trip = activeTrip();
  const categories = state.settings.categories;
  const payments = state.settings.paymentMethods;
  const currencies = trip?.currencies || [];

  els.expCategory.innerHTML = categories.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  els.expPayment.innerHTML = payments.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  els.expCurrency.innerHTML = currencies.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
}

function setExpenseDefaults({ resetAmount = true } = {}) {
  const trip = activeTrip();
  if (!trip) return;

  const defaultsRaw = localStorage.getItem(`tripDefaults_${trip.id}`);
  const defaults = defaultsRaw ? JSON.parse(defaultsRaw) : {};

  state.editingExpenseId = null;
  els.expenseFormTitle.textContent = 'Add Expense';
  els.expenseId.value = '';
  els.expDateTime.value = nowLocalDateTimeInput();
  if (resetAmount) els.expAmountOriginal.value = '';
  els.expCategory.value = defaults.category && state.settings.categories.includes(defaults.category)
    ? defaults.category
    : state.settings.categories[0] || '';
  els.expPayment.value = defaults.payment && state.settings.paymentMethods.includes(defaults.payment)
    ? defaults.payment
    : state.settings.paymentMethods[0] || '';

  if (trip.currencies.includes(defaults.currency)) {
    els.expCurrency.value = defaults.currency;
  } else {
    els.expCurrency.value = trip.baseCurrency;
  }

  els.expFx.value = defaults.fxRate ? String(defaults.fxRate) : '';
  els.expNote.value = '';
  els.expPaidBy.value = 'Me';
  els.expLocation.value = '';
  els.expTags.value = '';

  updateFxVisibility();
  updateAmountBasePreview();

  setTimeout(() => els.expAmountOriginal.focus(), 50);
}

function updateFxVisibility() {
  const trip = activeTrip();
  if (!trip) return;
  const currency = els.expCurrency.value;
  const isBase = currency === trip.baseCurrency;
  els.fxField.classList.toggle('hidden', isBase);
  els.expFx.disabled = isBase;
  if (isBase) {
    els.expFx.value = '1';
  } else {
    const last = findLastFxRate(trip.id, currency);
    if (!els.expFx.value && last) els.expFx.value = String(last);
  }
}

function findLastFxRate(tripId, currency) {
  const hit = state.expenses
    .filter((e) => e.tripId === tripId && e.currency === currency && Number(e.fxRateToBase) > 0)
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))[0];
  return hit?.fxRateToBase || null;
}

function updateAmountBasePreview() {
  const trip = activeTrip();
  if (!trip) {
    els.amountBasePreview.textContent = '-';
    return;
  }
  const amount = Number(els.expAmountOriginal.value);
  if (!(amount > 0)) {
    els.amountBasePreview.textContent = '-';
    return;
  }

  const currency = els.expCurrency.value;
  const fx = currency === trip.baseCurrency ? 1 : Number(els.expFx.value);

  if (!(fx > 0)) {
    els.amountBasePreview.textContent = 'Invalid FX';
    return;
  }

  const amountBase = roundBaseAmount(amount * fx, trip.baseCurrency);
  els.amountBasePreview.textContent = moneyFormat(amountBase, trip.baseCurrency);
}

function validateTripForm(payload) {
  if (!payload.name || payload.name.length > 50) return 'Trip name is required (1-50 chars).';
  if (!payload.startDate || !payload.endDate) return 'Start and end date are required.';
  if (payload.startDate > payload.endDate) return 'Start date must be before or equal to end date.';
  if (!payload.baseCurrency) return 'Base currency is required.';
  if (!payload.currencies.includes(payload.baseCurrency)) return 'Currencies must include base currency.';
  if (payload.budgetEnabled && !(Number(payload.budgetAmountBase) > 0)) {
    return 'Budget amount is required when budget is enabled.';
  }
  return null;
}

function validateExpense(exp, trip) {
  if (!(Number(exp.amountOriginal) > 0)) return 'Amount must be greater than 0.';
  if (!exp.currency) return 'Currency is required.';
  if (!exp.dateTime) return 'Date/time is required.';
  if (!exp.category) return 'Category is required.';
  if (!exp.payment) return 'Payment method is required.';
  if (exp.currency !== trip.baseCurrency && !(Number(exp.fxRateToBase) > 0)) {
    return 'FX rate must be greater than 0 for non-base currency.';
  }
  if ((exp.note || '').length > 120) return 'Note must be 120 chars or less.';
  if ((exp.location || '').length > 80) return 'Location must be 80 chars or less.';
  if ((exp.tags || []).length > 10) return 'Maximum 10 tags.';
  return null;
}

function collectTripFormData() {
  const baseCurrency = els.tripBaseCurrency.value.trim().toUpperCase();
  const currencies = parseCurrencies(els.tripCurrencies.value, baseCurrency);

  return {
    id: state.editingTripId || uid('trip'),
    name: els.tripName.value.trim(),
    startDate: els.tripStartDate.value,
    endDate: els.tripEndDate.value,
    baseCurrency,
    currencies,
    budgetEnabled: els.tripBudgetEnabled.checked,
    budgetAmountBase: els.tripBudgetEnabled.checked ? Number(els.tripBudgetAmount.value) : 0,
    dailyBudgetAmountBase: els.tripDailyBudgetAmount.value ? Number(els.tripDailyBudgetAmount.value) : null,
    createdAt: Date.now()
  };
}

function collectExpenseFormData() {
  const trip = activeTrip();
  const currency = els.expCurrency.value;
  const fxRateToBase = currency === trip.baseCurrency ? 1 : Number(els.expFx.value);
  const amountOriginal = Number(els.expAmountOriginal.value);
  const amountBase = roundBaseAmount(amountOriginal * fxRateToBase, trip.baseCurrency);
  const tags = els.expTags.value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((t) => t.slice(0, 24));

  return {
    id: state.editingExpenseId || uid('exp'),
    tripId: trip.id,
    dateTime: els.expDateTime.value || nowLocalDateTimeInput(),
    amountOriginal,
    currency,
    fxRateToBase,
    amountBase,
    category: els.expCategory.value,
    payment: els.expPayment.value,
    note: els.expNote.value.trim(),
    paidBy: els.expPaidBy.value,
    location: els.expLocation.value.trim(),
    tags,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

function renderExpenseList() {
  const trip = activeTrip();
  if (!trip) {
    els.expenseList.innerHTML = '<p class="empty">Select or create a trip first.</p>';
    els.expenseCount.textContent = '0';
    return;
  }

  const list = filteredExpenses();
  els.expenseCount.textContent = String(list.length);

  if (!list.length) {
    els.expenseList.innerHTML = '<p class="empty">No expenses match the current filters.</p>';
    return;
  }

  els.expenseList.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Date/Time</th>
          <th>Original</th>
          <th>Base</th>
          <th>Category</th>
          <th>Payment</th>
          <th>Note</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${list
          .map(
            (exp) => `
            <tr>
              <td>${escapeHtml(exp.dateTime.replace('T', ' '))}</td>
              <td>${moneyFormat(exp.amountOriginal, exp.currency)}</td>
              <td>${moneyFormat(exp.amountBase, trip.baseCurrency)}</td>
              <td>${escapeHtml(exp.category)}</td>
              <td>${escapeHtml(exp.payment)}</td>
              <td title="${escapeHtml(exp.note || '')}">${escapeHtml((exp.note || '').slice(0, 36))}</td>
              <td>
                <button data-action="edit-expense" data-id="${escapeHtml(exp.id)}">Edit</button>
                <button data-action="delete-expense" data-id="${escapeHtml(exp.id)}" class="danger">Delete</button>
              </td>
            </tr>
          `
          )
          .join('')}
      </tbody>
    </table>`;
}

function aggregateBy(items, key) {
  const map = new Map();
  for (const item of items) {
    const k = item[key] || 'Unknown';
    map.set(k, (map.get(k) || 0) + Number(item.amountBase || 0));
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function aggregateByDay(items) {
  const map = new Map();
  for (const item of items) {
    const day = item.dateTime.slice(0, 10);
    map.set(day, (map.get(day) || 0) + Number(item.amountBase || 0));
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function renderBars(container, rows, currency, maxItems = 10) {
  if (!rows.length) {
    container.innerHTML = '<p class="empty">No data</p>';
    return;
  }
  const sliced = rows.slice(0, maxItems);
  const max = Math.max(...sliced.map(([, v]) => Number(v) || 0), 1);
  container.innerHTML = sliced
    .map(([label, value]) => {
      const pct = (Number(value) / max) * 100;
      return `
      <div class="bar-row">
        <div class="bar-label">${escapeHtml(label)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="bar-value">${moneyFormat(value, currency)}</div>
      </div>`;
    })
    .join('');
}

function renderTable(container, rows, currency) {
  if (!rows.length) {
    container.innerHTML = '<p class="empty">No data</p>';
    return;
  }

  container.innerHTML = `
    <table>
      <thead><tr><th>Item</th><th>Total</th></tr></thead>
      <tbody>
        ${rows
          .map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${moneyFormat(value, currency)}</td></tr>`)
          .join('')}
      </tbody>
    </table>`;
}

function renderDashboard() {
  const trip = activeTrip();
  if (!trip) {
    els.totalSpent.textContent = '-';
    els.budgetPanel.innerHTML = '<div class="summary-label">Budget</div><div class="summary-value">-</div>';
    els.categoryChart.innerHTML = '<p class="empty">No data</p>';
    els.categoryTable.innerHTML = '';
    els.dailyChart.innerHTML = '';
    els.paymentChart.innerHTML = '';
    els.paymentTable.innerHTML = '';
    if (state.categoryChart) {
      state.categoryChart.destroy();
      state.categoryChart = null;
    }
    return;
  }

  const items = filteredExpenses();
  const total = items.reduce((sum, x) => sum + Number(x.amountBase || 0), 0);
  els.totalSpent.textContent = moneyFormat(total, trip.baseCurrency);

  const byCategory = aggregateBy(items, 'category');
  const byPayment = aggregateBy(items, 'payment');
  const byDay = aggregateByDay(items);

  // Render donut chart for categories
  renderDonutChart(byCategory, trip.baseCurrency);
  
  // Render category list below chart
  renderCategoryList(byCategory, total, trip.baseCurrency);
  
  renderTable(els.categoryTable, byCategory, trip.baseCurrency);
  renderBars(els.paymentChart, byPayment, trip.baseCurrency);
  renderTable(els.paymentTable, byPayment, trip.baseCurrency);
  renderBars(els.dailyChart, byDay, trip.baseCurrency, 20);

  if (trip.budgetEnabled) {
    const remaining = Number(trip.budgetAmountBase || 0) - total;
    const remainingClass = remaining >= 0 ? 'positive' : 'negative';

    const tripStart = new Date(`${trip.startDate}T00:00`);
    const tripEnd = new Date(`${trip.endDate}T23:59`);
    const now = new Date();
    const endForElapsed = now < tripEnd ? now : tripEnd;
    const elapsedMs = Math.max(endForElapsed - tripStart, 0);
    const daysElapsed = Math.max(Math.floor(elapsedMs / (1000 * 60 * 60 * 24)) + 1, 1);
    const avgPerDay = total / daysElapsed;

    els.budgetPanel.innerHTML = `
      <div class="summary-label">Budget Remaining</div>
      <div class="summary-value ${remainingClass}">${moneyFormat(remaining, trip.baseCurrency)}</div>
      <div style="margin-top: 8px; font-size: 13px; color: var(--text-secondary);">
        Budget: ${moneyFormat(trip.budgetAmountBase || 0, trip.baseCurrency)}<br>
        Avg/day: ${moneyFormat(avgPerDay, trip.baseCurrency)}
        ${trip.dailyBudgetAmountBase ? `<br>Daily budget: ${moneyFormat(trip.dailyBudgetAmountBase, trip.baseCurrency)}` : ''}
      </div>
    `;
  } else {
    els.budgetPanel.innerHTML = '<div class="summary-label">Budget</div><div class="summary-value">Disabled</div>';
  }
}

function renderDonutChart(categoryData, currency) {
  const canvas = document.getElementById('categoryChartCanvas');
  if (!canvas) return;

  if (state.categoryChart) {
    state.categoryChart.destroy();
  }

  if (!categoryData.length) {
    return;
  }

  const colors = [
    '#007AFF', '#34C759', '#FF3B30', '#FF9500', '#AF52DE',
    '#5856D6', '#00C7BE', '#FF2D55', '#5AC8FA', '#FFCC00'
  ];

  const Chart = window.Chart;
  if (!Chart) return;

  state.categoryChart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: categoryData.map(([label]) => label),
      datasets: [{
        data: categoryData.map(([, value]) => value),
        backgroundColor: colors,
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const label = context.label || '';
              const value = context.parsed || 0;
              return `${label}: ${moneyFormat(value, currency)}`;
            }
          }
        }
      }
    }
  });
}

function renderCategoryList(categoryData, total, currency) {
  if (!categoryData.length) {
    els.categoryChart.innerHTML = '<p class="empty">No expenses yet</p>';
    return;
  }

  const colors = [
    '#007AFF', '#34C759', '#FF3B30', '#FF9500', '#AF52DE',
    '#5856D6', '#00C7BE', '#FF2D55', '#5AC8FA', '#FFCC00'
  ];

  const categoryIcons = {
    'Flights': '✈️',
    'Lodging': '🏨',
    'Local transport': '🚇',
    'Food & drinks': '🍽️',
    'Attractions': '🎭',
    'Shopping': '🛍️',
    'SIM/Internet': '📱',
    'Fees (ATM/baggage/etc.)': '💰',
    'Misc': '📦',
    'Souvenirs': '🎁'
  };

  els.categoryChart.innerHTML = categoryData.slice(0, 10).map(([label, value], idx) => {
    const percent = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
    const icon = categoryIcons[label] || '📊';
    return `
      <div class="category-item">
        <div class="list-item-icon">${icon}</div>
        <div class="category-name">${escapeHtml(label)}</div>
        <div class="category-percent">${percent}%</div>
        <div class="category-amount">${moneyFormat(value, currency)}</div>
      </div>
    `;
  }).join('');
}

function refreshUI() {
  renderTripSelector();
  renderTripList();
  renderFilterOptions();
  renderExpenseFormSelectors();
  renderExpenseList();
  renderDashboard();

  const trip = activeTrip();
  els.noTripNotice.classList.toggle('hidden', Boolean(trip));
  els.mainPanels.classList.toggle('hidden', !trip);

  if (trip) {
    if (!state.filters.startDate || !state.filters.endDate) {
      state.filters.startDate = trip.startDate;
      state.filters.endDate = trip.endDate;
      syncFilterInputs();
    }

    setExpenseDefaults();
  }
}

async function handleTripSubmit(e) {
  e.preventDefault();

  const wasEditing = Boolean(state.editingTripId);
  const newTrip = collectTripFormData();
  const validation = validateTripForm(newTrip);
  if (validation) {
    setStatus(validation, 4000);
    return;
  }

  if (state.editingTripId) {
    const old = await getTripById(state.editingTripId);
    if (old && old.baseCurrency !== newTrip.baseCurrency) {
      const existingExpenses = await getExpensesByTrip(old.id);
      if (existingExpenses.length > 0) {
        setStatus('Base currency cannot be changed once expenses exist for this trip in v1.', 5000);
        return;
      }
    }

    newTrip.createdAt = old?.createdAt || newTrip.createdAt;
  }

  await upsertTrip(newTrip);

  if (!state.activeTripId) {
    state.activeTripId = newTrip.id;
    localStorage.setItem('activeTripId', newTrip.id);
  }

  await loadAll();
  fillTripForm();
  refreshUI();
  setStatus(wasEditing ? 'Trip updated.' : 'Trip created.');
}

async function handleTripListClick(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;
  const tripId = btn.dataset.id;
  if (!tripId) return;

  if (action === 'set-active') {
    state.activeTripId = tripId;
    localStorage.setItem('activeTripId', tripId);
    await loadExpenses();
    state.filters.startDate = '';
    state.filters.endDate = '';
    refreshUI();
    return;
  }

  if (action === 'edit') {
    const trip = state.trips.find((t) => t.id === tripId);
    if (trip) fillTripForm(trip);
    return;
  }

  if (action === 'delete') {
    const trip = state.trips.find((t) => t.id === tripId);
    if (!trip) return;
    const ok = window.confirm(`Delete trip "${trip.name}" and all its expenses?`);
    if (!ok) return;

    await deleteTripCascade(tripId);
    if (state.activeTripId === tripId) {
      state.activeTripId = '';
      localStorage.removeItem('activeTripId');
    }

    await loadAll();
    fillTripForm();
    refreshUI();
    setStatus('Trip deleted.');
  }
}

async function handleExpenseSubmit(e) {
  e.preventDefault();

  const trip = activeTrip();
  if (!trip) {
    setStatus('Create/select a trip first.', 4000);
    return;
  }

  const wasEditing = Boolean(state.editingExpenseId);
  const exp = collectExpenseFormData();

  const validation = validateExpense(exp, trip);
  if (validation) {
    setStatus(validation, 4000);
    return;
  }

  if (state.editingExpenseId) {
    const existing = await getExpenseById(state.editingExpenseId);
    exp.createdAt = existing?.createdAt || exp.createdAt;
  }

  await upsertExpense(exp);

  localStorage.setItem(
    `tripDefaults_${trip.id}`,
    JSON.stringify({
      category: exp.category,
      payment: exp.payment,
      currency: exp.currency,
      fxRate: exp.fxRateToBase
    })
  );

  await loadExpenses();
  renderExpenseList();
  renderDashboard();

  const close = state.saveAndClose;
  setExpenseDefaults({ resetAmount: true });
  setStatus(wasEditing ? 'Expense updated.' : 'Expense added.');

  if (close) {
    showTab('expenses');
  }
}

async function handleExpenseListClick(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;
  const id = btn.dataset.id;
  if (!id) return;

  if (action === 'edit-expense') {
    const exp = await getExpenseById(id);
    if (!exp) return;

    state.editingExpenseId = exp.id;
    els.expenseFormTitle.textContent = 'Edit Expense';
    els.expenseId.value = exp.id;
    els.expDateTime.value = exp.dateTime;
    els.expAmountOriginal.value = exp.amountOriginal;
    els.expCurrency.value = exp.currency;
    els.expFx.value = exp.fxRateToBase;
    els.expCategory.value = exp.category;
    els.expPayment.value = exp.payment;
    els.expNote.value = exp.note || '';
    els.expPaidBy.value = exp.paidBy || 'Me';
    els.expLocation.value = exp.location || '';
    els.expTags.value = (exp.tags || []).join(', ');
    updateFxVisibility();
    updateAmountBasePreview();
    showTab('add-expense');
    setTimeout(() => els.expAmountOriginal.focus(), 50);
    return;
  }

  if (action === 'delete-expense') {
    const ok = window.confirm('Delete this expense?');
    if (!ok) return;

    await deleteExpense(id);
    await loadExpenses();
    renderExpenseList();
    renderDashboard();
    setStatus('Expense deleted.');
  }
}

async function collectBackupPayload() {
  const allExpenses = await getAllExpenses();
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: Date.now(),
    trips: state.trips,
    expenses: allExpenses,
    config: {
      categories: state.settings.categories,
      paymentMethods: state.settings.paymentMethods
    }
  };
}

function exportCsv() {
  const trip = activeTrip();
  if (!trip) {
    setStatus('No active trip selected.', 4000);
    return;
  }

  const columns = [
    'id',
    'tripId',
    'tripName',
    'dateTime',
    'category',
    'payment',
    'amountOriginal',
    'currency',
    'fxRateToBase',
    'amountBase',
    'baseCurrency',
    'note',
    'paidBy',
    'location',
    'tags',
    'createdAt',
    'updatedAt'
  ];

  const esc = (v) => {
    const s = String(v ?? '');
    if (s.includes('"') || s.includes(',') || s.includes('\n')) return `"${s.replaceAll('"', '""')}"`;
    return s;
  };

  const rows = state.expenses.map((exp) => [
    exp.id,
    exp.tripId,
    trip.name,
    exp.dateTime,
    exp.category,
    exp.payment,
    exp.amountOriginal,
    exp.currency,
    exp.fxRateToBase,
    exp.amountBase,
    trip.baseCurrency,
    exp.note || '',
    exp.paidBy || '',
    exp.location || '',
    (exp.tags || []).join(';'),
    exp.createdAt || '',
    exp.updatedAt || ''
  ]);

  const csv = [columns.join(','), ...rows.map((row) => row.map(esc).join(','))].join('\n');
  const filename = `travel_expenses_${sanitizeName(trip.name)}_${toInputDate(Date.now())}.csv`;
  downloadBlob(filename, csv, 'text/csv;charset=utf-8');
  setStatus('CSV exported.');
}

async function exportBackup() {
  const payload = await collectBackupPayload();
  const filename = `travel_expenses_backup_${toInputDate(Date.now())}.json`;
  downloadBlob(filename, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
  setStatus('Backup JSON exported.');
}

function parseRestoreFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(String(reader.result || '{}')));
      } catch (err) {
        reject(new Error('Invalid JSON file.'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsText(file);
  });
}

function handleRestoreFileChange(e) {
  const file = e.target.files?.[0];
  state.pendingRestore = null;
  els.restoreSummary.textContent = '';
  if (!file) return;

  parseRestoreFile(file)
    .then((payload) => {
      if (!Array.isArray(payload.trips) || !Array.isArray(payload.expenses)) {
        throw new Error('Backup must contain trips and expenses arrays.');
      }
      state.pendingRestore = payload;
      els.restoreSummary.textContent = `Trips: ${payload.trips.length}, Expenses: ${payload.expenses.length}, Schema: ${payload.schemaVersion || 'unknown'}`;
      setStatus('Backup file loaded. Review summary and confirm restore.', 5000);
    })
    .catch((err) => {
      setStatus(err.message || 'Failed to parse backup.', 5000);
    });
}

async function applyRestore() {
  if (!state.pendingRestore) {
    setStatus('Select a valid backup file first.', 4000);
    return;
  }

  const ok = window.confirm('This will overwrite existing data on this device. Continue?');
  if (!ok) return;

  await restoreBackup(state.pendingRestore);

  state.pendingRestore = null;
  els.restoreFile.value = '';
  els.restoreSummary.textContent = '';

  await loadAll();
  refreshUI();
  setStatus('Restore completed.');
}

function showTab(tabId) {
  const tabs = document.querySelectorAll('[data-tab-button]');
  const panels = document.querySelectorAll('[data-tab-panel]');

  tabs.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tabButton === tabId);
  });
  panels.forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.tabPanel !== tabId);
  });
  
  // Scroll to top when switching tabs
  window.scrollTo(0, 0);
}

function updateMonthSelector() {
  if (!els.monthLabel) return;
  
  if (!state.currentMonth) {
    els.monthLabel.textContent = 'All Time';
    return;
  }
  
  const [year, month] = state.currentMonth.split('-');
  const date = new Date(year, month - 1, 1);
  const monthName = date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  els.monthLabel.textContent = monthName;
}

function navigateMonth(direction) {
  const trip = activeTrip();
  if (!trip) return;
  
  if (!state.currentMonth) {
    // Start from trip start date
    state.currentMonth = trip.startDate.slice(0, 7);
  } else {
    const [year, month] = state.currentMonth.split('-').map(Number);
    const date = new Date(year, month - 1 + direction, 1);
    state.currentMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }
  
  // Set filters to current month
  const [year, month] = state.currentMonth.split('-').map(Number);
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  
  state.filters.startDate = toInputDate(firstDay);
  state.filters.endDate = toInputDate(lastDay);
  
  syncFilterInputs();
  updateMonthSelector();
  renderExpenseList();
  renderDashboard();
}

function toggleBudgetFields() {
  els.budgetFields.classList.toggle('hidden', !els.tripBudgetEnabled.checked);
}

function bindEvents() {
  els.activeTripSelect.addEventListener('change', async (e) => {
    state.activeTripId = e.target.value;
    if (state.activeTripId) localStorage.setItem('activeTripId', state.activeTripId);
    else localStorage.removeItem('activeTripId');
    await loadExpenses();
    state.filters.startDate = '';
    state.filters.endDate = '';
    refreshUI();
  });

  document.querySelectorAll('[data-tab-button]').forEach((btn) => {
    btn.addEventListener('click', () => showTab(btn.dataset.tabButton));
  });

  els.tripForm.addEventListener('submit', handleTripSubmit);
  els.tripFormReset.addEventListener('click', () => fillTripForm());
  els.tripList.addEventListener('click', handleTripListClick);
  els.tripBudgetEnabled.addEventListener('change', toggleBudgetFields);

  els.expenseForm.addEventListener('submit', handleExpenseSubmit);
  els.expenseFormReset.addEventListener('click', () => setExpenseDefaults());
  els.expenseList.addEventListener('click', handleExpenseListClick);

  els.expCurrency.addEventListener('change', () => {
    updateFxVisibility();
    updateAmountBasePreview();
  });
  els.expAmountOriginal.addEventListener('input', updateAmountBasePreview);
  els.expFx.addEventListener('input', updateAmountBasePreview);

  els.saveAndCloseToggle.addEventListener('change', (e) => {
    state.saveAndClose = e.target.checked;
  });

  els.filterStartDate.addEventListener('change', (e) => {
    state.filters.startDate = e.target.value;
    renderExpenseList();
    renderDashboard();
  });
  els.filterEndDate.addEventListener('change', (e) => {
    state.filters.endDate = e.target.value;
    renderExpenseList();
    renderDashboard();
  });
  els.filterCategory.addEventListener('change', (e) => {
    state.filters.category = e.target.value;
    renderExpenseList();
    renderDashboard();
  });
  els.filterPayment.addEventListener('change', (e) => {
    state.filters.payment = e.target.value;
    renderExpenseList();
    renderDashboard();
  });
  els.filterSearch.addEventListener('input', (e) => {
    state.filters.search = e.target.value;
    renderExpenseList();
    renderDashboard();
  });

  els.quickToday.addEventListener('click', () => applyQuickDateFilter('today'));
  els.quickTrip.addEventListener('click', () => applyQuickDateFilter('trip'));

  els.exportCsvBtn.addEventListener('click', exportCsv);
  els.exportBackupBtn.addEventListener('click', exportBackup);
  els.restoreFile.addEventListener('change', handleRestoreFileChange);
  els.restoreApplyBtn.addEventListener('click', applyRestore);

  els.settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const categories = els.settingsCategories.value
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean);
    const payments = els.settingsPayments.value
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean);

    if (!categories.length || !payments.length) {
      setStatus('Categories and payment methods must not be empty.', 4000);
      return;
    }

    await saveSettings({ categories, paymentMethods: payments });
    state.settings = await getSettings();
    renderFilterOptions();
    renderExpenseFormSelectors();
    setExpenseDefaults({ resetAmount: false });
    setStatus('Config lists updated.');
  });

  els.settingsResetBtn.addEventListener('click', async () => {
    await saveSettings({
      categories: [
        'Flights',
        'Lodging',
        'Local transport',
        'Food & drinks',
        'Attractions',
        'Shopping',
        'SIM/Internet',
        'Fees (ATM/baggage/etc.)',
        'Misc',
        'Souvenirs'
      ],
      paymentMethods: ['Cash', 'Wise', 'Apple Pay', 'Other']
    });
    state.settings = await getSettings();
    els.settingsCategories.value = state.settings.categories.join('\n');
    els.settingsPayments.value = state.settings.paymentMethods.join('\n');
    renderFilterOptions();
    renderExpenseFormSelectors();
    setExpenseDefaults({ resetAmount: false });
    setStatus('Config lists reset to defaults.');
  });
  
  // FAB to open Add Expense
  const fabBtn = document.getElementById('fabAddExpense');
  if (fabBtn) {
    fabBtn.addEventListener('click', () => {
      showTab('add-expense');
      setTimeout(() => els.expAmountOriginal.focus(), 100);
    });
  }
  
  // Month selector navigation
  const monthPrev = document.getElementById('monthPrev');
  const monthNext = document.getElementById('monthNext');
  if (monthPrev) monthPrev.addEventListener('click', () => navigateMonth(-1));
  if (monthNext) monthNext.addEventListener('click', () => navigateMonth(1));
}

function cacheEls() {
  els.status = document.getElementById('statusMessage');
  els.activeTripSelect = document.getElementById('activeTripSelect');
  els.activeTripSummary = document.getElementById('activeTripSummary');

  els.tripForm = document.getElementById('tripForm');
  els.tripFormTitle = document.getElementById('tripFormTitle');
  els.tripName = document.getElementById('tripName');
  els.tripStartDate = document.getElementById('tripStartDate');
  els.tripEndDate = document.getElementById('tripEndDate');
  els.tripBaseCurrency = document.getElementById('tripBaseCurrency');
  els.tripCurrencies = document.getElementById('tripCurrencies');
  els.tripBudgetEnabled = document.getElementById('tripBudgetEnabled');
  els.tripBudgetAmount = document.getElementById('tripBudgetAmount');
  els.tripDailyBudgetAmount = document.getElementById('tripDailyBudgetAmount');
  els.budgetFields = document.getElementById('budgetFields');
  els.tripFormReset = document.getElementById('tripFormReset');
  els.tripList = document.getElementById('tripList');

  els.noTripNotice = document.getElementById('noTripNotice');
  els.mainPanels = document.getElementById('mainPanels');

  els.expenseForm = document.getElementById('expenseForm');
  els.expenseFormTitle = document.getElementById('expenseFormTitle');
  els.expenseId = document.getElementById('expenseId');
  els.expDateTime = document.getElementById('expDateTime');
  els.expAmountOriginal = document.getElementById('expAmountOriginal');
  els.expCurrency = document.getElementById('expCurrency');
  els.expFx = document.getElementById('expFx');
  els.fxField = document.getElementById('fxField');
  els.expCategory = document.getElementById('expCategory');
  els.expPayment = document.getElementById('expPayment');
  els.expNote = document.getElementById('expNote');
  els.expPaidBy = document.getElementById('expPaidBy');
  els.expLocation = document.getElementById('expLocation');
  els.expTags = document.getElementById('expTags');
  els.amountBasePreview = document.getElementById('amountBasePreview');
  els.saveAndCloseToggle = document.getElementById('saveAndCloseToggle');
  els.expenseFormReset = document.getElementById('expenseFormReset');

  els.filterStartDate = document.getElementById('filterStartDate');
  els.filterEndDate = document.getElementById('filterEndDate');
  els.filterCategory = document.getElementById('filterCategory');
  els.filterPayment = document.getElementById('filterPayment');
  els.filterSearch = document.getElementById('filterSearch');
  els.quickToday = document.getElementById('quickToday');
  els.quickTrip = document.getElementById('quickTrip');
  els.expenseList = document.getElementById('expenseList');
  els.expenseCount = document.getElementById('expenseCount');

  els.totalSpent = document.getElementById('totalSpent');
  els.budgetPanel = document.getElementById('budgetPanel');
  els.categoryChart = document.getElementById('categoryChart');
  els.categoryTable = document.getElementById('categoryTable');
  els.dailyChart = document.getElementById('dailyChart');
  els.paymentChart = document.getElementById('paymentChart');
  els.paymentTable = document.getElementById('paymentTable');
  
  els.monthLabel = document.getElementById('monthLabel');
  els.monthPrev = document.getElementById('monthPrev');
  els.monthNext = document.getElementById('monthNext');

  els.exportCsvBtn = document.getElementById('exportCsvBtn');
  els.exportBackupBtn = document.getElementById('exportBackupBtn');
  els.restoreFile = document.getElementById('restoreFile');
  els.restoreSummary = document.getElementById('restoreSummary');
  els.restoreApplyBtn = document.getElementById('restoreApplyBtn');

  els.settingsForm = document.getElementById('settingsForm');
  els.settingsCategories = document.getElementById('settingsCategories');
  els.settingsPayments = document.getElementById('settingsPayments');
  els.settingsResetBtn = document.getElementById('settingsResetBtn');

  els.swUpdateBanner = document.getElementById('swUpdateBanner');
  els.applyUpdateBtn = document.getElementById('applyUpdateBtn');
}

function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.register('./sw.js').then((reg) => {
    let refreshing = false;

    const showUpdate = () => {
      if (!reg.waiting) return;
      els.swUpdateBanner.classList.remove('hidden');
      els.applyUpdateBtn.onclick = () => {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      };
    };

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });

    if (reg.waiting) showUpdate();

    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdate();
        }
      });
    });
  }).catch(() => {
    setStatus('Service worker registration failed.', 4000);
  });
}

async function main() {
  cacheEls();
  await initializeDb();
  await loadAll();

  els.settingsCategories.value = state.settings.categories.join('\n');
  els.settingsPayments.value = state.settings.paymentMethods.join('\n');

  fillTripForm();
  bindEvents();
  refreshUI();
  showTab('trips');

  const schemaVersion = await getSchemaVersion();
  document.getElementById('schemaVersionLabel').textContent = `Schema: ${schemaVersion}`;

  setupServiceWorker();
}

main().catch((err) => {
  console.error(err);
  const el = document.getElementById('statusMessage');
  if (el) el.textContent = `Startup error: ${err.message || err}`;
});
