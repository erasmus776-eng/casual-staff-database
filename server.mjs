import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import XLSX from 'xlsx';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { getIronSession } from 'iron-session';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { Pool } = pg;

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === 'production';
const sessionPassword = process.env.SESSION_PASSWORD;

if (!sessionPassword || sessionPassword.length < 32) {
  console.error('SESSION_PASSWORD must be at least 32 characters long.');
  process.exit(1);
}

const dataDir = path.join(__dirname, 'data');
await fs.mkdir(dataDir, { recursive: true });

const recordsPath = path.join(dataDir, 'records.json');
const usersPath = path.join(dataDir, 'users.json');

async function ensureJsonFile(filePath, defaultValue) {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(
      filePath,
      JSON.stringify(defaultValue, null, 2) + '\n'
    );
  }
}

await ensureJsonFile(recordsPath, []);
await ensureJsonFile(usersPath, []);

const records = JSON.parse(
  await fs.readFile(recordsPath, 'utf8')
);

const users = JSON.parse(
  await fs.readFile(usersPath, 'utf8')
);


if (
  isProd &&
  process.env.ADMIN_USERNAME &&
  process.env.ADMIN_PASSWORD
) {
  const existingAdmin = users.find(
    u => u.username.toLowerCase() === process.env.ADMIN_USERNAME.toLowerCase()
  );

  if (!existingAdmin) {
    const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);

    users.push({
      username: process.env.ADMIN_USERNAME,
      passwordHash,
      role: 'admin'
    });
  }
}

if (
  isProd &&
  process.env.VIEWER_USERNAME &&
  process.env.VIEWER_PASSWORD
) {
  const existingViewer = users.find(
    u => u.username.toLowerCase() === process.env.VIEWER_USERNAME.toLowerCase()
  );

  if (!existingViewer) {
    const passwordHash = await bcrypt.hash(process.env.VIEWER_PASSWORD, 12);

    users.push({
      username: process.env.VIEWER_USERNAME,
      passwordHash,
      role: 'viewer'
    });
  }
}

if (isProd) {
  await fs.writeFile(
    usersPath,
    JSON.stringify(users, null, 2) + '\n'
  );
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'"],
      scriptSrc: ["'self'"],
      formAction: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  referrerPolicy: { policy: 'no-referrer' }
}));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.json({ limit: '10mb' }));

const sessionOptions = {
  password: sessionPassword,
  cookieName: 'rivers_staff_session',
  ttl: 60 * 60 * 8,
  cookieOptions: {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: 60 * 60 * 8,
    path: '/'
  }
};

async function sessionFor(req, res) {
  return getIronSession(req, res, sessionOptions);
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: 'Too many login attempts. Please wait and try again.'
});

async function requireLogin(req, res, next) {
  const session = await sessionFor(req, res);
  if (!session.user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    return res.redirect('/');
  }
  req.user = session.user;
  next();
}

app.get('/', async (req, res) => {
  const session = await sessionFor(req, res);
  if (session.user) return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', loginLimiter, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());

  const ok = user ? await bcrypt.compare(password, user.passwordHash) : false;
  if (!ok) {
    return res.redirect('/?error=' + encodeURIComponent('Invalid username or password.'));
  }

  const session = await sessionFor(req, res);
  session.user = { username: user.username, role: user.role || 'viewer' };
  await session.save();
  res.redirect('/');
});

app.post('/logout', async (req, res) => {
  const session = await sessionFor(req, res);
  session.destroy();
  res.redirect('/');
});

