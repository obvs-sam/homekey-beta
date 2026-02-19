const express = require('express');
const path = require('path');
const { google } = require('googleapis');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ── CONFIG ──────────────────────────────────────────────
const PROJECT_ID   = process.env.FIREBASE_PROJECT_ID   || 'codebysam123';
const GROUP_ALIAS  = process.env.FIREBASE_GROUP_ALIAS  || 'home';
const MAX_TESTERS  = parseInt(process.env.MAX_TESTERS  || '199');
const DAILY_DELETE = parseInt(process.env.DAILY_DELETE || '100');

// Firebase service account from environment variable (JSON string)
const SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');

// PostgreSQL connection (Railway sets DATABASE_URL automatically)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ── DATABASE SETUP ───────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS testers (
      id         SERIAL PRIMARY KEY,
      email      TEXT UNIQUE NOT NULL,
      added_at   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cleanup_log (
      id           SERIAL PRIMARY KEY,
      cleaned_date DATE UNIQUE NOT NULL,
      deleted_count INT DEFAULT 0
    );
  `);
  console.log('✅ Database ready');
}

// ── FIREBASE HELPERS ─────────────────────────────────────
async function getAccessToken() {
  const auth = new google.auth.GoogleAuth({
    credentials: SERVICE_ACCOUNT,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const token  = await client.getAccessToken();
  return token.token;
}

async function addTesterToFirebase(email) {
  const token = await getAccessToken();
  const url   = `https://firebaseappdistribution.googleapis.com/v1/projects/${PROJECT_ID}/groups/${GROUP_ALIAS}:batchJoin`;
  const res   = await fetch(url, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ emails: [email], createMissingTesters: true }),
  });
  if (!res.ok) throw new Error(await res.text());
}

async function removeTesterFromFirebase(email) {
  const token = await getAccessToken();
  const url   = `https://firebaseappdistribution.googleapis.com/v1/projects/${PROJECT_ID}/groups/${GROUP_ALIAS}:batchLeave`;
  const res   = await fetch(url, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ emails: [email] }),
  });
  if (!res.ok) throw new Error(await res.text());
}

// ── DAILY CLEANUP ────────────────────────────────────────
// Runs once per day: deletes oldest 100 testers
async function performDailyCleanup() {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  // Already cleaned today?
  const { rows } = await pool.query(
    'SELECT id FROM cleanup_log WHERE cleaned_date = $1', [today]
  );
  if (rows.length > 0) return;

  // Get oldest 100
  const { rows: oldest } = await pool.query(
    'SELECT email FROM testers ORDER BY added_at ASC LIMIT $1', [DAILY_DELETE]
  );
  if (oldest.length === 0) {
    await pool.query('INSERT INTO cleanup_log (cleaned_date, deleted_count) VALUES ($1, 0) ON CONFLICT DO NOTHING', [today]);
    return;
  }

  const emails = oldest.map(r => r.email);
  let deleted  = 0;

  for (const email of emails) {
    try {
      await removeTesterFromFirebase(email);
      await pool.query('DELETE FROM testers WHERE email = $1', [email]);
      deleted++;
    } catch (e) {
      console.error('Cleanup error for', email, e.message);
    }
  }

  await pool.query(
    'INSERT INTO cleanup_log (cleaned_date, deleted_count) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [today, deleted]
  );
  console.log(`🧹 Daily cleanup: removed ${deleted} testers`);
}

// ── API: ADD TESTER ──────────────────────────────────────
app.post('/api/add-tester', async (req, res) => {
  const { email } = req.body;

  // Validate
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.json({ success: false, message: 'Sahi email address daalo.' });
  }
  const cleanEmail = email.trim().toLowerCase();

  try {
    // Daily cleanup (once per day)
    await performDailyCleanup();

    // Already a tester?
    const existing = await pool.query('SELECT id FROM testers WHERE email = $1', [cleanEmail]);
    if (existing.rows.length > 0) {
      return res.json({ success: false, message: 'Ye email pehle se beta tester hai!' });
    }

    // Count current testers
    const { rows: countRows } = await pool.query('SELECT COUNT(*) as cnt FROM testers');
    let count = parseInt(countRows[0].cnt);

    // Remove oldest if at max
    while (count >= MAX_TESTERS) {
      const { rows: oldest } = await pool.query(
        'SELECT email FROM testers ORDER BY added_at ASC LIMIT 1'
      );
      if (oldest.length === 0) break;
      try {
        await removeTesterFromFirebase(oldest[0].email);
        await pool.query('DELETE FROM testers WHERE email = $1', [oldest[0].email]);
        count--;
      } catch (e) {
        console.error('Remove error:', e.message);
        break;
      }
    }

    // Add to Firebase
    await addTesterToFirebase(cleanEmail);

    // Save to DB
    await pool.query('INSERT INTO testers (email) VALUES ($1)', [cleanEmail]);

    res.json({ success: true, message: 'Beta access mil gaya! Ab app download karo.' });

  } catch (err) {
    console.error('Add tester error:', err.message);
    res.json({ success: false, message: 'Kuch gadbad hui. Dobara try karo.' });
  }
});

// ── API: STATS (optional admin check) ───────────────────
app.get('/api/stats', async (req, res) => {
  const { rows } = await pool.query('SELECT COUNT(*) as total FROM testers');
  const { rows: logs } = await pool.query('SELECT * FROM cleanup_log ORDER BY cleaned_date DESC LIMIT 7');
  res.json({ total: parseInt(rows[0].total), max: MAX_TESTERS, recentCleanups: logs });
});

// ── SERVE FRONTEND ───────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── START ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server live on http://localhost:${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
