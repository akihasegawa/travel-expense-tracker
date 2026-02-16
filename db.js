const DB_NAME = 'travel-expense-tracker';
const DB_VERSION = 1;

export const SCHEMA_VERSION = '1.0.0';

const DEFAULT_SETTINGS = {
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
};

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

export async function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('trips')) {
        db.createObjectStore('trips', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('expenses')) {
        const exp = db.createObjectStore('expenses', { keyPath: 'id' });
        exp.createIndex('tripId', 'tripId', { unique: false });
        exp.createIndex('tripId_dateTime', ['tripId', 'dateTime'], { unique: false });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open database'));
  });
}

export async function initializeDb() {
  const db = await openDb();
  const tx = db.transaction(['meta', 'settings'], 'readwrite');

  const metaStore = tx.objectStore('meta');
  const settingsStore = tx.objectStore('settings');

  const schema = await reqToPromise(metaStore.get('schemaVersion'));
  if (!schema) {
    metaStore.put({ key: 'schemaVersion', value: SCHEMA_VERSION });
  }

  const categories = await reqToPromise(settingsStore.get('categories'));
  if (!categories) {
    settingsStore.put({ key: 'categories', value: DEFAULT_SETTINGS.categories.slice() });
  }

  const payments = await reqToPromise(settingsStore.get('paymentMethods'));
  if (!payments) {
    settingsStore.put({ key: 'paymentMethods', value: DEFAULT_SETTINGS.paymentMethods.slice() });
  }

  await txDone(tx);
  db.close();
}

async function runTx(storeNames, mode, handler) {
  const db = await openDb();
  const tx = db.transaction(storeNames, mode);
  const result = await handler(tx);
  await txDone(tx);
  db.close();
  return result;
}

export async function getSchemaVersion() {
  return runTx(['meta'], 'readonly', async (tx) => {
    const row = await reqToPromise(tx.objectStore('meta').get('schemaVersion'));
    return row ? row.value : SCHEMA_VERSION;
  });
}

export async function getSettings() {
  return runTx(['settings'], 'readonly', async (tx) => {
    const store = tx.objectStore('settings');
    const categories = await reqToPromise(store.get('categories'));
    const paymentMethods = await reqToPromise(store.get('paymentMethods'));
    return {
      categories: categories?.value || DEFAULT_SETTINGS.categories.slice(),
      paymentMethods: paymentMethods?.value || DEFAULT_SETTINGS.paymentMethods.slice()
    };
  });
}

export async function saveSettings(settings) {
  return runTx(['settings'], 'readwrite', async (tx) => {
    const store = tx.objectStore('settings');
    store.put({ key: 'categories', value: settings.categories.slice() });
    store.put({ key: 'paymentMethods', value: settings.paymentMethods.slice() });
  });
}

export async function getTrips() {
  return runTx(['trips'], 'readonly', async (tx) => {
    return reqToPromise(tx.objectStore('trips').getAll());
  });
}

export async function getTripById(id) {
  return runTx(['trips'], 'readonly', async (tx) => {
    return reqToPromise(tx.objectStore('trips').get(id));
  });
}

export async function upsertTrip(trip) {
  return runTx(['trips'], 'readwrite', async (tx) => {
    tx.objectStore('trips').put(trip);
  });
}

export async function deleteTripCascade(tripId) {
  return runTx(['trips', 'expenses'], 'readwrite', async (tx) => {
    tx.objectStore('trips').delete(tripId);

    const index = tx.objectStore('expenses').index('tripId');
    const request = index.openCursor(IDBKeyRange.only(tripId));

    await new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        cursor.delete();
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error('Failed to delete trip expenses'));
    });
  });
}

export async function getExpensesByTrip(tripId) {
  return runTx(['expenses'], 'readonly', async (tx) => {
    const index = tx.objectStore('expenses').index('tripId');
    return reqToPromise(index.getAll(IDBKeyRange.only(tripId)));
  });
}

export async function getAllExpenses() {
  return runTx(['expenses'], 'readonly', async (tx) => {
    return reqToPromise(tx.objectStore('expenses').getAll());
  });
}

export async function getExpenseById(id) {
  return runTx(['expenses'], 'readonly', async (tx) => {
    return reqToPromise(tx.objectStore('expenses').get(id));
  });
}

export async function upsertExpense(expense) {
  return runTx(['expenses'], 'readwrite', async (tx) => {
    tx.objectStore('expenses').put(expense);
  });
}

export async function deleteExpense(id) {
  return runTx(['expenses'], 'readwrite', async (tx) => {
    tx.objectStore('expenses').delete(id);
  });
}

export async function clearAllData() {
  return runTx(['trips', 'expenses', 'meta', 'settings'], 'readwrite', async (tx) => {
    tx.objectStore('trips').clear();
    tx.objectStore('expenses').clear();
    tx.objectStore('meta').clear();
    tx.objectStore('settings').clear();

    tx.objectStore('meta').put({ key: 'schemaVersion', value: SCHEMA_VERSION });
    tx.objectStore('settings').put({ key: 'categories', value: DEFAULT_SETTINGS.categories.slice() });
    tx.objectStore('settings').put({ key: 'paymentMethods', value: DEFAULT_SETTINGS.paymentMethods.slice() });
  });
}

export async function restoreBackup(payload) {
  return runTx(['trips', 'expenses', 'meta', 'settings'], 'readwrite', async (tx) => {
    tx.objectStore('trips').clear();
    tx.objectStore('expenses').clear();
    tx.objectStore('meta').clear();
    tx.objectStore('settings').clear();

    tx.objectStore('meta').put({ key: 'schemaVersion', value: payload.schemaVersion || SCHEMA_VERSION });

    const categories = payload.config?.categories || DEFAULT_SETTINGS.categories.slice();
    const payments = payload.config?.paymentMethods || DEFAULT_SETTINGS.paymentMethods.slice();

    tx.objectStore('settings').put({ key: 'categories', value: categories });
    tx.objectStore('settings').put({ key: 'paymentMethods', value: payments });

    for (const trip of payload.trips || []) {
      tx.objectStore('trips').put(trip);
    }

    for (const expense of payload.expenses || []) {
      tx.objectStore('expenses').put(expense);
    }
  });
}

export { DEFAULT_SETTINGS };