app.get('/api/me', requireLogin, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

app.get('/api/search', requireLogin, async (req, res) => {
  const q = String(req.query.q || '').trim();

  if (!q) {
    return res.json({ records: [], count: 0 });
  }

  if (q.length > 100) {
    return res.status(400).json({ error: 'Search text is too long.' });
  }

  try {
    const search = `%${q}%`;

    const result = await db.query(
      `SELECT id, sno, ministry, name, qualification, lga, phone, created_at
       FROM staff_records
       WHERE
         name ILIKE $1
         OR lga ILIKE $1
         OR phone ILIKE $1
         OR qualification ILIKE $1
         OR ministry ILIKE $1
       ORDER BY id
       LIMIT 50`,
      [search]
    );

    res.set('Cache-Control', 'no-store');
    res.json({
      records: result.rows,
      count: result.rows.length
    });

  } catch (error) {
    console.error('Supabase search error:', error);
    res.status(500).json({
      error: 'Database search failed.'
    });
  }
});


app.post('/api/records', requireLogin, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const name = String(req.body.name || '').trim();
  const ministry = String(req.body.ministry || '').trim();
  const qualification = String(req.body.qualification || '').trim();
  const lga = String(req.body.lga || '').trim();
  const phone = String(req.body.phone || '').trim();

  if (!name || !ministry || !qualification || !lga || !phone) {
    return res.status(400).json({
      error: 'All staff fields are required.'
    });
  }

  if (
    name.length > 150 ||
    ministry.length > 150 ||
    qualification.length > 100 ||
    lga.length > 100 ||
    phone.length > 30
  ) {
    return res.status(400).json({
      error: 'One or more fields are too long.'
    });
  }

  try {
    const result = await db.query(
      `INSERT INTO staff_records
       (sno, ministry, name, qualification, lga, phone)
       VALUES (
         (SELECT COALESCE(MAX(CAST(NULLIF(sno, '') AS BIGINT)), 0) + 1
          FROM staff_records
          WHERE ministry = $1
          AND sno ~ '^[0-9]+$'),
                  $2, $3, $4, $5, $6
       )
       RETURNING id, sno, ministry, name, qualification, lga, phone, created_at`,
            [
        ministry,
        ministry,
        name,
        qualification,
        lga,
        phone
      ]
    );

    res.status(201).json({
      message: 'Staff record added successfully.',
      record: result.rows[0]
    });

  } catch (error) {
    console.error('Supabase add record error:', error);

    res.status(500).json({
      error: 'Failed to add staff record to the database.'
    });
  }
});


