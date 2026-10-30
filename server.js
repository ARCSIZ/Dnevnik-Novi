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
const zlib = require('zlib');
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
/* Длинная сессия: пользователь не должен разлогиниваться при закрытии
   вкладки, браузера или установленного приложения. */
const TOKEN_TTL = 180 * 24 * 60 * 60;          // 180 дней, секунды
const BODY_LIMIT = Number(process.env.BODY_LIMIT) || 4 * 1024 * 1024;  // 4 МБ: расписание семестра

/* Роли системы: студент, староста, куратор, разработчик */
function normRole(role) {
  const r = String(role || 'student').toLowerCase();
  if (r === 'dev' || r === 'developer' || r === 'admin') return 'dev';
  if (r === 'prefect' || r === 'starosta') return 'prefect';
  if (r === 'curator') return 'curator';
  if (r === 'teacher') return 'teacher';
  if (r === 'support' || r === 'operator') return 'support';
  if (r === 'patron' || r === 'sutener') return 'patron';
  return 'student';
}

/* Мультироли: основная роль + дополнительные через поле roles. */
function rolesOf(u) {
  if (!u) return ['student'];
  const out = [normRole(u.role)];
  (Array.isArray(u.roles) ? u.roles : []).forEach(r => {
    const n = normRole(r);
    if (out.indexOf(n) === -1) out.push(n);
  });
  return out;
}
const hasRole = (u, r) => rolesOf(u).indexOf(r) > -1;
const isSupport = u => hasRole(u, 'support') || hasRole(u, 'dev');
/* Значки и эксклюзивные темы выдают разработчик и патрон. */
const canAward = u => hasRole(u, 'dev') || hasRole(u, 'patron');

/* Короткое ФИО для поддержки: «Иванова Мария Петровна» → «Иванова М. П.» */
function shortFio(fio) {
  const p = String(fio || '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '';
  let s = p[0];
  if (p[1]) s += ' ' + p[1][0].toUpperCase() + '.';
  if (p[2]) s += ' ' + p[2][0].toUpperCase() + '.';
  return s;
}

/* Ключ ФИО: «Селецкая Екатерина Леонидовна» и «Селецкая Е.Л.» → «селецкая е л» */
function fioKey(s) {
  const p = String(s || '').replace(/\./g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '';
  let out = p[0].toLowerCase();
  if (p[1]) out += ' ' + p[1].charAt(0).toLowerCase();
  if (p[2]) out += ' ' + p[2].charAt(0).toLowerCase();
  return out;
}
const isDev = u => rolesOf(u).indexOf('dev') > -1;

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

/* ---------------------------------------------------------- PWA-иконки
   Генерируем PNG 192/512 из встроенных данных один раз при старте, чтобы
   манифест был валидным и приложение ставилось на Android и iOS. */
/* ---- минимальный PNG-энкодер: Node умеет zlib, значит умеет и PNG ---- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(size, rgba) {
  const zlib = require('zlib');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // бит на канал
  ihdr[9] = 6;    // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;                       // фильтр строки
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/* Рисуем логотип: градиентный квадрат + белая шапочка выпускника.
   square=true — без скруглений и прозрачности (требование iOS). */
function drawIcon(size, opts) {
  opts = opts || {};
  const pad = opts.pad || 0;                 // безопасная зона для maskable
  const square = !!opts.square;
  const buf = Buffer.alloc(size * size * 4);
  const R = size * 0.22;                     // радиус скругления
  const inner = size - pad * 2;
  const cx = size / 2, cy = size * 0.52;
  const S = inner;

  const inRounded = (x, y) => {
    if (square) return true;
    const dx = Math.min(x, size - 1 - x), dy = Math.min(y, size - 1 - y);
    if (dx >= R || dy >= R) return true;
    return (R - dx) * (R - dx) + (R - dy) * (R - dy) <= R * R;
  };
  /* шапочка: ромб сверху, тулья снизу, кисточка справа */
  const inCap = (x, y) => {
    const nx = x - cx, ny = y - cy;
    const dW = S * 0.33, dH = S * 0.165, dCy = -S * 0.06;
    if (Math.abs(nx) / dW + Math.abs(ny - dCy) / dH <= 1) return true;
    const bodyTop = dCy + S * 0.02, bodyBot = dCy + S * 0.20;
    if (ny >= bodyTop && ny <= bodyBot) {
      const k = (ny - bodyTop) / (bodyBot - bodyTop);
      if (Math.abs(nx) <= S * (0.205 - 0.03 * k * k)) return true;
    }
    const tx = S * 0.285;
    if (Math.abs(nx - tx) <= S * 0.016 && ny >= dCy && ny <= dCy + S * 0.235) return true;
    if (Math.hypot(nx - tx, ny - (dCy + S * 0.255)) <= S * 0.032) return true;
    return false;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRounded(x, y)) { buf[i + 3] = 0; continue; }
      const t = (x / size + y / size) / 2;                 // диагональный градиент
      let r = Math.round(99 + (168 - 99) * t);
      let g = Math.round(102 + (85 - 102) * t);
      let b = Math.round(241 + (247 - 241) * t);
      if (y < size * 0.5) {                                 // лёгкий блик сверху
        const s = (1 - y / (size * 0.5)) * 0.10;
        r += Math.round((255 - r) * s); g += Math.round((255 - g) * s); b += Math.round((255 - b) * s);
      }
      if (x >= pad && x < size - pad && y >= pad && y < size - pad && inCap(x, y)) {
        r = 255; g = 255; b = 255;
      }
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
  return buf;
}

/* ---------------------------------------------------------- PWA-иконки
   Генерируем настоящие PNG при старте: без них iOS не показывает иконку
   на домашнем экране, а Android отказывается ставить приложение. */
function ensureIcons() {
  const dir = path.join(ROOT, 'icons');
  const SPECS = [
    { file: 'icon-192.png', size: 192 },
    { file: 'icon-512.png', size: 512 },
    { file: 'icon-maskable-512.png', size: 512, pad: 64 },
    { file: 'icon-180.png', size: 180, square: true },   // apple-touch-icon
    { file: 'icon-167.png', size: 167, square: true },   // iPad Pro
    { file: 'icon-152.png', size: 152, square: true }    // iPad
  ];
  try {
    fs.mkdirSync(dir, { recursive: true });
    SPECS.forEach(s => {
      const p = path.join(dir, s.file);
      /* перезаписываем старые 1×1 заглушки (они весили < 2 КБ) */
      let need = true;
      try { need = !fs.existsSync(p) || fs.statSync(p).size < 2000; } catch (e) { /* noop */ }
      if (!need) return;
      fs.writeFileSync(p, encodePNG(s.size, drawIcon(s.size, s)));
    });
    console.log('[server] PWA-иконки готовы: ' + SPECS.map(s => s.file).join(', '));
  } catch (e) {
    console.warn('[server] Не удалось создать иконки:', e.message);
  }
}
ensureIcons();

/* Очистка HTML объявлений: оформление разрешено, исполняемый код — нет. */
function sanitizeHTML(html) {
  return String(html || '')
    .replace(/<\s*(script|iframe|object|embed|link|meta|form)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|iframe|object|embed|link|meta|form)\b[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '');
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
  const body = Buffer.from(JSON.stringify(obj));
  const accepts = String((res.req && res.req.headers['accept-encoding']) || '');
  /* Не сжимаем многомегабайтные base64-скриншоты: это почти не уменьшает
     размер, но нагружает CPU. Расписания и журналы обычно < 1.5 МБ. */
  const useGzip = body.length > 1024 && body.length < 1536 * 1024 && /\bgzip\b/.test(accepts);
  const payload = useGzip ? zlib.gzipSync(body, { level: 5 }) : body;
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'Vary': 'Accept-Encoding'
  };
  if (useGzip) headers['Content-Encoding'] = 'gzip';
  res.writeHead(code, headers);
  res.end(payload);
}

/* Чтение тела запроса.
   ВАЖНО: при превышении лимита соединение НЕ разрывается (это давало 502 на
   прокси хостинга) — дочитываем поток и возвращаем признак «слишком большое». */
function readBody(req) {
  return new Promise(resolve => {
    let size = 0, tooLarge = false;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > BODY_LIMIT) { tooLarge = true; return; }   // просто перестаём копить
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return resolve({ __tooLarge: true });
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { resolve(null); }
    });
    req.on('error', () => resolve(null));
    req.on('aborted', () => resolve(null));
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
  const mediaVersion = Number(u.mediaVersion) || 1;
  return {
    id: u.id, login: u.login, fio: u.fio, birth: u.birth, group: u.group,
    role: normRole(u.role), registeredAt: u.registeredAt,
    /* Вместо многомегабайтного base64 отдаём короткие URL. */
    avatar: u.avatar ? ('/api/media/' + encodeURIComponent(u.id) + '/avatar?v=' + mediaVersion) : '',
    banner: u.banner ? ('/api/media/' + encodeURIComponent(u.id) + '/banner?v=' + mediaVersion) : '',
    accent: u.accent || '',
    roles: rolesOf(u),
    badges: Array.isArray(u.badges) ? u.badges : [],
    themes: Array.isArray(u.themes) ? u.themes : []
  };
}

/* Запись для списков: роль «Патрон» видят только её обладатель и dev. */
function listUser(u, viewer) {
  const data = publicUser(u);
  const privileged = viewer && (isDev(viewer) || viewer.id === u.id);
  if (!privileged) {
    data.roles = data.roles.filter(r => r !== 'patron');
    data.role = data.roles[0] || 'student';
  }
  return data;
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

  /* --- публичная статистика для главной страницы --- */
  if (route === '/api/stats' && method === 'GET') {
    const users = db.data.users || [];
    const groups = db.data.groups || [];
    const courses = {};
    groups.forEach(g => { courses[g.course] = true; });
    const sch = db.data.schedule || {};
    let subjects = {};
    Object.keys(sch).forEach(g => Object.keys(sch[g] || {}).forEach(d =>
      (sch[g][d] || []).forEach(L => { if (!L.event && L.name) subjects[L.name] = true; })));
    return sendJSON(res, 200, {
      users: users.length,
      students: users.filter(u => ['student', 'prefect'].indexOf(normRole(u.role)) > -1).length,
      teachers: users.filter(u => normRole(u.role) === 'teacher').length,
      groups: groups.length,
      courses: Object.keys(courses).length,
      subjects: Object.keys(subjects).length,
      dataVersion: Number(db.data.dataVersion) || 0
    });
  }

  /* --- публичное состояние: техработы и объявление (без авторизации) --- */
  if (route === '/api/state' && method === 'GET') {
    return sendJSON(res, 200, {
      maintenance: db.data.maintenance || { enabled: false, message: '' },
      notice: db.data.notice || { active: false },
      dataVersion: Number(db.data.dataVersion) || 0
    });
  }

  /* ===== Авторизация: дальше все маршруты могут проверять сессию =====
     Объявление перенесено СЮДА — раньше оно было ниже, а маршруты
     maintenance/notice обращались к `me` до инициализации (ReferenceError). */
  const session = authPayload(req);
  const me = session ? db.data.users.find(u => u.id === session.sub) : null;

  /* Изображения профиля отдаются отдельно от JSON. */
  if (route.startsWith('/api/media/') && method === 'GET') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const parts = route.split('/');
    const id = decodeURIComponent(parts[3] || '');
    const kind = parts[4];
    const owner = db.data.users.find(u => u.id === id);
    if (!owner || (kind !== 'avatar' && kind !== 'banner') || !owner[kind]) {
      return sendJSON(res, 404, { error: 'Изображение не найдено' });
    }
    const match = String(owner[kind]).match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/s);
    if (!match) return sendJSON(res, 404, { error: 'Некорректное изображение' });
    const bin = Buffer.from(match[2], 'base64');
    res.writeHead(200, {
      'Content-Type': match[1],
      'Content-Length': bin.length,
      'Cache-Control': 'private, max-age=86400, immutable',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.end(bin);
  }

  /* --- единый быстрый bootstrap вместо 5-7 запросов при открытии страницы --- */
  if (route === '/api/bootstrap' && method === 'GET') {
    const users = db.data.users || [];
    const groups = db.data.groups || [];
    const courses = {};
    groups.forEach(g => { courses[g.course] = true; });
    const teachingGroups = [];
    if (me && fioKey(me.fio)) {
      const all = db.data.schedule || {};
      Object.keys(all).forEach(group => {
        const days = all[group] || {};
        const teaches = Object.keys(days).some(date =>
          (days[date] || []).some(L => !L.event && fioKey(L.teacher) === fioKey(me.fio)));
        if (teaches) teachingGroups.push(group);
      });
    }
    return sendJSON(res, 200, {
      ok: true,
      service: 'college-id',
      version: '1.1.0',
      dataVersion: Number(db.data.dataVersion) || 0,
      user: me ? publicUser(me) : null,
      teachingGroups,
      groups,
      maintenance: db.data.maintenance || { enabled: false, message: '' },
      notice: db.data.notice || { active: false },
      stats: {
        users: users.length,
        students: users.filter(u => ['student', 'prefect'].indexOf(normRole(u.role)) > -1).length,
        teachers: users.filter(u => normRole(u.role) === 'teacher').length,
        groups: groups.length,
        courses: Object.keys(courses).length
      }
    });
  }

  /* ===================== ЧАТЫ С ПРЕПОДАВАТЕЛЯМИ =====================
     Диалог «студент ↔ преподаватель». Ключ треда: login студента + login
     преподавателя, чтобы переписки разных предметов не смешивались.     */
  function chatStore() {
    db.data.teacherChats = db.data.teacherChats || { version: 0, threads: {} };
    return db.data.teacherChats;
  }
  /* Ключ диалога не зависит от порядка: пара логинов всегда сортируется. */
  function threadKey(a, b) {
    return [normLogin(a), normLogin(b)].sort().join('|');
  }
  function threadOf(a, b) {
    const st = chatStore(), k = threadKey(a, b);
    if (!st.threads[k]) {
      const pair = [a, b].sort((x, y) => normLogin(x).localeCompare(normLogin(y)));
      st.threads[k] = {
        a: pair[0], b: pair[1], messages: [], updatedAt: null,
        unread: {}            /* логин → количество непрочитанных */
      };
    }
    const t = st.threads[k];
    /* Миграция старых тредов student/teacher в новый формат. */
    if (!t.a && t.student) {
      const pair = [t.student, t.teacher].sort((x, y) => normLogin(x).localeCompare(normLogin(y)));
      t.a = pair[0]; t.b = pair[1];
      t.unread = {};
      t.unread[t.student] = t.unreadStudent || 0;
      t.unread[t.teacher] = t.unreadTeacher || 0;
    }
    t.unread = t.unread || {};
    return t;
  }
  const peerOf = (t, login) => normLogin(t.a) === normLogin(login) ? t.b : t.a;
  /* Преподаватели, которые ведут пары у группы студента */
  function teachersForGroup(group) {
    const days = (db.data.schedule || {})[group] || {};
    const keys = {};
    Object.keys(days).forEach(d => (days[d] || []).forEach(L => {
      if (!L.event && L.teacher) keys[fioKey(L.teacher)] = L.teacher;
    }));
    return (db.data.users || [])
      .filter(u => hasRole(u, 'teacher') || hasRole(u, 'curator'))
      .filter(u => keys[fioKey(u.fio)])
      .map(u => ({ login: u.login, fio: u.fio, short: shortFio(u.fio) }));
  }

  /* --- список заблокированных текущим пользователем --- */
  function blockedBy(u) { return Array.isArray(u.blocked) ? u.blocked : []; }
  function isBlocked(owner, target) {
    return blockedBy(owner).some(l => normLogin(l) === normLogin(target));
  }

  /* --- поиск пользователя по логину, как в мессенджере --- */
  if (route === '/api/chats/search' && method === 'GET') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const q = String(new URL(req.url, 'http://x').searchParams.get('q') || '').trim().toLowerCase();
    if (q.length < 2) return sendJSON(res, 200, { users: [] });
    const found = (db.data.users || [])
      .filter(u => u.id !== me.id)
      .filter(u => normLogin(u.login).indexOf(q) > -1
        || String(u.fio || '').toLowerCase().indexOf(q) > -1)
      .slice(0, 12)
      .map(u => {
        const card = listUser(u, me);
        card.short = shortFio(u.fio);
        card.blocked = isBlocked(me, u.login);
        card.blockedMe = isBlocked(u, me.login);
        return card;
      });
    return sendJSON(res, 200, { users: found });
  }

  /* --- карточка профиля собеседника --- */
  if (route === '/api/chats/profile' && method === 'GET') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const login = String(new URL(req.url, 'http://x').searchParams.get('login') || '');
    const u = findByLogin(login);
    if (!u) return sendJSON(res, 404, { error: 'Пользователь не найден' });
    const card = listUser(u, me);
    card.short = shortFio(u.fio);
    card.blocked = isBlocked(me, u.login);
    card.blockedMe = isBlocked(u, me.login);
    /* Предметы, которые ведёт преподаватель — полезно видеть в профиле. */
    if (hasRole(u, 'teacher') || hasRole(u, 'curator')) {
      const subjects = {}, all = db.data.schedule || {};
      Object.keys(all).forEach(g => Object.keys(all[g] || {}).forEach(d =>
        (all[g][d] || []).forEach(L => {
          if (!L.event && L.name && fioKey(L.teacher) === fioKey(u.fio)) {
            subjects[L.name] = true;
          }
        })));
      card.subjects = Object.keys(subjects).slice(0, 12);
    }
    return sendJSON(res, 200, { user: card });
  }

  /* --- блокировка и разблокировка --- */
  if (route === '/api/chats/block' && method === 'POST') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, { error: 'Некорректный запрос' });
    const target = findByLogin(String(body.login || ''));
    if (!target) return sendJSON(res, 404, { error: 'Пользователь не найден' });
    if (target.id === me.id) return sendJSON(res, 400, { error: 'Нельзя заблокировать себя' });
    me.blocked = blockedBy(me).filter(l => normLogin(l) !== normLogin(target.login));
    if (!body.unblock) me.blocked.push(target.login);
    await db.save();
    const st = chatStore();
    st.version = (Number(st.version) || 0) + 1;
    return sendJSON(res, 200, { ok: true, blocked: !body.unblock, version: st.version });
  }

  /* --- список заблокированных --- */
  if (route === '/api/chats/blocked' && method === 'GET') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const list = blockedBy(me).map(l => {
      const u = findByLogin(l);
      return u ? { login: u.login, fio: u.fio, short: shortFio(u.fio) } : null;
    }).filter(Boolean);
    return sendJSON(res, 200, { blocked: list });
  }

  if (route === '/api/chats' && method === 'GET') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const st = chatStore();
    const out = [], seen = {};

    /* Все диалоги, где участвует пользователь */
    Object.keys(st.threads).forEach(k => {
      const t = threadOf(st.threads[k].a || st.threads[k].student,
                         st.threads[k].b || st.threads[k].teacher);
      if (normLogin(t.a) !== normLogin(me.login) && normLogin(t.b) !== normLogin(me.login)) return;
      const peer = peerOf(t, me.login);
      const u = findByLogin(peer);
      if (!u) return;
      const last = t.messages[t.messages.length - 1] || null;
      seen[normLogin(peer)] = true;
      out.push({
        peer: u.login, fio: u.fio, short: shortFio(u.fio),
        group: u.group || '', role: normRole(u.role),
        last: last ? {
          text: String(last.text || '').slice(0, 120), at: last.at,
          mine: normLogin(last.from) === normLogin(me.login)
        } : null,
        unread: (t.unread && t.unread[me.login]) || 0,
        blocked: isBlocked(me, u.login),
        updatedAt: t.updatedAt
      });
    });

    /* Преподаватели группы показываются сразу, даже без переписки */
    teachersForGroup(me.group || '').forEach(t => {
      if (normLogin(t.login) === normLogin(me.login)) return;
      if (seen[normLogin(t.login)]) return;
      out.push({
        peer: t.login, fio: t.fio, short: t.short, group: me.group || '',
        role: 'teacher', last: null, unread: 0,
        blocked: isBlocked(me, t.login), updatedAt: null, suggested: true
      });
    });

    out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return sendJSON(res, 200, { chats: out, version: Number(st.version) || 0 });
  }

  if (route === '/api/chats/version' && method === 'GET') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    return sendJSON(res, 200, { version: Number(chatStore().version) || 0 });
  }

  if (route === '/api/chats/thread' && method === 'GET') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const peer = new URL(req.url, 'http://x').searchParams.get('peer') || '';
    const other = findByLogin(peer);
    if (!other) return sendJSON(res, 404, { error: 'Собеседник не найден' });
    const t = threadOf(me.login, other.login);
    t.unread[me.login] = 0;
    await db.save();
    return sendJSON(res, 200, {
      peer: other.login, fio: other.fio, short: shortFio(other.fio),
      role: normRole(other.role), group: other.group || '',
      blocked: isBlocked(me, other.login),
      blockedMe: isBlocked(other, me.login),
      messages: t.messages, version: Number(chatStore().version) || 0
    });
  }

  if (route === '/api/chats/message' && method === 'POST') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const body = await readBody(req);
    if (body && body.__tooLarge) return sendJSON(res, 413, { error: 'Слишком большое вложение' });
    if (!body) return sendJSON(res, 400, { error: 'Некорректный запрос' });
    const other = findByLogin(String(body.to || '').trim());
    if (!other) return sendJSON(res, 404, { error: 'Собеседник не найден' });
    const text = String(body.text || '').slice(0, 5000);
    const image = typeof body.image === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(body.image)
      ? body.image.slice(0, 3 * 1024 * 1024) : '';
    if (!text.trim() && !image) return sendJSON(res, 400, { error: 'Пустое сообщение' });

    /* Блокировки проверяются в обе стороны */
    if (isBlocked(me, other.login)) {
      return sendJSON(res, 403, { error: 'Вы заблокировали этого пользователя' });
    }
    if (isBlocked(other, me.login)) {
      return sendJSON(res, 403, { error: 'Пользователь ограничил приём сообщений' });
    }

    const t = threadOf(me.login, other.login);
    /* Ответ на сообщение: сохраняем краткую цитату */
    let replyTo = null;
    if (body.replyTo) {
      const src = t.messages.find(m => m.id === String(body.replyTo));
      if (src) {
        replyTo = {
          id: src.id, author: src.author || '',
          text: String(src.text || (src.image ? 'Изображение' : '')).slice(0, 120)
        };
      }
    }
    t.messages.push({
      id: 'tm_' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
      from: me.login, author: shortFio(me.fio) || me.login,
      text, image, replyTo, at: nowISO()
    });
    if (t.messages.length > 400) t.messages = t.messages.slice(-400);
    t.updatedAt = nowISO();
    t.unread[other.login] = (t.unread[other.login] || 0) + 1;
    const st = chatStore();
    st.version = (Number(st.version) || 0) + 1;
    await db.save();
    return sendJSON(res, 201, { ok: true, message: t.messages[t.messages.length - 1], version: st.version });
  }

  /* --- удалить своё сообщение --- */
  if (route === '/api/chats/delete' && method === 'POST') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, { error: 'Некорректный запрос' });
    const other = findByLogin(String(body.peer || ''));
    if (!other) return sendJSON(res, 404, { error: 'Собеседник не найден' });
    const t = threadOf(me.login, other.login);
    const msg = t.messages.find(m => m.id === String(body.id));
    if (!msg) return sendJSON(res, 404, { error: 'Сообщение не найдено' });
    if (normLogin(msg.from) !== normLogin(me.login) && !isDev(me)) {
      return sendJSON(res, 403, { error: 'Можно удалять только свои сообщения' });
    }
    msg.text = ''; msg.image = ''; msg.deleted = true;
    const st = chatStore();
    st.version = (Number(st.version) || 0) + 1;
    await db.save();
    return sendJSON(res, 200, { ok: true, version: st.version });
  }

  /* ===================== ДОМАШНИЕ ЗАДАНИЯ =====================
     Преподаватель выдаёт задание на свою пару: оно попадает в расписание
     группы и сразу видно студентам в дневнике.                      */
  if (route === '/api/homework' && method === 'PUT') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, { error: 'Некорректный запрос' });
    const group = String(body.group || '').trim();
    const date = String(body.date || '');
    const slot = String(body.slot || '');
    const text = String(body.hw || '').slice(0, 1200);
    if (!group || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return sendJSON(res, 400, { error: 'Не указана группа или дата' });
    }
    const list = ((db.data.schedule || {})[group] || {})[date] || [];
    const lesson = list.find(L => String(L.slot) === slot);
    if (!lesson) return sendJSON(res, 404, { error: 'Пара не найдена в расписании' });
    const mine = fioKey(lesson.teacher) === fioKey(me.fio);
    const allowed = isDev(me) || mine
      || ((hasRole(me, 'prefect') || hasRole(me, 'curator')) && String(me.group || '') === group);
    if (!allowed) return sendJSON(res, 403, { error: 'Можно выдавать задание только на свои пары' });
    lesson.hw = text;
    lesson.hwBy = shortFio(me.fio) || me.login;
    lesson.hwAt = nowISO();
    await db.save();
    bumpDataVersion();
    return sendJSON(res, 200, { ok: true, dataVersion: db.data.dataVersion });
  }

  /* ===================== НАГРАДЫ: ЗНАЧКИ И ТЕМЫ =====================
     Каталог значков хранится отдельно, у пользователя — только их id.
     Это держит /api/users и bootstrap лёгкими.                        */
  const EXCLUSIVE_THEMES = ['crimson-eclipse', 'sakura-mirage', 'emerald-abyss'];

  function badgeCatalog() {
    db.data.badgeCatalog = db.data.badgeCatalog || {};
    return db.data.badgeCatalog;
  }
  function badgesOf(u) {
    var cat = badgeCatalog();
    return (Array.isArray(u.badges) ? u.badges : [])
      .map(id => cat[id]).filter(Boolean);
  }

  /* Значки текущего пользователя загружаются после основной разметки. */
  if (route === '/api/badges/mine' && method === 'GET') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    return sendJSON(res, 200, {
      badges: badgesOf(me), dataVersion: Number(db.data.dataVersion) || 0
    });
  }

  /* каталог значков — для показа чужих значков в чатах и рейтинге */
  if (route === '/api/badges' && method === 'GET') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    return sendJSON(res, 200, {
      badges: Object.keys(badgeCatalog()).map(k => badgeCatalog()[k]),
      dataVersion: Number(db.data.dataVersion) || 0
    });
  }

  /* создать значок в каталоге (dev и патрон) */
  if (route === '/api/badges' && method === 'POST') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    if (!canAward(me)) return sendJSON(res, 403, { error: 'Нет прав на создание значков' });
    const body = await readBody(req);
    if (body && body.__tooLarge) return sendJSON(res, 413, { error: 'Файл значка слишком большой' });
    if (!body) return sendJSON(res, 400, { error: 'Некорректный запрос' });
    const image = String(body.image || '');
    if (!/^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,/.test(image)) {
      return sendJSON(res, 400, { error: 'Нужен файл изображения (PNG, JPG, WEBP, GIF, SVG)' });
    }
    const badge = {
      id: 'b_' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
      name: String(body.name || 'Значок').slice(0, 60),
      image: image.slice(0, 2 * 1024 * 1024),
      animated: /^data:image\/gif/.test(image),
      createdAt: nowISO(), by: me.login
    };
    badgeCatalog()[badge.id] = badge;
    await db.save();
    bumpDataVersion();
    return sendJSON(res, 201, { ok: true, badge, dataVersion: db.data.dataVersion });
  }

  /* удалить значок из каталога и у всех пользователей (только dev) */
  if (route.startsWith('/api/badges/') && method === 'DELETE') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    if (!canAward(me)) return sendJSON(res, 403, { error: 'Нет прав на удаление значков' });
    const id = decodeURIComponent(route.slice('/api/badges/'.length));
    if (!badgeCatalog()[id]) return sendJSON(res, 404, { error: 'Значок не найден' });
    delete badgeCatalog()[id];
    db.data.users.forEach(u => {
      if (Array.isArray(u.badges)) u.badges = u.badges.filter(x => x !== id);
    });
    await db.save();
    bumpDataVersion();
    return sendJSON(res, 200, { ok: true, dataVersion: db.data.dataVersion });
  }

  /* выдать или забрать значки и темы у пользователя (только dev) */
  if (route.startsWith('/api/grants/') && method === 'PUT') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    if (!canAward(me)) return sendJSON(res, 403, { error: 'Нет прав на выдачу наград' });
    const login = decodeURIComponent(route.slice('/api/grants/'.length));
    const rec = findByLogin(login);
    if (!rec) return sendJSON(res, 404, { error: 'Пользователь не найден' });
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, { error: 'Некорректный запрос' });
    if (Array.isArray(body.badges)) {
      rec.badges = body.badges.filter(id => !!badgeCatalog()[id]).slice(0, 12);
    }
    if (Array.isArray(body.themes)) {
      rec.themes = body.themes.filter(t => EXCLUSIVE_THEMES.indexOf(t) > -1);
    }
    await db.save();
    bumpDataVersion();
    return sendJSON(res, 200, {
      ok: true, user: publicUser(rec), dataVersion: db.data.dataVersion
    });
  }

  /* ===================== РАСПИСАНИЕ ГРУППЫ =====================
     GET  /api/schedule?group=ИС-101        — читать (любой вошедший)
     PUT  /api/schedule                     — сохранить (староста/куратор своей
                                              группы либо разработчик)         */
  if (route === '/api/schedule' && method === 'GET') {
    const g = new URL(req.url, 'http://x').searchParams.get('group') || '';
    const all = db.data.schedule || {};
    return sendJSON(res, 200, {
      group: g, days: (all[g] || {}),
      dataVersion: Number(db.data.dataVersion) || 0
    });
  }

  /* Все расписания — преподаватель ищет свои пары по всем группам */
  if (route === '/api/schedule/all' && method === 'GET') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    return sendJSON(res, 200, {
      schedule: db.data.schedule || {},
      dataVersion: Number(db.data.dataVersion) || 0
    });
  }

  /* Только пары текущего преподавателя/куратора — вместо всей базы. */
  if (route === '/api/schedule/mine' && method === 'GET') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const all = db.data.schedule || {};
    if (isDev(me)) {
      return sendJSON(res, 200, { schedule: all, dataVersion: Number(db.data.dataVersion) || 0 });
    }
    const key = fioKey(me.fio), out = {};
    Object.keys(all).forEach(group => {
      const days = all[group] || {}, picked = {};
      Object.keys(days).forEach(date => {
        const list = (days[date] || []).filter(L => !L.event && fioKey(L.teacher) === key);
        if (list.length) picked[date] = list;
      });
      if (Object.keys(picked).length) out[group] = picked;
    });
    return sendJSON(res, 200, { schedule: out, dataVersion: Number(db.data.dataVersion) || 0 });
  }

  /* Участники одной группы — журналы не загружают всю базу пользователей. */
  if (route === '/api/group-users' && method === 'GET') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const group = new URL(req.url, 'http://x').searchParams.get('group') || '';
    const role = normRole(me.role);
    const allowed = role === 'dev' || role === 'teacher'
      || ((role === 'prefect' || role === 'curator') && me.group === group);
    if (!allowed) return sendJSON(res, 403, { error: 'Нет доступа к группе' });
    const users = (db.data.users || []).filter(u => u.group === group).map(u => listUser(u, me));
    return sendJSON(res, 200, {
      users, group, dataVersion: Number(db.data.dataVersion) || 0
    });
  }

  if (route === '/api/schedule' && method === 'PUT') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const myRole = normRole(me.role);
    const body = await readBody(req);
    if (body && body.__tooLarge) return sendJSON(res, 413, { error: 'Слишком большое расписание за один раз. Загружайте по семестру.' });
    if (!body) return sendJSON(res, 400, { error: 'Некорректный запрос' });
    const g = String(body.group || '').trim();
    if (!g) return sendJSON(res, 400, { error: 'Не указана группа' });
    const canEdit = myRole === 'dev'
      || ((myRole === 'prefect' || myRole === 'curator') && String(me.group || '') === g);
    if (!canEdit) return sendJSON(res, 403, { error: 'Нет прав на редактирование этой группы' });

    db.data.schedule = db.data.schedule || {};
    db.data.schedule[g] = db.data.schedule[g] || {};
    const days = body.days && typeof body.days === 'object' ? body.days : {};
    Object.keys(days).slice(0, 400).forEach(date => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      const list = Array.isArray(days[date]) ? days[date].slice(0, 12) : [];
      db.data.schedule[g][date] = list.map(L => ({
        /* slot 0 — мероприятие вне сетки пар, 1..5 — обычная пара */
        slot: L.event ? 0 : Math.min(5, Math.max(1, Number(L.slot) || 1)),
        name: String(L.name || '').slice(0, 160),
        teacher: String(L.teacher || '').slice(0, 160),
        room: String(L.room || '').slice(0, 60),
        building: String(L.building || '').slice(0, 60),
        type: String(L.type || 'Лекция').slice(0, 40),
        event: !!L.event,
        start: String(L.start || '').slice(0, 5),
        end: String(L.end || '').slice(0, 5),
        replaced: !!L.replaced,
        replacedFrom: String(L.replacedFrom || '').slice(0, 160),
        note: String(L.note || '').slice(0, 400),
        hw: String(L.hw || '').slice(0, 600)
      }));
      if (!db.data.schedule[g][date].length) delete db.data.schedule[g][date];
    });
    await db.save();
    bumpDataVersion();
    return sendJSON(res, 200, { ok: true, group: g, dataVersion: db.data.dataVersion });
  }

  /* ===================== ЖУРНАЛ: ПОСЕЩАЕМОСТЬ И ОЦЕНКИ =====================
     GET  /api/attendance?group=ИС-101   — журнал группы (вошедшим)
     PUT  /api/attendance                — сохранить отметки/оценки
     Структура: { "2026-03-02": { "login": { "1": {st:'Н', g:[5,4]} } } }   */
  if (route === '/api/attendance' && method === 'GET') {
    const g = new URL(req.url, 'http://x').searchParams.get('group') || '';
    const all = db.data.attendance || {};
    return sendJSON(res, 200, {
      group: g, days: (all[g] || {}),
      dataVersion: Number(db.data.dataVersion) || 0
    });
  }

  if (route === '/api/attendance' && method === 'PUT') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const myRole = normRole(me.role);
    const body = await readBody(req);
    if (body && body.__tooLarge) return sendJSON(res, 413, { error: 'Слишком большой объём данных' });
    if (!body) return sendJSON(res, 400, { error: 'Некорректный запрос' });
    const g = String(body.group || '').trim();
    if (!g) return sendJSON(res, 400, { error: 'Не указана группа' });
    /* Ведёт ли этот человек пары в данной группе (сверка ФИО с расписанием).
       Куратор может быть и преподавателем — тогда он правит свои пары
       в любой группе, а в своей группе остаётся полноправным куратором. */
    const groupDays = (db.data.schedule || {})[g] || {};
    const teachesHere = Object.keys(groupDays).some(d =>
      (groupDays[d] || []).some(L => !L.event && fioKey(L.teacher) === fioKey(me.fio)));
    const ownGroup = String(me.group || '') === g;

    const canEdit = myRole === 'dev'
      || myRole === 'teacher'
      || ((myRole === 'prefect' || myRole === 'curator') && ownGroup)
      || (myRole === 'curator' && teachesHere);
    if (!canEdit) return sendJSON(res, 403, { error: 'Нет прав на журнал этой группы' });

    /* Ограничение «только свои пары»: для преподавателя всегда,
       для куратора — когда он выступает преподавателем в чужой группе. */
    const lessonLimited = myRole === 'teacher' || (myRole === 'curator' && !ownGroup);

    const ownsLesson = (date, slot) => {
      const list = (groupDays[date] || []);
      const L = list.find(x => String(x.slot) === String(slot));
      return !!L && fioKey(L.teacher) === fioKey(me.fio);
    };

    /* Статус «О» (опоздал) выведен из системы. */
    const STATUS_SET = ['', 'Н', 'У', 'Б'];
    const MAX_GRADES = 8;
    db.data.attendance = db.data.attendance || {};
    db.data.attendance[g] = db.data.attendance[g] || {};
    const days = body.days && typeof body.days === 'object' ? body.days : {};
    Object.keys(days).slice(0, 400).forEach(date => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      const perUser = days[date] && typeof days[date] === 'object' ? days[date] : {};
      const existing = db.data.attendance[g][date] || {};
      /* в режиме «только свои пары» дописываем в журнал, не затирая чужие */
      const clean = lessonLimited ? JSON.parse(JSON.stringify(existing)) : {};
      Object.keys(perUser).slice(0, 200).forEach(login => {
        const slots = perUser[login] && typeof perUser[login] === 'object' ? perUser[login] : {};
        const cs = lessonLimited ? (clean[login] || {}) : {};
        Object.keys(slots).slice(0, 12).forEach(slot => {
          if (lessonLimited && !ownsLesson(date, slot)) return;   // чужая пара
          const rec = slots[slot] || {};
          const st = STATUS_SET.indexOf(String(rec.st || '')) > -1 ? String(rec.st || '') : '';
          /* Оценки ставят куратор, преподаватель и разработчик.
             Для старосты сохраняем ранее выставленные без изменений. */
          let g2;
          if (myRole === 'prefect') {
            const prev = (existing[login] || {})[String(slot)] || {};
            g2 = Array.isArray(prev.g) ? prev.g : [];
          } else {
            g2 = Array.isArray(rec.g)
              ? rec.g.map(Number).filter(n => n >= 2 && n <= 5).slice(0, MAX_GRADES) : [];
          }
          if (st || g2.length) cs[String(slot)] = { st, g: g2 };
          else delete cs[String(slot)];
        });
        if (Object.keys(cs).length) clean[String(login)] = cs;
        else delete clean[String(login)];
      });
      if (Object.keys(clean).length) db.data.attendance[g][date] = clean;
      else delete db.data.attendance[g][date];
    });
    await db.save();
    bumpDataVersion();
    return sendJSON(res, 200, { ok: true, group: g, dataVersion: db.data.dataVersion });
  }

  /* --- оформление профиля: аватар, баннер, акцент --- */
  if (route === '/api/profile' && method === 'PUT') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const body = await readBody(req);
    if (body && body.__tooLarge) return sendJSON(res, 413, { error: 'Файл слишком большой (лимит ~3 МБ)' });
    if (!body) return sendJSON(res, 400, { error: 'Некорректный запрос' });
    const img = v => (typeof v === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(v))
      ? v.slice(0, 3 * 1024 * 1024) : '';
    if (body.avatar !== undefined) me.avatar = body.avatar === '' ? '' : img(body.avatar);
    if (body.banner !== undefined) me.banner = body.banner === '' ? '' : img(body.banner);
    if (body.accent !== undefined) me.accent = String(body.accent || '').slice(0, 24);
    me.mediaVersion = Date.now();
    await db.save();
    bumpDataVersion();
    return sendJSON(res, 200, { ok: true, user: publicUser(me), dataVersion: db.data.dataVersion });
  }

  /* --- рейтинг группы: места 1..10 без ФИО --- */
  if (route === '/api/rating' && method === 'GET') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const g = new URL(req.url, 'http://x').searchParams.get('group') || me.group || '';
    const att = (db.data.attendance || {})[g] || {};
    const sch = (db.data.schedule || {})[g] || {};
    const members = (db.data.users || []).filter(u =>
      u.group === g && ['student', 'prefect'].indexOf(normRole(u.role)) > -1);

    const rows = members.map(u => {
      let sum = 0, cnt = 0, lessons = 0, miss = 0, late = 0;
      Object.keys(sch).forEach(date => {
        (sch[date] || []).forEach(L => {
          if (L.event) return;
          lessons++;
          const r = ((att[date] || {})[u.login] || {})[String(L.slot)] || {};
          (r.g || []).forEach(x => { sum += Number(x) || 0; cnt++; });
          if (r.st === 'Н' || r.st === 'У') miss++;
          if (r.st === 'О') late++;
        });
      });
      const gpa = cnt ? sum / cnt : 0;
      const attendance = lessons ? (lessons - miss) / lessons : 0;
      /* 70% успеваемость + 30% посещаемость, штраф за опоздания */
      const score = cnt || lessons
        ? (gpa / 5) * 70 + attendance * 30 - Math.min(5, late * 0.5)
        : 0;
      return {
        login: u.login,
        avatar: u.avatar
          ? ('/api/media/' + encodeURIComponent(u.id) + '/avatar?v=' + (Number(u.mediaVersion) || 1))
          : '',
        accent: u.accent || '',
        initials: String(u.fio || u.login).trim().split(/\s+/).slice(0, 2)
          .map(w => w[0] || '').join('').toUpperCase(),
        gpa: Number(gpa.toFixed(2)), attendance: Math.round(attendance * 100),
        grades: cnt, score: Number(Math.max(0, score).toFixed(2))
      };
    }).filter(r => r.grades > 0 || r.score > 0)
      .sort((a, b) => b.score - a.score || b.gpa - a.gpa);

    const top = rows.slice(0, 10).map((r, i) => ({
      place: i + 1, avatar: r.avatar, accent: r.accent, initials: r.initials,
      gpa: r.gpa, attendance: r.attendance, grades: r.grades, score: r.score,
      me: r.login === me.login
    }));
    const myIndex = rows.findIndex(r => r.login === me.login);
    return sendJSON(res, 200, {
      group: g, total: members.length, top,
      myPlace: myIndex > -1 ? myIndex + 1 : null,
      my: myIndex > -1 ? {
        gpa: rows[myIndex].gpa, attendance: rows[myIndex].attendance,
        grades: rows[myIndex].grades, score: rows[myIndex].score
      } : null
    });
  }

  /* ========================= ПОДДЕРЖКА: ЧАТЫ =========================
     GET  /api/support/chats            — список чатов (свой / все для оператора)
     GET  /api/support/chat?login=...   — сообщения конкретного чата
     POST /api/support/message          — отправить {to, text, image}
     GET  /api/support/version          — версия чатов для живого обновления  */
  function supportStore() {
    db.data.support = db.data.support || { version: 0, chats: {} };
    return db.data.support;
  }
  function chatOf(login) {
    const st = supportStore();
    st.chats[login] = st.chats[login] || { login, messages: [], updatedAt: null, unreadUser: 0, unreadStaff: 0 };
    return st.chats[login];
  }

  if (route === '/api/support/version' && method === 'GET') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const st = supportStore();
    return sendJSON(res, 200, { version: Number(st.version) || 0 });
  }

  if (route === '/api/support/chats' && method === 'GET') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const st = supportStore();
    if (isSupport(me)) {
      const list = Object.keys(st.chats).filter(l => !st.chats[l].closed).map(l => {
        const c = st.chats[l];
        const u = findByLogin(l);
        const last = c.messages[c.messages.length - 1] || null;
        return {
          login: l, fio: (u && u.fio) || l, group: (u && u.group) || '',
          role: u ? normRole(u.role) : 'student',
          last: last ? { text: String(last.text || '').slice(0, 120), at: last.at, from: last.from, image: !!last.image } : null,
          count: c.messages.length, unread: c.unreadStaff || 0, updatedAt: c.updatedAt
        };
      }).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      return sendJSON(res, 200, { chats: list, version: Number(st.version) || 0 });
    }
    const c = chatOf(me.login);
    return sendJSON(res, 200, {
      chats: [{ login: me.login, count: c.messages.length, unread: c.unreadUser || 0 }],
      version: Number(st.version) || 0
    });
  }

  if (route === '/api/support/chat' && method === 'GET') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const want = new URL(req.url, 'http://x').searchParams.get('login') || me.login;
    if (!isSupport(me) && normLogin(want) !== normLogin(me.login)) {
      return sendJSON(res, 403, { error: 'Нет доступа к чужому чату' });
    }
    const st = supportStore();
    const c = chatOf(want);
    if (isSupport(me)) c.unreadStaff = 0; else c.unreadUser = 0;
    await db.save();
    const u = findByLogin(want);
    return sendJSON(res, 200, {
      login: want, fio: (u && u.fio) || want, group: (u && u.group) || '',
      messages: c.messages, version: Number(st.version) || 0
    });
  }

  if (route === '/api/support/message' && method === 'POST') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const body = await readBody(req);
    if (body && body.__tooLarge) return sendJSON(res, 413, { error: 'Слишком большое вложение (лимит ~3 МБ)' });
    if (!body) return sendJSON(res, 400, { error: 'Некорректный запрос' });
    const staff = isSupport(me);
    const target = staff ? String(body.to || '').trim() : me.login;
    if (!target) return sendJSON(res, 400, { error: 'Не указан получатель' });
    if (staff && !findByLogin(target)) return sendJSON(res, 404, { error: 'Пользователь не найден' });

    const text = String(body.text || '').slice(0, 8000);
    const image = typeof body.image === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(body.image)
      ? body.image.slice(0, 3 * 1024 * 1024) : '';
    if (!text.trim() && !image) return sendJSON(res, 400, { error: 'Пустое сообщение' });

    const st = supportStore();
    const c = chatOf(target);
    c.messages.push({
      id: 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      from: staff ? 'staff' : 'user',
      /* В чате показываем сокращённое ФИО оператора, а не слово «Поддержка». */
      author: staff ? (shortFio(me.fio) || me.login) : (me.fio || me.login),
      authorLogin: me.login,
      text, image, at: nowISO()
    });
    if (c.messages.length > 500) c.messages = c.messages.slice(-500);
    c.updatedAt = nowISO();
    /* Новое сообщение пользователя возвращает закрытое обращение в работу. */
    if (!staff && c.closed) { c.closed = false; c.reopenedAt = nowISO(); }
    if (staff) c.unreadUser = (c.unreadUser || 0) + 1; else c.unreadStaff = (c.unreadStaff || 0) + 1;
    st.version = (Number(st.version) || 0) + 1;
    await db.save();
    return sendJSON(res, 201, { ok: true, version: st.version, message: c.messages[c.messages.length - 1] });
  }

  /* --- оператор подключился к диалогу: уведомляем пользователя --- */
  if (route === '/api/support/join' && method === 'POST') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    if (!isSupport(me)) return sendJSON(res, 403, { error: 'Только для операторов' });
    const body = await readBody(req);
    const target = String((body && body.to) || '').trim();
    if (!target || !findByLogin(target)) return sendJSON(res, 404, { error: 'Пользователь не найден' });
    const st = supportStore();
    const c = chatOf(target);
    const name = shortFio(me.fio) || me.login;
    const recent = [...c.messages].reverse()
      .find(m => m.from === 'system' && m.kind === 'join' && m.authorLogin === me.login);
    /* Не спамим: повторное уведомление не чаще раза в 15 минут. */
    if (!recent || Date.now() - new Date(recent.at).getTime() > 15 * 60 * 1000) {
      c.messages.push({
        id: 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        from: 'system', kind: 'join', author: name, authorLogin: me.login,
        text: name + ' подключился к диалогу и видит вашу переписку',
        image: '', at: nowISO()
      });
      c.updatedAt = nowISO();
      c.unreadUser = (c.unreadUser || 0) + 1;
      st.version = (Number(st.version) || 0) + 1;
      await db.save();
    }
    c.unreadStaff = 0;
    return sendJSON(res, 200, { ok: true, version: st.version });
  }

  /* --- закрыть или вернуть обращение --- */
  if (route === '/api/support/close' && method === 'POST') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    if (!isSupport(me)) return sendJSON(res, 403, { error: 'Только для операторов' });
    const body = await readBody(req);
    const target = String((body && body.to) || '').trim();
    const reopen = !!(body && body.reopen);
    if (!target || !findByLogin(target)) return sendJSON(res, 404, { error: 'Пользователь не найден' });
    const st = supportStore();
    const c = chatOf(target);
    const name = shortFio(me.fio) || me.login;
    c.closed = !reopen;
    c.closedAt = reopen ? null : nowISO();
    c.closedBy = reopen ? null : me.login;
    c.messages.push({
      id: 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      from: 'system', kind: reopen ? 'reopen' : 'close', author: name, authorLogin: me.login,
      text: reopen
        ? ('Обращение снова открыто оператором ' + name)
        : ('Обращение закрыто оператором ' + name + '. Напишите сюда снова, если вопрос вернётся.'),
      image: '', at: nowISO()
    });
    c.updatedAt = nowISO();
    c.unreadUser = (c.unreadUser || 0) + 1;
    st.version = (Number(st.version) || 0) + 1;
    await db.save();
    return sendJSON(res, 200, { ok: true, closed: c.closed, version: st.version });
  }

  /* --- действия оператора: помощь пользователю прямо из чата --- */
  if (route === '/api/support/action' && method === 'POST') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    if (!isSupport(me)) return sendJSON(res, 403, { error: 'Только для операторов' });
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, { error: 'Некорректный запрос' });
    const target = String(body.to || '').trim();
    const rec = findByLogin(target);
    if (!rec) return sendJSON(res, 404, { error: 'Пользователь не найден' });
    const st = supportStore();
    const c = chatOf(target);
    const name = shortFio(me.fio) || me.login;
    let text = '', extra = {};

    if (body.type === 'temp-password') {
      /* Временный пароль выдаётся прямо в защищённый чат пользователя. */
      const tmp = 'cid-' + crypto.randomBytes(3).toString('hex');
      rec.passHash = hashPassword(tmp);
      rec.mustChangePassword = true;
      text = 'Оператор ' + name + ' выдал временный пароль: ' + tmp
        + '\nВойдите с ним и сразу смените пароль в настройках.';
      extra = { kind: 'temp-password' };
    } else if (body.type === 'profile-check') {
      text = 'Оператор ' + name + ' просит проверить данные профиля: ФИО, группу и дату рождения.';
      extra = { kind: 'profile-check' };
    } else if (body.type === 'group-check') {
      text = 'Оператор ' + name + ' уточняет вашу группу. Текущая: '
        + (rec.group || 'не назначена') + '. Ответьте, если она указана неверно.';
      extra = { kind: 'group-check' };
    } else if (body.type === 'escalate') {
      text = 'Оператор ' + name + ' передал обращение в учебную часть. Ответ придёт сюда же.';
      extra = { kind: 'escalate' };
    } else {
      return sendJSON(res, 400, { error: 'Неизвестное действие' });
    }

    c.messages.push(Object.assign({
      id: 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      from: 'system', author: name, authorLogin: me.login,
      text, image: '', at: nowISO()
    }, extra));
    c.updatedAt = nowISO();
    c.unreadUser = (c.unreadUser || 0) + 1;
    st.version = (Number(st.version) || 0) + 1;
    await db.save();
    return sendJSON(res, 200, { ok: true, version: st.version });
  }

  /* --- режим технических работ (только dev) --- */
  if (route === '/api/maintenance' && method === 'PUT') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    if (!isDev(me)) return sendJSON(res, 403, { error: 'Требуется роль «Разработчик»' });
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, { error: 'Некорректный запрос' });
    db.data.maintenance = {
      enabled: !!body.enabled,
      message: sanitizeHTML(String(body.message || '')).slice(0, 2000),
      startedAt: body.enabled ? nowISO() : null,
      by: me.login
    };
    await db.save();
    bumpDataVersion();
    return sendJSON(res, 200, { ok: true, maintenance: db.data.maintenance, dataVersion: db.data.dataVersion });
  }

  /* --- публикация объявления всем пользователям (только dev) --- */
  if (route === '/api/notice' && method === 'POST') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    if (!isDev(me)) return sendJSON(res, 403, { error: 'Требуется роль «Разработчик»' });
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, { error: 'Некорректный запрос' });
    const html = sanitizeHTML(String(body.html || '')).slice(0, 20000);
    if (!html.replace(/<[^>]*>/g, '').trim()) return sendJSON(res, 400, { error: 'Текст объявления пуст' });
    db.data.notice = {
      active: true,
      id: 'n_' + Date.now().toString(36),
      title: sanitizeHTML(String(body.title || '')).slice(0, 200),
      html: html,
      banner: String(body.banner || '').slice(0, 2000),
      theme: ['default', 'neon', 'glass', 'danger'].indexOf(body.theme) > -1 ? body.theme : 'default',
      dismissible: body.dismissible !== false,
      createdAt: nowISO(),
      by: me.login
    };
    await db.save();
    bumpDataVersion();
    return sendJSON(res, 201, { ok: true, notice: db.data.notice, dataVersion: db.data.dataVersion });
  }

  /* --- снять объявление (только dev) --- */
  if (route === '/api/notice' && method === 'DELETE') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    if (!isDev(me)) return sendJSON(res, 403, { error: 'Требуется роль «Разработчик»' });
    db.data.notice = { active: false };
    await db.save();
    bumpDataVersion();
    return sendJSON(res, 200, { ok: true, dataVersion: db.data.dataVersion });
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

  /* --- дальше только для авторизованных (session и me уже объявлены выше) --- */

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
      users: db.data.users.map(u => listUser(u, me)),
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

  /* --- дополнительные роли: студент + оператор и т.п. (только dev) --- */
  if (/^\/api\/users\/[^/]+\/roles$/.test(route) && method === 'PUT') {
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    if (!isDev(me)) return sendJSON(res, 403, { error: 'Требуется роль «Разработчик»' });
    const login = decodeURIComponent(route.split('/')[3]);
    const rec = findByLogin(login);
    if (!rec) return sendJSON(res, 404, { error: 'Пользователь не найден' });
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, { error: 'Некорректный запрос' });
    const allowed = ['student', 'prefect', 'curator', 'teacher', 'support', 'patron', 'dev'];
    const primary = normRole(rec.role);
    /* Лимита нет: можно выдать сразу все существующие роли. */
    rec.roles = (Array.isArray(body.roles) ? body.roles : [])
      .map(normRole)
      .filter(r => allowed.indexOf(r) > -1 && r !== primary)
      .filter((r, i, a) => a.indexOf(r) === i);
    await db.save();
    bumpDataVersion();
    return sendJSON(res, 200, { ok: true, user: publicUser(rec), dataVersion: db.data.dataVersion });
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
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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
    const mustRevalidate = ['.html', '.js', '.mjs', '.css', '.webmanifest'].includes(ext);
    /* Service Worker должен управлять всем сайтом */
    if (path.basename(target) === 'sw.js') res.setHeader('Service-Worker-Allowed', '/');
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
