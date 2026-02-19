const express = require('express');
const path    = require('path');
const { google } = require('googleapis');
const { Pool }   = require('pg');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ── CONFIG ──────────────────────────────────────────────────────────────────
const PROJECT_ID   = process.env.FIREBASE_PROJECT_ID   || 'codebysam123';
const GROUP_ALIAS  = process.env.FIREBASE_GROUP_ALIAS  || 'home';
const MAX_TESTERS  = parseInt(process.env.MAX_TESTERS  || '199');
const DAILY_DELETE = parseInt(process.env.DAILY_DELETE || '100');

let SERVICE_ACCOUNT = {};
try {
  SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
} catch (e) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT JSON parse failed:', e.message);
}

// ── POSTGRES ─────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS testers (
      id       SERIAL PRIMARY KEY,
      email    TEXT UNIQUE NOT NULL,
      added_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cleanup_log (
      id           SERIAL PRIMARY KEY,
      cleaned_date DATE UNIQUE NOT NULL,
      deleted_count INT DEFAULT 0
    );
  `);
  console.log('✅ Database ready');
}

// ── FIREBASE AUTH ─────────────────────────────────────────────────────────────
async function getAccessToken() {
  const auth = new google.auth.GoogleAuth({
    credentials: SERVICE_ACCOUNT,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const res    = await client.getAccessToken();
  return res.token;
}

// ── FIREBASE API CALLS ────────────────────────────────────────────────────────
async function addTesterToFirebase(email) {
  const token = await getAccessToken();

  // Step 1: Project mein tester create karo
  const batchAddUrl = `https://firebaseappdistribution.googleapis.com/v1/projects/${PROJECT_ID}/testers:batchAdd`;
  const batchAddRes = await fetch(batchAddUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ emails: [email] }),
  });

  const batchAddText = await batchAddRes.text();
  console.log(`batchAdd [${batchAddRes.status}]:`, batchAddText);

  if (!batchAddRes.ok) {
    throw new Error(`batchAdd failed ${batchAddRes.status}: ${batchAddText}`);
  }

  // Step 2: Group mein add karo
  const joinUrl = `https://firebaseappdistribution.googleapis.com/v1/projects/${PROJECT_ID}/groups/${GROUP_ALIAS}:batchJoin`;
  const joinRes = await fetch(joinUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ emails: [email] }),
  });

  const joinText = await joinRes.text();
  console.log(`batchJoin [${joinRes.status}]:`, joinText);
}

async function removeTesterFromFirebase(email) {
  const token = await getAccessToken();

  const leaveUrl = `https://firebaseappdistribution.googleapis.com/v1/projects/${PROJECT_ID}/groups/${GROUP_ALIAS}:batchLeave`;
  await fetch(leaveUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ emails: [email] }),
  });

  const deleteUrl = `https://firebaseappdistribution.googleapis.com/v1/projects/${PROJECT_ID}/testers:batchDelete`;
  await fetch(deleteUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ emails: [email] }),
  });
}

// ── DAILY CLEANUP ─────────────────────────────────────────────────────────────
async function performDailyCleanup() {
  const today = new Date().toISOString().split('T')[0];
  const { rows } = await pool.query('SELECT id FROM cleanup_log WHERE cleaned_date = $1', [today]);
  if (rows.length > 0) return;

  const { rows: oldest } = await pool.query(
    'SELECT email FROM testers ORDER BY added_at ASC LIMIT $1', [DAILY_DELETE]
  );

  if (oldest.length === 0) {
    await pool.query('INSERT INTO cleanup_log (cleaned_date, deleted_count) VALUES ($1, 0) ON CONFLICT DO NOTHING', [today]);
    return;
  }

  let deleted = 0;
  for (const { email } of oldest) {
    try {
      await removeTesterFromFirebase(email);
      await pool.query('DELETE FROM testers WHERE email = $1', [email]);
      deleted++;
    } catch (e) {
      console.error('Cleanup error:', email, e.message);
    }
  }

  await pool.query(
    'INSERT INTO cleanup_log (cleaned_date, deleted_count) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [today, deleted]
  );
  console.log(`🧹 Daily cleanup: ${deleted} removed`);
}

// ── API: ADD TESTER ───────────────────────────────────────────────────────────
app.post('/api/add-tester', async (req, res) => {
  const { email } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.json({ success: false, message: 'Sahi email address daalo.' });
  }

  const cleanEmail = email.trim().toLowerCase();

  try {
    await performDailyCleanup();

    const existing = await pool.query('SELECT id FROM testers WHERE email = $1', [cleanEmail]);
    if (existing.rows.length > 0) {
      return res.json({ success: false, message: 'Ye email pehle se beta tester hai! App download karo.' });
    }

    const { rows: countRows } = await pool.query('SELECT COUNT(*) as cnt FROM testers');
    let count = parseInt(countRows[0].cnt);

    while (count >= MAX_TESTERS) {
      const { rows: oldest } = await pool.query('SELECT email FROM testers ORDER BY added_at ASC LIMIT 1');
      if (!oldest.length) break;
      try {
        await removeTesterFromFirebase(oldest[0].email);
        await pool.query('DELETE FROM testers WHERE email = $1', [oldest[0].email]);
        count--;
      } catch (e) {
        console.error('Max limit remove error:', e.message);
        break;
      }
    }

    await addTesterToFirebase(cleanEmail);
    await pool.query('INSERT INTO testers (email) VALUES ($1)', [cleanEmail]);

    res.json({ success: true, message: 'Beta access mil gaya! Ab app download karo. 🎉' });

  } catch (err) {
    console.error('Add tester error:', err.message);
    res.json({ success: false, message: 'Error: ' + err.message });
  }
});

// ── API: STATS ────────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  const { rows }       = await pool.query('SELECT COUNT(*) as total FROM testers');
  const { rows: logs } = await pool.query('SELECT * FROM cleanup_log ORDER BY cleaned_date DESC LIMIT 7');
  res.json({ total: parseInt(rows[0].total), max: MAX_TESTERS, recentCleanups: logs });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => console.log(`🚀 Live on port ${PORT}`)))
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });
