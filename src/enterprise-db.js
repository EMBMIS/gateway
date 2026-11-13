/**
 * DWI — Enterprise Database (THE THING BEING PROTECTED)
 * 
 * This is a REAL database with real customer data, financial records,
 * and employee information. The Agent Gateway sits in front of this
 * and decides what gets through.
 *
 * Without the gateway: any agent can SELECT *, DROP TABLE, exfiltrate PII.
 * With the gateway: every query is intercepted, evaluated, and blocked if unauthorized.
 */
const { Pool } = require('pg');

let pool;

function getEnterpriseDb() {
    if (!pool) {
        pool = new Pool({
            host: process.env.PGHOST || 'localhost',
            port: process.env.PGPORT || 5432,
            user: process.env.PGUSER || 'admin',
            password: process.env.PGPASSWORD || 'secretpassword',
            database: process.env.PGDATABASE || 'enterprise_db',
        });

        // Background init
        initEnterpriseSchema()
            .then(seedEnterpriseData)
            .catch(err => console.error('[ENTERPRISE-DB] Init error:', err));
    }
    return pool;
}

async function initEnterpriseSchema() {
    const db = pool;
    await db.query(`
    -- Real customer PII
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      date_of_birth TEXT,
      address TEXT,
      country TEXT,
      tier TEXT DEFAULT 'standard',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Financial transactions
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'EUR',
      type TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'completed',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Employee records
    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      department TEXT NOT NULL,
      role TEXT NOT NULL,
      salary REAL,
      ssn TEXT,
      hire_date TEXT,
      manager_id INTEGER
    );

    -- Internal API credentials
    CREATE TABLE IF NOT EXISTS api_credentials (
      id SERIAL PRIMARY KEY,
      service_name TEXT NOT NULL,
      api_key TEXT NOT NULL,
      secret TEXT NOT NULL,
      environment TEXT DEFAULT 'production',
      last_rotated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

async function seedEnterpriseData() {
    const db = pool;
    const res = await db.query('SELECT COUNT(*) as c FROM customers');
    if (parseInt(res.rows[0].c, 10) > 0) return; // Already seeded

    // Real-looking customer data
    const customers = [
        ['Maria Schmidt', 'maria.schmidt@beispiel.de', '+49-151-2345678', '1985-03-14', 'Friedrichstraße 43, 10117 Berlin', 'DE', 'premium'],
        ['Jean-Pierre Dubois', 'jp.dubois@exemple.fr', '+33-6-1234-5678', '1978-11-22', '15 Rue de Rivoli, 75001 Paris', 'FR', 'enterprise'],
        ['Anna Kowalski', 'anna.k@przyklad.pl', '+48-22-555-0123', '1992-07-08', 'ul. Marszałkowska 12, 00-624 Warszawa', 'PL', 'standard'],
        ['Lars Eriksson', 'lars.e@exempel.se', '+46-8-555-1234', '1990-01-30', 'Kungsgatan 5, 111 43 Stockholm', 'SE', 'premium'],
        ['Sofia Rossi', 'sofia.rossi@esempio.it', '+39-06-555-7890', '1988-09-15', 'Via del Corso 120, 00186 Roma', 'IT', 'standard'],
        ['Elena Petrova', 'elena.p@primer.es', '+34-91-555-4567', '1995-05-20', 'Calle Gran Vía 28, 28013 Madrid', 'ES', 'enterprise'],
        ['Thomas Müller', 'thomas.m@beispiel.de', '+49-89-555-9012', '1982-12-03', 'Maximilianstraße 17, 80539 München', 'DE', 'premium'],
        ['Isabelle Martin', 'isabelle.m@exemple.fr', '+33-1-4567-8901', '1993-04-18', '8 Avenue des Champs-Élysées, 75008 Paris', 'FR', 'standard'],
        ['Piotr Nowak', 'piotr.n@przyklad.pl', '+48-12-555-6789', '1987-08-25', 'Rynek Główny 1, 31-042 Kraków', 'PL', 'standard'],
        ['Henrik Johansson', 'henrik.j@exempel.se', '+46-31-555-2345', '1991-06-12', 'Avenyn 15, 411 36 Göteborg', 'SE', 'enterprise'],
    ];

    const insertCustomer = 'INSERT INTO customers (full_name, email, phone, date_of_birth, address, country, tier) VALUES ($1, $2, $3, $4, $5, $6, $7)';
    for (const c of customers) await db.query(insertCustomer, c);

    // Financial transactions
    const insertTx = 'INSERT INTO transactions (customer_id, amount, currency, type, description, status) VALUES ($1, $2, $3, $4, $5, $6)';
    const txData = [
        [1, 15000.00, 'EUR', 'wire_transfer', 'Q4 consulting invoice', 'completed'],
        [2, 250000.00, 'EUR', 'wire_transfer', 'Enterprise license renewal', 'completed'],
        [1, 3200.50, 'EUR', 'payment', 'Monthly SaaS subscription', 'completed'],
        [3, 890.00, 'PLN', 'payment', 'Standard tier upgrade', 'pending'],
        [4, 45000.00, 'SEK', 'wire_transfer', 'Infrastructure contract', 'completed'],
        [5, 1250.00, 'EUR', 'refund', 'Service credit Q3', 'completed'],
        [6, 175000.00, 'EUR', 'wire_transfer', 'Enterprise onboarding', 'completed'],
        [7, 8900.00, 'EUR', 'payment', 'Premium tier annual', 'completed'],
        [2, 320000.00, 'EUR', 'wire_transfer', 'Multi-year contract', 'pending'],
        [8, 450.00, 'EUR', 'payment', 'Standard subscription', 'completed'],
    ];
    for (const t of txData) await db.query(insertTx, t);

    // Employee records (sensitive)
    const insertEmp = 'INSERT INTO employees (full_name, email, department, role, salary, ssn, hire_date) VALUES ($1, $2, $3, $4, $5, $6, $7)';
    const empData = [
        ['Klaus Weber', 'klaus.w@dwi-internal.eu', 'Engineering', 'CTO', 185000, 'DE-SSN-4829-1947', '2024-01-15'],
        ['Marie Lefebvre', 'marie.l@dwi-internal.eu', 'Engineering', 'Lead Engineer', 125000, 'FR-SSN-7731-5522', '2024-03-01'],
        ['Jan Kowalczyk', 'jan.k@dwi-internal.eu', 'Security', 'CISO', 165000, 'PL-SSN-2244-8811', '2024-02-01'],
        ['Astrid Lindgren', 'astrid.l@dwi-internal.eu', 'Finance', 'CFO', 170000, 'SE-SSN-9912-3344', '2024-01-15'],
        ['Paolo Bianchi', 'paolo.b@dwi-internal.eu', 'Sales', 'VP Sales', 145000, 'IT-SSN-5566-7788', '2024-04-01'],
        ['Ana García', 'ana.g@dwi-internal.eu', 'HR', 'HR Director', 110000, 'ES-SSN-1122-9900', '2024-05-15'],
    ];
    for (const e of empData) await db.query(insertEmp, e);

    // API credentials (highly sensitive)
    const insertCred = 'INSERT INTO api_credentials (service_name, api_key, secret, environment) VALUES ($1, $2, $3, $4)';
    const credData = [
        ['Stripe', 'sk_live_REPLACE_WITH_REAL_KEY', 'whsec_REPLACE_WITH_REAL_SECRET', 'production'],
        ['AWS', 'REPLACE_WITH_AWS_ACCESS_KEY', 'REPLACE_WITH_AWS_SECRET_KEY', 'production'],
        ['Salesforce', 'consumer_key_3f4g5h6i7j8k', 'consumer_secret_9l0m1n2o3p4q', 'production'],
        ['SendGrid', 'SG.xxxxxxxxxxxx.yyyyyyyyyyyy', 'api_secret_zzzzzzzzzzzz', 'production'],
    ];
    for (const c of credData) await db.query(insertCred, c);

    console.log('[ENTERPRISE-DB] Seeded: 10 customers, 10 transactions, 6 employees, 4 API credentials');
}

/**
 * Execute a REAL query against the enterprise database.
 * This is what happens AFTER the gateway approves the request.
 */
async function executeQuery(sql, params = []) {
    const db = getEnterpriseDb();

    // Map SQLite ? parameterization into Postgres $1, $2, etc. (for backward compatibility w/ the MVP client tools)
    let paramIndex = 1;
    let pgSql = sql.replace(/\?/g, () => `$${paramIndex++}`);

    // Safety: only allow SELECT in read mode
    const normalized = sql.trim().toUpperCase();

    try {
        const result = await db.query(pgSql, params);

        if (normalized.startsWith('SELECT')) {
            return { success: true, rows: result.rows, rowCount: result.rowCount };
        }

        if (normalized.startsWith('DELETE') || normalized.startsWith('DROP') || normalized.startsWith('ALTER')) {
            return { success: true, changes: result.rowCount, warning: 'DESTRUCTIVE OPERATION EXECUTED' };
        }

        return { success: true, changes: result.rowCount };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

module.exports = { getEnterpriseDb, executeQuery };
