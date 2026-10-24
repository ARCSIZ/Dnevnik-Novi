/* ==========================================================================
   server.js — БЭКЕНД «КОЛЛЕДЖ·ID» (главный файл запуска на Node-хостинге)
   --------------------------------------------------------------------------
   Запуск:          node server.js
   Порт:            переменная окружения PORT (по умолчанию 3000)

   Особенности:
   • БЕЗ npm-зависимостей — только встроенные модули Node (>= 18).
     Не нужны node_modules: папку проекта можно просто скопировать.
   • База данных — файл Data/database.json (переносится вместе с папкой Data/).
   • Пароли — scrypt со случайной солью (memory-hard, встроен в Node).
   • Сессии — токены, подписанные HMAC-SHA256, в HttpOnly-cookie.
   • Rate limiting на вход/регистрацию, security-заголовки и CSP,
     защита от path traversal, публичный доступ к базе закрыт.
   • Отдаёт статические файлы сайта (index.html, General/, Students/ ...).

   API:
     GET  /api/health            — статус сервера
     GET  /api/groups            — список учебных групп
     POST /api/register          — регистрация {login, pass, fio, birth, group}
     POST /api/login             — вход {login, pass}
     GET  /api/me                — текущий пользователь (по токену)
     POST /api/logout            — выход
     GET  /api/users/logins      — список логинов (для проверки занятости)
     GET  /api/users             — все пользователи (только авторизованным)
     GET  /api/export            — полная копия базы (только авторизованным)
     POST /api/change-password   — смена пароля
 ========================================================================== */

'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createStore } = require('./Data/store.js');

/* ------------------------------------------------------------------ настройки */
const ROOT = __dirname;
const CODE_DATA_DIR = path.join(ROOT, 'Data');
/* Bothost монтирует постоянный диск в /app/data (нижний регистр).
   Исходники адаптера остаются в Data/, а runtime-база живёт на volume.
   Для других хостингов путь можно задать через DATA_DIR/DATABASE_PATH. */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : (process.env.DATABASE_PATH
      ? path.dirname(path.resolve(process.env.DATABASE_PATH))
      : (fs.existsSync('/app/data') ? '/app/data' : CODE_DATA_DIR));
const DATABASE_FILE = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(DATA_DIR, 'database.json');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN_TTL = 7 * 24 * 60 * 60;            // 7 дней, секунды
const BODY_LIMIT = 64 * 1024;                  // 64 КБ на запрос

/* Роли системы: студент, староста, куратор, разработчик */
function normRole(role) {
  const r = String(role || 'student').toLowerCase();
  if (r === 'dev' || r === 'developer' || r === 'admin') return 'dev';
  if (r === 'prefect' || r === 'starosta') return 'prefect';
  if (r === 'curator') return 'curator';
  return 'student';
}
const isDev = u => normRole(u && u.role) === 'dev';

const DEFAULT_GROUPS = [
  ['ИС-101', 'Информационные системы'],
  ['ПИ-202', 'Прикладная информатика'],
  ['КБ-110', 'Компьютерная безопасность'],
  ['ДЗ-230', 'Цифровой дизайн'],
  ['МГ-315', 'Менеджмент'],
  ['ЮР-140', 'Юриспруденция'],
  ['ЭК-220', 'Экономика и финансы'],
  ['МД-105', 'Медицинский профиль']
];

const nowISO = () => new Date().toISOString();
const uid = () => 'u_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
const normLogin = l => String(l || '').trim().toLowerCase();

/* --------------------------------------------------------------- база данных */
/* Безопасная миграция прежнего пути /app/Data → /app/data. Никогда не
   перезаписываем уже существующую постоянную базу. */
function migrateLegacyStorage() {
  const legacyDb = path.join(CODE_DATA_DIR, 'database.json');
  if (path.resolve(legacyDb) === path.resolve(DATABASE_FILE)) return;
  try {
    if (!fs.existsSync(DATABASE_FILE) && fs.existsSync(legacyDb)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.copyFileSync(legacyDb, DATABASE_FILE);
      const legacySecret = path.join(CODE_DATA_DIR, 'secret.key');
      const targetSecret = path.join(DATA_DIR, 'secret.key');
      if (fs.existsSync(legacySecret) && !fs.existsSync(targetSecret)) {
        fs.copyFileSync(legacySecret, targetSecret);
      }
      console.log('[server] База перенесена в постоянное хранилище: ' + DATABASE_FILE);
    }
  } catch (err) {
    console.error('[server] Не удалось перенести прежнюю базу:', err.message);
  }
}
migrateLegacyStorage();

const db = createStore({
  file: DATABASE_FILE,
  backupDir: path.join(DATA_DIR, 'backups'),
  keep: Number(process.env.BACKUPS_KEEP || 20),
  defaults: { version: 1, createdAt: nowISO(), updatedAt: null, users: [] }
});

/* Ключ подписи токенов: из окружения или свой файл Data/secret.key
   (файл переносится вместе с папкой Data/ — сессии живут и после переезда) */
function loadSecret() {
  if (process.env.COLLEGE_SECRET) return process.env.COLLEGE_SECRET;
  const keyFile = path.join(DATA_DIR, 'secret.key');
  try {
    if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile, 'utf8').trim();
    const key = crypto.randomBytes(48).toString('base64url');
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
    return key;
  } catch (e) {
    return crypto.randomBytes(48).toString('base64url');
  }
}
const SECRET = loadSecret();

function envValue(name, preserveSpaces) {
  let value = String(process.env[name] || '');
  if (!preserveSpaces) value = value.trim();
  if (value.length >= 2 &&
      ((value[0] === '"' && value[value.length - 1] === '"') ||
       (value[0] === "'" && value[value.length - 1] === "'"))) {
    value = value.slice(1, -1);
  }
  return preserveSpaces ? value : value.trim();
}

/* Сид ничего не удаляет: создаёт недостающие начальные данные и обновляет
   разработчика из ADMIN_* при наличии переменных. */
function seed() {
  if (!db.data.users.length) {
    db.data.users.push({
      id: uid(), login: 'demo', fio: 'Демо Студентов', birth: '2002-05-14',
      group: 'ИС-101', passHash: hashPassword('demo123'),
      role: 'student', registeredAt: nowISO(), lastLoginAt: null
    });
  }
  /* Начальный справочник учебных групп */
  if (!Array.isArray(db.data.groups) || !db.data.groups.length) {
    db.data.groups = DEFAULT_GROUPS.map((g, i) => ({ code: g[0], name: g[1], course: (i % 3) + 1 }));
  }

  /* При каждом запуске ADMIN_* является источником истины: существующему
     аккаунту обновляются роль и пароль, а отсутствующий создаётся. */
  const dl = envValue('ADMIN_LOGIN', false);
  const dp = envValue('ADMIN_PASSWORD', true);
  if (dl && dp) {
    try {
      const existing = db.data.users.find(u => normLogin(u.login) === normLogin(dl));
      if (!existing) {
        db.data.users.push({
          id: uid(), login: dl, fio: envValue('ADMIN_FIO', false) || 'Администратор',
          birth: '', group: '', passHash: hashPassword(dp),
          role: 'dev', registeredAt: nowISO(), lastLoginAt: null
        });
        console.log('[server] ✔ Создан аккаунт разработчика: ' + dl);
      } else {
        existing.role = 'dev';
        existing.passHash = hashPassword(dp);
        if (envValue('ADMIN_FIO', false)) existing.fio = envValue('ADMIN_FIO', false);
        console.log('[server] ✔ Обновлены роль и пароль разработчика: ' + dl);
      }
    } catch (err) {
      console.error('[server] ✖ Бутстрап разработчика не удался:', err.message);
    }
  } else {
    console.warn('[server] ADMIN_LOGIN или ADMIN_PASSWORD не заданы — ' +
      'создан только demo/demo123');
  }
  db.save();
}

/* Запись без хэша пароля уже объявлена ниже; здесь используем только поиск —
   findByLogin объявлен дальше, вызывается ниже перед стартом сервера. */

/* ------------------------------------------------------------ пароли (scrypt) */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString('hex'), hash.toString('hex')].join(':');
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split(':');
    if (parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[4], 'hex');
    const expected = Buffer.from(parts[5], 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length,
      { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) });
    return crypto.timingSafeEqual(actual, expected);   // сравнение без тайм-атак
  } catch (e) { return false; }
}

/* ------------------------------------------------------- токены (JWT HS256) */
function b64url(input) { return Buffer.from(input).toString('base64url'); }

function signToken(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(header + '.' + body).digest('base64url');
  return header + '.' + body + '.' + sig;
}

function verifyToken(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const expected = crypto.createHmac('sha256', SECRET)
      .update(parts[0] + '.' + parts[1]).digest('base64url');
    const a = Buffer.from(expected), b = Buffer.from(parts[2]);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload || (payload.exp && Date.now() / 1000 > payload.exp)) return null;
    return payload;
  } catch (e) { return null; }
}

function issueToken(user) {
  return signToken({
    sub: user.id, login: user.login, role: user.role || 'student',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + TOKEN_TTL
  });
}

/* ------------------------------------------------------------- rate limiting */
const buckets = new Map();

function allow(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count++;
  return b.count <= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
}, 60 * 1000).unref();

/* -------------------------------------------------------------------- утилиты */
function clientIP(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : null) || req.socket.remoteAddress || 'unknown';
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise(resolve => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > BODY_LIMIT) { req.destroy(); return resolve(null); }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function cookies(req) {
  const raw = req.headers.cookie;
  const out = {};
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function authPayload(req) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = bearer || cookies(req).college_token;
  return token ? verifyToken(token) : null;
}

function setAuthCookie(res, token) {
  const secure = (process.env.FORCE_SECURE === '1') ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    'college_token=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + TOKEN_TTL + secure);
}
function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', 'college_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

/* ---------------------------------------------------------------- валидация */
function validateRegistration(body) {
  const login = String(body.login || '').trim();
  const pass = String(body.pass || '');
  const fio = String(body.fio || '').trim().replace(/\s+/g, ' ');
  const birth = String(body.birth || '');
  const group = String(body.group || '');

  if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(login)) return { error: 'Логин: 3–24 символа, латиница, цифры, . _ -' };
  if (pass.length < 6 || pass.length > 128) return { error: 'Пароль должен быть от 6 до 128 символов' };
  if (fio.split(' ').length < 2 || fio.length < 5 || fio.length > 120) return { error: 'Укажите фамилию и имя полностью' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth)) return { error: 'Некорректная дата рождения' }
  const age = (Date.now() - new Date(birth).getTime()) / 3.156e10;
  if (age < 14 || age > 100) return { error: 'Возраст должен быть от 14 до 100 лет' };
  if (!(db.data.groups || []).some(g => g.code === group)) return { error: 'Выберите группу из списка' };

  return { login, pass, fio, birth, group };
}

/* Запись без хэша пароля — никогда не отдаём хэш наружу */
function publicUser(u) {
  return {
    id: u.id, login: u.login, fio: u.fio, birth: u.birth, group: u.group,
    role: u.role || 'student', registeredAt: u.registeredAt
  };
}
function findByLogin(login) {
  const l = normLogin(login);
  return db.data.users.find(u => normLogin(u.login) === l) || null;
}

/* ------------------------------------------------------------------- роуты API */
async function handleAPI(req, res, pathname) {
  const ip = clientIP(req);
  const route = pathname.replace(/\/+$/, '') || '/';
  const method = req.method;

  /* --- здоровье сервера --- */
  /* Версия данных: любое изменение базы увеличивает счётчик. Клиенты сверяют
     его и мгновенно подтягивают изменения, сделанные из панели управления. */
  function bumpDataVersion() {
    db.data.dataVersion = (Number(db.data.dataVersion) || 0) + 1;
    db.data.updatedAt = nowISO();
  }

  if (route === '/api/health' && method === 'GET') {
    const envLogin = envValue('ADMIN_LOGIN', false);
    const envPass = envValue('ADMIN_PASSWORD', true);
    const envAdmin = envLogin
      ? db.data.users.find(u => normLogin(u.login) === normLogin(envLogin))
      : null;
    return sendJSON(res, 200, {
      ok: true, service: 'college-id', version: '1.0.0',
      node: process.version, users: db.data.users.length,
      uptime: Math.round(process.uptime()), time: nowISO(),
      dataVersion: Number(db.data.dataVersion) || 0,
      database: {
        persistentPath: DATA_DIR,
        resetVersion: db.data.resetVersion || null
      },
      environment: {
        adminLoginSet: !!envLogin,
        adminPasswordSet: !!envPass,
        adminProvisioned: !!(envAdmin && envAdmin.role === 'dev')
      }
    });
  }

  /* --- список групп --- */
  if (route === '/api/groups' && method === 'GET') {
    return sendJSON(res, 200, { groups: db.data.groups || [], dataVersion: Number(db.data.dataVersion) || 0 });
  }

  /* --- версия данных: лёгкая проверка свежести кэша --- */
  if (route === '/api/version' && method === 'GET') {
    return sendJSON(res, 200, {
      dataVersion: Number(db.data.dataVersion) || 0,
      users: db.data.users.length,
      groups: (db.data.groups || []).length,
      updatedAt: db.data.updatedAt || null
    });
  }

  /* --- доступность логина --- */
  if (route === '/api/check-login' && method === 'GET') {
    const login = new URL(req.url, 'http://x').searchParams.get('login') || '';
    return sendJSON(res, 200, { available: !findByLogin(login) });
  }

  /* --- логины (для проверки занятости на клиенте) --- */
  if (route === '/api/users/logins' && method === 'GET') {
    return sendJSON(res, 200, { logins: db.data.users.map(u => u.login) });
  }

  /* --- регистрация --- */
  if (route === '/api/register' && method === 'POST') {
    if (!allow('reg:' + ip, 8, 60 * 60 * 1000)) return sendJSON(res, 429, { error: 'Слишком много попыток регистрации. Попробуйте позже' });
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, { error: 'Некорректный запрос' });
    const v = validateRegistration(body);
    if (v.error) return sendJSON(res, 400, { error: v.error });
    if (findByLogin(v.login)) return sendJSON(res, 409, { error: 'LOGIN_TAKEN' });

    const user = {
      id: uid(), login: v.login, fio: v.fio, birth: v.birth, group: v.group,
      passHash: hashPassword(v.pass), role: 'student',
      registeredAt: nowISO(), lastLoginAt: nowISO()
    };
    await db.mutate(d => d.users.push(user));
    bumpDataVersion();
    const token = issueToken(user);
    setAuthCookie(res, token);
    return sendJSON(res, 201, { user: publicUser(user), token, dataVersion: db.data.dataVersion });
  }

  /* --- вход --- */
  if (route === '/api/login' && method === 'POST') {
    if (!allow('login:' + ip, 15, 15 * 60 * 1000)) return sendJSON(res, 429, { error: 'Слишком много попыток входа. Подождите 15 минут' });
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, { error: 'Некорректный запрос' });
    const login = String(body.login || '').trim();
    const pass = String(body.pass || '');
    const rec = findByLogin(login);
    if (!rec || !verifyPassword(pass, rec.passHash)) {
      return sendJSON(res, 401, { error: 'Неверный логин или пароль' });
    }
    rec.lastLoginAt = nowISO();
    await db.save();
    const token = issueToken(rec);
    setAuthCookie(res, token);
    return sendJSON(res, 200, { user: publicUser(rec), token });
  }

  /* --- дальше только для авторизованных --- */
  const session = authPayload(req);
  const me = session ? db.data.users.find(u => u.id === session.sub) : null;

  if (route === '/api/me' && method === 'GET') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    return sendJSON(res, 200, { user: publicUser(me) });
  }

  if (route === '/api/logout' && method === 'POST') {
    clearAuthCookie(res);
    return sendJSON(res, 200, { ok: true });
  }

  if (route === '/api/users' && method === 'GET') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    return sendJSON(res, 200, {
      users: db.data.users.map(publicUser),
      total: db.data.users.length,
      dataVersion: Number(db.data.dataVersion) || 0
    });
  }

  if (route === '/api/export' && method === 'GET') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    return sendJSON(res, 200, db.data);
  }

  if (route === '/api/change-password' && method === 'POST') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    if (!allow('pass:' + ip, 10, 60 * 60 * 1000)) return sendJSON(res, 429, { error: 'Слишком много попыток' });
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, { error: 'Некорректный запрос' });
    if (!verifyPassword(String(body.current || ''), me.passHash)) return sendJSON(res, 400, { error: 'Текущий пароль неверен' });
    const next = String(body.next || '');
    if (next.length < 6 || next.length > 128) return sendJSON(res, 400, { error: 'Новый пароль должен быть от 6 до 128 символов' });
    me.passHash = hashPassword(next);
    await db.save();
    const token = issueToken(me);
    setAuthCookie(res, token);
    return sendJSON(res, 200, { ok: true, token });
  }

  /* --- смена роли пользователя (только разработчику/админу) --- */
  if (route.startsWith('/api/users/') && method === 'PUT') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const myRole = String(me.role || 'student').toLowerCase();
    if (myRole !== 'dev' && myRole !== 'admin') return sendJSON(res, 403, { error: 'Требуется роль «Разработчик»' });
    const target = decodeURIComponent(route.slice('/api/users/'.length));
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, { error: 'Некорректный запрос' });
    if (normLogin(target) === normLogin(me.login)) return sendJSON(res, 400, { error: 'Свою роль менять нельзя' });
    const rec = findByLogin(target);
    if (!rec) return sendJSON(res, 404, { error: 'Пользователь не найден' });
    rec.role = normRole(body.role);
    if (body.group !== undefined) rec.group = String(body.group || '');
    await db.save();
    bumpDataVersion();
    return sendJSON(res, 200, { ok: true, login: rec.login, role: rec.role, dataVersion: db.data.dataVersion });
  }

  /* --- создание аккаунта старосты/куратора (только dev) --- */
  if (route === '/api/users' && method === 'POST') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    if (!isDev(me)) return sendJSON(res, 403, { error: 'Требуется роль «Разработчик»' });
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, { error: 'Некорректный запрос' });
    const login = String(body.login || '').trim();
    const pass = String(body.pass || '');
    if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(login)) return sendJSON(res, 400, { error: 'Логин: 3–24 символа, латиница/цифры' });
    if (pass.length < 6) return sendJSON(res, 400, { error: 'Пароль — от 6 символов' });
    if (findByLogin(login)) return sendJSON(res, 409, { error: 'LOGIN_TAKEN' });
    const user = {
      id: uid(), login, fio: String(body.fio || '').trim().replace(/\s+/g, ' ') || login,
      birth: '', group: String(body.group || ''), passHash: hashPassword(pass),
      role: normRole(body.role), registeredAt: nowISO(), lastLoginAt: null
    };
    await db.mutate(d => d.users.push(user));
    bumpDataVersion();
    return sendJSON(res, 201, { user: publicUser(user), dataVersion: db.data.dataVersion });
  }

  /* --- создание группы (только dev) --- */
  if (route === '/api/groups' && method === 'POST') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    if (!isDev(me)) return sendJSON(res, 403, { error: 'Требуется роль «Разработчик»' });
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, { error: 'Некорректный запрос' });
    const code = String(body.code || '').trim().toUpperCase();
    const name = String(body.name || '').trim();
    const course = Math.min(6, Math.max(1, Number(body.course) || 1));
    if (!code || !name) return sendJSON(res, 400, { error: 'Укажите код и название группы' });
    db.data.groups = db.data.groups || [];
    if (db.data.groups.some(g => g.code === code)) return sendJSON(res, 409, { error: 'GROUP_EXISTS' });
    db.data.groups.push({ code, name, course });
    await db.save();
    bumpDataVersion();
    return sendJSON(res, 201, { ok: true, groups: db.data.groups, dataVersion: db.data.dataVersion });
  }

  /* --- удаление группы (только dev) --- */
  if (route.startsWith('/api/groups/') && method === 'DELETE') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    if (!isDev(me)) return sendJSON(res, 403, { error: 'Требуется роль «Разработчик»' });
    const code = decodeURIComponent(route.slice('/api/groups/'.length)).toUpperCase();
    const before = (db.data.groups || []).length;
    db.data.groups = (db.data.groups || []).filter(g => g.code !== code);
    if (db.data.groups.length === before) return sendJSON(res, 404, { error: 'Группа не найдена' });
    await db.save();
    bumpDataVersion();
    return sendJSON(res, 200, { ok: true, groups: db.data.groups, dataVersion: db.data.dataVersion });
  }

  /* --- сброс базы (только для разработчика) --- */
  if (route === '/api/reset' && method === 'POST') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const myRole = String(me.role || 'student').toLowerCase();
    if (myRole !== 'dev' && myRole !== 'admin') return sendJSON(res, 403, { error: 'Требуется роль «Разработчик»' });
    db.backup();                    // страховка перед удалением
    db.data.users.length = 0;
    db.data.updatedAt = nowISO();
    await db.save();
    console.log('[server] База сброшена пользователем ' + me.login + ' (осталось 0 пользователей)');
    return sendJSON(res, 200, { ok: true, action: 'reset', backup: true });
  }

  if (route.startsWith('/api/users/') && method === 'DELETE') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const target = decodeURIComponent(route.slice('/api/users/'.length));
    const myRole = String(me.role || 'student').toLowerCase();
    if (myRole !== 'dev' && myRole !== 'admin') return sendJSON(res, 403, { error: 'Недостаточно прав' });
    const before = db.data.users.length;
    db.data.users = db.data.users.filter(u => normLogin(u.login) !== normLogin(target));
    if (db.data.users.length === before) return sendJSON(res, 404, { error: 'Пользователь не найден' });
    await db.save();
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 404, { error: 'Неизвестный метод API' });
}

/* ------------------------------------------------------------- статика сайта */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json'
};

/* Файлы, которые нельзя отдавать наружу: база, бэкапы, ключ, исходник сервера */
const DENY = [
  /^\/Data\/database\.json$/i, /^\/Data\/backups(\/|$)/i, /^\/Data\/secret\.key$/i,
  /^\/Data\/store\.js$/i, /^\/server\.js$/i, /^\/package(-lock)?\.json$/i
];

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; " +
    "font-src 'self' https://fonts.gstatic.com data:; " +
    "img-src 'self' data: https:; connect-src 'self'; " +
    "frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
}

function notFound(res) {
  const body = '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>404 — Колледж·ID</title></head>' +
    '<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:#07070d;color:#fff;font-family:system-ui,sans-serif;flex-direction:column;gap:14px">' +
    '<div style="font-size:56px;font-weight:800">404</div>' +
    '<div style="color:rgba(255,255,255,.5)">Страница не найдена</div>' +
    '<a href="/" style="color:#a5b4fc">← На главную</a></body></html>';
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  if (DENY.some(re => re.test(pathname))) {
    return sendJSON(res, 403, { error: 'Доступ запрещён' });
  }
  let rel = pathname;
  if (rel === '/') rel = '/index.html';
  try { rel = decodeURIComponent(rel); } catch (e) { return notFound(res); }

  const target = path.normalize(path.join(ROOT, rel));
  if (!target.startsWith(ROOT + path.sep) && target !== ROOT) {
    return sendJSON(res, 403, { error: 'Доступ запрещён' });   // path traversal
  }

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    const ext = path.extname(target).toLowerCase();
    const mustRevalidate = ['.html', '.js', '.mjs', '.css'].includes(ext);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      /* Код приложения всегда перепроверяется после деплоя. Это не даёт
         браузеру держать старый API-клиент с уже исправленными ошибками. */
      'Cache-Control': mustRevalidate
        ? 'no-cache, no-store, must-revalidate'
        : 'public, max-age=3600'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).pipe(res);
  });
}

/* ------------------------------------------------------------------- сервер */
const server = http.createServer((req, res) => {
  securityHeaders(res);
  const pathname = new URL(req.url, 'http://x').pathname;

  /* Стандартные health-check адреса Bothost. */
  if ((pathname === '/health' || pathname === '/healthz') && req.method === 'GET') {
    handleAPI(req, res, '/api/health').catch(err => {
      console.error('[health]', err);
      if (!res.headersSent) sendJSON(res, 500, { ok: false });
    });
    return;
  }

  if (pathname.startsWith('/api/')) {
    handleAPI(req, res, pathname).catch(err => {
      console.error('[api]', err);
      if (!res.headersSent) sendJSON(res, 500, { error: 'Внутренняя ошибка сервера' });
    });
    return;
  }
  serveStatic(req, res, pathname);
});

/* аккуратное завершение: сначала освобождаем порт, затем сохраняем базу */
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[server] Получен ' + signal + ' — закрываем соединения и сохраняем базу…');
  try { server.close(() => { /* порт освобождён */ }); } catch (e) { /* noop */ }
  /* принудительный выход, если закрытие зависло */
  setTimeout(() => process.exit(0), 5000).unref();
  Promise.resolve(db.save()).then(() => {
    const backup = db.backup();
    if (backup) console.log('[server] Резервная копия: ' + backup);
    process.exit(0);
  }).catch(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/* регулярные бэкапы (по умолчанию раз в 12 часов) */
const BACKUP_EVERY = Number(process.env.BACKUP_EVERY_MS || 12 * 60 * 60 * 1000);
setInterval(() => { const b = db.backup(); if (b) console.log('[server] Автобэкап: ' + b); }, BACKUP_EVERY).unref();

/* страховка от краш-лупа: фатальные ошибки логируем, процесс не роняем */
process.on('uncaughtException', err => {
  console.error('[server] Неперехваченная ошибка (процесс продолжает работать):', err);
});
process.on('unhandledRejection', reason => {
  console.error('[server] Необработанный промис (процесс продолжает работать):', reason);
});

/* ------------------------------------------------------------ умный запуск
   Логика при занятом порту (EADDRINUSE):
   • если PORT задан хостингом — слушаем строго его и терпеливо ждём
     освобождения (обычно это умирающий прежний наш же процесс);
   • если PORT не задан — ждём немного, затем сканируем соседние порты
     (3001, 3002, …) и поднимаемся на первом свободном. */

/* ------------------------- CLI: сброс базы данных -------------------------
     node server.js --reset          → спросит подтверждение (y)
     node server.js --reset --yes    → сброс без вопросов
     Перед удалением поднимает резервную копию в Data/backups/.          */
if (process.argv.includes('--reset')) {
  const yes = process.argv.includes('--yes');
  console.log('\n  СБРОС БАЗЫ ДАННЫХ КОЛЛЕДЖ·ID');
  const doReset = () => {
    const backup = db.backup();
    db.data.users.length = 0;
    db.data.updatedAt = nowISO();
    db.save().then(() => {
      console.log('  ✔ База обнулена (' + db.data.users.length + ' пользователей).');
      if (backup) console.log('  ✔ Резервная копия: ' + backup);
      console.log('  ✔ При следующем запуске будет создан чистый демо-аккаунт demo/demo123\n');
      process.exit(0);
    });
  };
  if (yes) { doReset(); }
  else {
    process.stdout.write('  ⚠ Удалить всех пользователей? (y/N): ');
    process.stdin.once('data', d => {
      const a = String(d).trim().toLowerCase();
      if (a === 'y' || a === 'yes') doReset();
      else { console.log('  Отменено.\n'); process.exit(0); }
    });
  }
} else {

seed();

/* ------------------------- CLI: управление ролями -------------------------
   СПОСОБ НАЗНАЧИТЬ ПЕРВОГО РАЗРАБОТЧИКА — консоль сервера:
     node server.js --promote <логин>   → роль «dev» (доступ к панели)
     node server.js --demote  <логин>   → роль «student»
     node server.js --roles             → список пользователей и их ролей
   Команда применяется к базе и завершает процесс (сервер не запускается).  */
(function cli(){
  const args = process.argv.slice(2);
  const pi = args.indexOf('--promote'), di = args.indexOf('--demote');
  const li = args.indexOf('--roles');
  if (li > -1) {
    console.log('\n  ПОЛЬЗОВАТЕЛИ И РОЛИ\n  ' + '─'.repeat(46));
    db.data.users.forEach(u => console.log('  ' +
      String(u.login).padEnd(22) + '  ' + String(u.role || 'student')));
    console.log('  ' + '─'.repeat(46) + '\n  Всего: ' + db.data.users.length + '\n');
    return process.exit(0);
  }
  const idx = pi > -1 ? pi : di;
  if (idx === -1) return;
  const login = args[idx + 1];
  if (!login) { console.error('Укажите логин, например: node server.js --promote demo'); process.exit(1); }
  const rec = findByLogin(login);
  if (!rec) { console.error('Пользователь "' + login + '" не найден в базе.'); process.exit(1); }
  rec.role = pi > -1 ? 'dev' : 'student';
  db.save().then(() => {
    console.log('✔ ' + login + ' → роль «' + rec.role + '». Сохранено в Data/database.json');
    process.exit(0);
  });
})();

const PORT_ASSIGNED = !!process.env.PORT;
const RETRY_MS = 1500;          // пауза между попытками
const WAIT_TRIES = 10;          // попыток на одном порту до вывода о статусе/сканировании
const MAX_SCAN = 30;            // сколько соседних портов перебирать

let actualPort = PORT;
let movedFromBusy = false;

function onOpen(port) {
  const lines = [
    '',
    '  ┌─────────────────────────────────────────────────┐',
    '  │            КОЛЛЕДЖ·ID — БЭКЕНД v1.0.0           │',
    '  ├─────────────────────────────────────────────────┤',
    '  │  Сайт:       http://localhost:' + String(port).padEnd(11) + '│',
    '  │  API:        http://localhost:' + port + '/api/health',
    '  │  Node:       ' + process.version.padEnd(35) + '│',
    '  │  Пользоват.: ' + String(db.data.users.length).padEnd(35) + '│',
    '  │  База:       ' + String(DATABASE_FILE).slice(-35).padEnd(35) + '│',
    '  │  Зависимости: нет (только встроенные модули)    │',
    '  │  ADMIN_*:    ' + ((process.env.ADMIN_LOGIN ? ('ADMIN_LOGIN=' + process.env.ADMIN_LOGIN + ((process.env.ADMIN_PASSWORD ? ' + пароль задан' : '')).padEnd(33)) : ('не заданы')).padEnd(35)) + '│',
    '  └─────────────────────────────────────────────────┘',
    (movedFromBusy
      ? '  ⚠ Порт ' + PORT + ' был занят — сервер поднялся на ' + port + '.\n' +
        '  В панели хостинга настройте этот порт как открытый наружу,\n' +
        '  либо задайте переменную окружения PORT и перезапустите.\n'
      : ''),
    '  Демо-доступ: demo / demo123',
    '  Все данные живут в папке Data/ — скопируйте её, чтобы',
    '  перенести базу на другой хостинг без потерь.',
    ''
  ];
  console.log(lines.filter(s => s !== '').join('\n'));
}

function listenOn(port, attempt) {
  if (shuttingDown) return;

  function onError(err) {
    if (!err || err.code !== 'EADDRINUSE') {
      if (err && err.code === 'EACCES') {
        console.error('[server] Нет прав на порт ' + port + '. Задайте порт > 1024 через переменную окружения PORT.');
      } else {
        console.error('[server] Ошибка слушающего сокета:', err);
      }
      return process.exit(1);
    }

    /* порт занят */
    if (attempt < WAIT_TRIES) {
      if (attempt % 3 === 1) {
        console.warn('[server] Порт ' + port + ' занят — жду освобождения (' + attempt + '/' + WAIT_TRIES + ')…');
      }
      return setTimeout(() => listenOn(port, attempt + 1), RETRY_MS);
    }

    if (PORT_ASSIGNED) {
      console.error('[server] Порт ' + port + ', назначенный хостингом, долго не освобождается.\n' +
        '[server] Вероятно, прежний процесс завис — перезапустите контейнер в панели хостинга.');
      return process.exit(1);   // пусть платформа корректно перезапустит
    }

    const next = port + 1;
    if (next >= PORT + MAX_SCAN) {
      console.error('[server] Порты ' + PORT + '–' + (PORT + MAX_SCAN - 1) + ' заняты.\n' +
        '[server] Задайте свободный порт через переменную окружения PORT и перезапустите.');
      return process.exit(1);
    }
    movedFromBusy = true;
    console.warn('[server] Порт ' + port + ' занят → пробую ' + next + '…');
    setTimeout(() => listenOn(next, 1), 200);
  }

  function onListening() {
    server.removeListener('error', onError);
    actualPort = server.address().port;
    onOpen(actualPort);
  }

  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, HOST);
}

listenOn(PORT, 1);

}  // конец блока else (основной запуск), парный к «if (process.argv.includes('--reset'))»
