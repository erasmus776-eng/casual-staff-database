import 'dotenv/config';
import express from 'express';
import XLSX from 'xlsx';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { getIronSession } from 'iron-session';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

app.get('/api/search', requireLogin, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();

  if (!q) {
    return res.json({ records: [] });
  }

  if (q.length > 100) {
    return res.status(400).json({ error: 'Search text is too long.' });
  }

  const found = records.filter(r => {
    return [r.name, r.lga, r.phone, r.qualification, r.ministry]
      .some(v => String(v || '').toLowerCase().includes(q));
  }).slice(0, 50);

  res.set('Cache-Control', 'no-store');
  res.json({ records: found, count: found.length });
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

  const nextSno = records.reduce((max, r) => {
    const n = Number(r.sno);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0) + 1;

  const newRecord = {
    sno: String(nextSno),
    ministry,
    name,
    qualification,
    lga,
    phone
  };

  records.push(newRecord);

  await fs.writeFile(
    path.join(__dirname, 'data', 'records.json'),
    JSON.stringify(records),
    'utf8'
  );

   res.status(201).json({
    message: 'Staff record added successfully.',
    record: newRecord
  });
});


app.post('/api/import-excel', requireLogin, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
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

    // Find the row containing the staff column headings
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

    // Create automatic backup before changing the database
    const backupName =
      `records-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

    await fs.copyFile(
      path.join(__dirname, 'data', 'records.json'),
      path.join(__dirname, 'backups', backupName)
    );

    let nextSno = records.reduce((max, r) => {
      const n = Number(r.sno);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0) + 1;

    let importedCount = 0;
    let duplicateCount = 0;

    for (const record of imported) {
      const newName = record.name.toLowerCase();
      const newPhone = record.phone.toLowerCase();
      const newLga = record.lga.toLowerCase();

      const duplicate = records.some(existing => {
        return (
          String(existing.name || '').trim().toLowerCase() === newName &&
          String(existing.phone || '').trim().toLowerCase() === newPhone &&
          String(existing.lga || '').trim().toLowerCase() === newLga
        );
      });

      if (duplicate) {
        duplicateCount++;
        continue;
      }

      records.push({
        sno: String(nextSno++),
        ministry: record.ministry,
        name: record.name,
        qualification: record.qualification,
        lga: record.lga,
        phone: record.phone
      });

      importedCount++;
    }

    await fs.writeFile(
      path.join(__dirname, 'data', 'records.json'),
      JSON.stringify(records),
      'utf8'
    );

    res.json({
      message: 'Excel import completed successfully.',
      imported: importedCount,
      duplicatesSkipped: duplicateCount
    });

  } catch (err) {
    console.error(err);
    res.status(400).json({
      error: 'Could not read the Excel file.'
    });
  }
});
app.put('/api/records/:sno', requireLogin, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const sno = String(req.params.sno);

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

  const record = records.find(r => String(r.sno) === sno);

  if (!record) {
    return res.status(404).json({
      error: 'Staff record not found.'
    });
  }

  record.name = name;
  record.ministry = ministry;
  record.qualification = qualification;
  record.lga = lga;
  record.phone = phone;

  await fs.writeFile(
    path.join(__dirname, 'data', 'records.json'),
    JSON.stringify(records),
    'utf8'
  );

  res.json({
    message: 'Staff record updated successfully.',
    record
  });
});
app.delete('/api/records/:sno', requireLogin, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const sno = String(req.params.sno);

  const index = records.findIndex(r => String(r.sno) === sno);

  if (index === -1) {
    return res.status(404).json({
      error: 'Staff record not found.'
    });
  }

  const deletedRecord = records[index];

  records.splice(index, 1);

  await fs.writeFile(
    path.join(__dirname, 'data', 'records.json'),
    JSON.stringify(records),
    'utf8'
  );

  res.json({
    message: 'Staff record deleted successfully.',
    record: deletedRecord
  });
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