app.post('/api/import-excel', requireLogin, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      error: 'Admin access required.'
    });
  }

  try {
    const workbook = XLSX.read(req.body.file, { type: 'base64' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: '',
      raw: false
    });

    if (!rows.length) {
      return res.status(400).json({
        error: 'The Excel sheet is empty.'
      });
    }

    const headerIndex = rows.findIndex(row => {
      const headers = row.map(v => String(v).trim().toUpperCase());

      return (
        headers.includes('MINISTRY') &&
        headers.includes('S/NO.') &&
        headers.includes('NAMES') &&
        headers.includes('QUALIFICATION') &&
        headers.includes('L.G.A.') &&
        headers.includes('PHONE NO.')
      );
    });

    if (headerIndex === -1) {
      return res.status(400).json({
        error: 'Could not find the staff column headings in the Excel file.'
      });
    }

    const headers = rows[headerIndex].map(v =>
      String(v).trim().toUpperCase()
    );

    const ministryIndex = headers.indexOf('MINISTRY');
    const nameIndex = headers.indexOf('NAMES');
    const qualificationIndex = headers.indexOf('QUALIFICATION');
    const lgaIndex = headers.indexOf('L.G.A.');
    const phoneIndex = headers.indexOf('PHONE NO.');

    const imported = [];

    for (let i = headerIndex + 1; i < rows.length; i++) {
      const row = rows[i];

      const ministry = String(row[ministryIndex] || '').trim();
      const name = String(row[nameIndex] || '').trim();
      const qualification = String(row[qualificationIndex] || '').trim();
      const lga = String(row[lgaIndex] || '').trim();
      const phone = String(row[phoneIndex] || '').trim();

      if (!ministry || !name || !qualification || !lga || !phone) {
        continue;
      }

      imported.push({
        ministry,
        name,
        qualification,
        lga,
        phone
      });
    }

    if (!imported.length) {
      return res.status(400).json({
        error: 'No valid staff records were found.'
      });
    }

    const existingResult = await db.query(
      `SELECT name, ministry, qualification, lga, phone
       FROM staff_records`
    );

    const existingKeys = new Set(
      existingResult.rows.map(r =>
        [
          r.name,
          r.ministry,
          r.qualification,
          r.lga,
          r.phone
        ]
          .map(v => String(v || '').trim().toLowerCase())
          .join('|')
      )
    );

    const nextSnoByMinistry = new Map();

    let importedCount = 0;
    let duplicateCount = 0;

        for (const record of imported) {
      const key = [
        record.name,
        record.ministry,
        record.qualification,
        record.lga,
        record.phone
      ]
        .map(v => String(v || '').trim().toLowerCase())
        .join('|');

      if (existingKeys.has(key)) {
        duplicateCount++;
        continue;
      }

      let nextSno = nextSnoByMinistry.get(record.ministry);

      if (nextSno === undefined) {
        const maxSnoResult = await db.query(
          `SELECT COALESCE(MAX(CAST(NULLIF(sno, '') AS BIGINT)), 0) AS max_sno
           FROM staff_records
           WHERE ministry = $1
           AND sno ~ '^[0-9]+$'`,
          [record.ministry]
        );

        nextSno = Number(maxSnoResult.rows[0].max_sno) + 1;
      }

      await db.query(
        `INSERT INTO staff_records
         (sno, ministry, name, qualification, lga, phone)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          String(nextSno),
          record.ministry,
          record.name,
          record.qualification,
          record.lga,
          record.phone
        ]
      );

      nextSnoByMinistry.set(record.ministry, nextSno + 1);

      existingKeys.add(key);
      importedCount++;
    }
    

    res.json({
      message: 'Excel import completed successfully.',
      imported: importedCount,
      duplicatesSkipped: duplicateCount
    });

  } catch (err) {
    console.error('Supabase Excel import error:', err);

    res.status(400).json({
      error: 'Could not import the Excel file.'
    });
  }
});
app.put('/api/records/:id', requireLogin, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({
      error: 'Invalid staff record ID.'
    });
  }

  const name = String(req.body.name || '').trim();
  const ministry = String(req.body.ministry || '').trim();
  const qualification = String(req.body.qualification || '').trim();
  const lga = String(req.body.lga || '').trim();
  const phone = String(req.body.phone || '').trim();

  if (!name || !ministry || !qualification || !lga || !phone) {
    return res.status(400).json({
      error: 'All staff fields are required.'
    });
  }

  if (
    name.length > 150 ||
    ministry.length > 150 ||
    qualification.length > 100 ||
    lga.length > 100 ||
    phone.length > 30
  ) {
    return res.status(400).json({
      error: 'One or more fields are too long.'
    });
  }

  try {
    const result = await db.query(
      `UPDATE staff_records
       SET ministry = $1,
           name = $2,
           qualification = $3,
           lga = $4,
           phone = $5
       WHERE id = $6
       RETURNING id, sno, ministry, name, qualification, lga, phone, created_at`,
      [
        ministry,
        name,
        qualification,
        lga,
        phone,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Staff record not found.'
      });
    }

    res.json({
      message: 'Staff record updated successfully.',
      record: result.rows[0]
    });

  } catch (error) {
    console.error('Supabase update record error:', error);

    res.status(500).json({
      error: 'Failed to update staff record in the database.'
    });
  }
});
app.delete('/api/records/:id', requireLogin, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      error: 'Admin access required.'
    });
  }

  const id = String(req.params.id);

  try {
    const result = await db.query(
      `DELETE FROM staff_records
       WHERE id = $1
       RETURNING id, sno, ministry, name, qualification, lga, phone, created_at`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: 'Staff record not found.'
      });
    }

    res.json({
      message: 'Staff record deleted successfully.',
      record: result.rows[0]
    });

  } catch (error) {
    console.error('Supabase delete record error:', error);

    res.status(500).json({
      error: 'Failed to delete staff record from the database.'
    });
  }
});
app.use('/style.css', express.static(path.join(__dirname, 'public', 'style.css'), {
  maxAge: isProd ? '1h' : 0
}));
app.use('/app.js', express.static(path.join(__dirname, 'public', 'app.js'), {
  maxAge: isProd ? '1h' : 0
}));

app.use((req, res) => res.status(404).send('Not found'));

app.listen(PORT, () => {
  console.log(`Secure database running on http://localhost:${PORT}`);
});
