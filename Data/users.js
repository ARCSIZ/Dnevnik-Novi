/* ==========================================================================
   Data/users.js — КЛИЕНТСКИЙ СЛОЙ ДАННЫХ «Колледж·ID» (гибридный адаптер)
   --------------------------------------------------------------------------
   Один и тот же интерфейс CollegeDB работает в двух режимах:

   1) СЕРВЕР (преимущественный) — если сайт отдаёт server.js (Node.js).
      Все регистрации и входы идут через REST API (/api/...), база общая
      для всех пользователей и хранится на сервере в Data/database.json.

   2) ЛОКАЛЬНЫЙ (запасной) — если сайт открыт как статика (GitHub Pages,
      открытие файла напрямую). Данные живут в localStorage браузера.

   Режим определяется автоматически при вызове init() — адаптер опрашивает
   /api/health. Страницы менять не нужно: API идентичен прежнему.

   Подключение:  <script src="../Data/users.js"></script>  →  window.CollegeDB
   ========================================================================== */

(function (global) {
  'use strict';

  /* ------------------------------------------------------------- ключи */
  var LS_USERS   = 'collegeid_users_v1';    // локальная база (режим статики)
  var LS_SESSION = 'collegeid_session';     // сессия (login + ts)
  var LS_TOKEN   = 'collegeid_token';       // токен сервера
  var LS_MIRROR  = 'collegeid_mirror_v1';   // локальная копия пользователей

  /* ------------------------------------------------------- утилиты */
  function nowISO() { return new Date().toISOString(); }
  function uid() { return 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
  function normLogin(l) { return String(l || '').trim().toLowerCase(); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function sGet(k, storage) { try { return (storage || localStorage).getItem(k); } catch (e) { return null; } }
  function sSet(k, v, storage) { try { (storage || localStorage).setItem(k, v); } catch (e) { /* noop */ } }
  function sDel(k, storage) { try { (storage || localStorage).removeItem(k); } catch (e) { /* noop */ } }

  /* ================================================== ЛОКАЛЬНЫЙ РЕЖИМ */
  var local = {
    load: function () {
      try {
        var d = JSON.parse(sGet(LS_USERS));
        if (d && Array.isArray(d.users)) return d;
      } catch (e) { /* noop */ }
      return { version: 1, updatedAt: null, users: [] };
    },
    save: function (d) { sSet(LS_USERS, JSON.stringify(d)); }
  };

  /* Хэш-фолбэк для локального режима (WebCrypto в file:// может быть недоступен) */
  function cyrb53(str, seed) {
    seed = seed >>> 0;
    var h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (var i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 'c53:' + ('00000000' + (h2 >>> 0).toString(16)).slice(-8) + ('00000000' + (h1 >>> 0).toString(16)).slice(-8);
  }
  function hashPass(password) {
    try {
      if (global.crypto && global.crypto.subtle && global.TextEncoder) {
        return global.crypto.subtle
          .digest('SHA-256', new TextEncoder().encode(String(password)))
          .then(function (buf) {
            var b = new Uint8Array(buf), hex = '';
            for (var i = 0; i < b.length; i++) hex += ('0' + b[i].toString(16)).slice(-2);
            return 's256:' + hex;
          })
          .catch(function () { return cyrb53(String(password), 0x9e3779b9); });
      }
    } catch (e) { /* noop */ }
    return Promise.resolve(cyrb53(String(password), 0x9e3779b9));
  }

  function pubLocal(u) {
    return { id: u.id, login: u.login, fio: u.fio, birth: u.birth, group: u.group,
      role: u.role || 'student', registeredAt: u.registeredAt };
  }
  function findLocal(login) {
    var l = normLogin(login);
    for (var i = 0; i < localDb.users.length; i++) {
      if (normLogin(localDb.users[i].login) === l) return localDb.users[i];
    }
    return null;
  }
  var localDb = local.load();

  /* ================================================== СЕРВЕРНЫЙ РЕЖИМ */
  var mode = 'local';        // 'local' | 'server'
  var apiBase = null;        // например "" (тот же origin) — пути абсолютные
  var token = null;
  var mirror = loadMirror(); // локальная копия пользователей для синхронных методов
  var groupsCache = mirror.groups || [];
  var currentUser = null;
  var statsCache = null;
  var initPromise = null;    // все модули страницы делят одну инициализацию
  var badgeCatalog = null;   // каталог значков (загружается по требованию)
  var myBadgesCache = [];    // значки текущего пользователя
  var LS_GRANTS = 'collegeid_grants';   // доступные темы — нужны theme.js сразу
  var teachingGroupsCache = [];

  /* Быстрый кэш крупных данных. Страница сразу рисует последний снимок,
     а сервер обновляет его в фоне (stale-while-revalidate). */
  var LS_FAST = 'collegeid_fast_data_v1';
  var fastCache = loadFastCache();
  var fastInflight = {};

  function loadFastCache() {
    try {
      var c = JSON.parse(localStorage.getItem(LS_FAST));
      if (c && typeof c === 'object') return c;
    } catch (e) { /* noop */ }
    return { schedule: {}, attendance: {}, rating: {}, groupUsers: {}, teaching: {}, support: {} };
  }
  function saveFastCache() {
    try {
      /* Не даём кэшу бесконечно расти: максимум 8 групп на раздел. */
      ['schedule', 'attendance', 'rating', 'groupUsers', 'support'].forEach(function (bucket) {
        var obj = fastCache[bucket] || {}, keys = Object.keys(obj)
          .sort(function (a, b) { return (obj[b].ts || 0) - (obj[a].ts || 0); });
        keys.slice(8).forEach(function (k) { delete obj[k]; });
      });
      localStorage.setItem(LS_FAST, JSON.stringify(fastCache));
    } catch (e) { /* quota: приложение продолжит работать без постоянного кэша */ }
  }
  function cacheGet(bucket, key) {
    var e = fastCache[bucket] && fastCache[bucket][key];
    return e && e.data !== undefined ? e : null;
  }
  function cacheSet(bucket, key, value, version) {
    fastCache[bucket] = fastCache[bucket] || {};
    fastCache[bucket][key] = {
      data: value, v: Number(version === undefined ? dataVersion : version) || 0, ts: Date.now()
    };
    saveFastCache();
  }
  function cachedRequest(bucket, key, path, pick, maxAge) {
    var cached = cacheGet(bucket, key);
    var stale = !cached || cached.v !== Number(dataVersion) || Date.now() - cached.ts > (maxAge || 60000);
    var jobKey = bucket + ':' + key;

    function fetchFresh(background) {
      if (fastInflight[jobKey]) return fastInflight[jobKey];
      fastInflight[jobKey] = request(path).then(function (d) {
        var value = pick(d);
        cacheSet(bucket, key, value, d && d.dataVersion);
        delete fastInflight[jobKey];
        if (background) setTimeout(emitSync, 0);
        return clone(value);
      }).catch(function (err) {
        delete fastInflight[jobKey];
        if (cached) return clone(cached.data);
        throw err;
      });
      return fastInflight[jobKey];
    }

    if (cached) {
      if (stale) fetchFresh(true);             // не блокирует отрисовку
      return Promise.resolve(clone(cached.data));
    }
    return fetchFresh(false);                  // первый вход: ждём сеть один раз
  }

  /* Роли: student | prefect (староста) | curator | teacher | dev */
  function normRole(role) {
    var r = String(role || 'student').toLowerCase();
    if (r === 'dev' || r === 'developer' || r === 'admin') return 'dev';
    if (r === 'prefect' || r === 'starosta') return 'prefect';
    if (r === 'curator') return 'curator';
    if (r === 'teacher') return 'teacher';
    if (r === 'support' || r === 'operator') return 'support';
    return 'student';
  }

  /* Ключ ФИО для сравнения профиля и расписания:
     «Селецкая Екатерина Леонидовна» и «Селецкая Е.Л.» → «селецкая е л» */
  function fioKey(s) {
    var p = String(s || '').replace(/\./g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!p.length) return '';
    var out = p[0].toLowerCase();
    if (p[1]) out += ' ' + p[1].charAt(0).toLowerCase();
    if (p[2]) out += ' ' + p[2].charAt(0).toLowerCase();
    return out;
  }

  function loadMirror() {
    try {
      var m = JSON.parse(sGet(LS_MIRROR));
      if (m && Array.isArray(m.users)) return m;
    } catch (e) { /* noop */ }
    return { users: [], ts: 0 };
  }
  function saveMirror() {
    sSet(LS_MIRROR, JSON.stringify({
      users: mirror.users, groups: groupsCache, dataVersion: dataVersion, ts: Date.now()
    }));
  }
  var dataVersion = Number(mirror.dataVersion) || 0;
  var syncListeners = [];     // подписчики на обновление данных
  var syncTimer = null;
  var stateCache = { maintenance: { enabled: false }, notice: { active: false } };
  var supportVersionCache = -1;

  /** Уведомить страницы: данные изменились, перерисуйте интерфейс */
  function emitSync() {
    syncListeners.forEach(function (cb) { try { cb(); } catch (e) { /* noop */ } });
  }

  /** Синхронизировать кэш с сервером, если версия данных изменилась */
  function checkVersion() {
    if (mode !== 'server') return Promise.resolve(false);
      return request('/api/version').then(function (d) {
        if (Number(d.dataVersion) !== Number(dataVersion)) {
          dataVersion = Number(d.dataVersion) || 0;
          badgeCatalog = null;     // каталог мог измениться — перечитаем лениво
          return Promise.all([
            CollegeDB.loadGroups(),
            CollegeDB.loadState(),
            request('/api/me').then(function (x) {
              if (x && x.user) {
                hydrateUser(x.user);
                /* свои значки обновляем вместе с профилем */
                return CollegeDB.loadBadgeCatalog().then(function (cat) {
                  var ids = x.user.badges || [];
                  myBadgesCache = ids.map(function (id) {
                    for (var i = 0; i < cat.length; i++) if (cat[i].id === id) return cat[i];
                    return null;
                  }).filter(Boolean);
                });
              }
            }).catch(function () { currentUser = null; })
          ]).then(function () { emitSync(); return true; });
        }
        return false;
      }).catch(function () { return false; });
  }

  /* Куда ходить за API: рассчитываем от адреса самого скрипта */
  function apiCandidates() {
    var out = ['/api/bootstrap'];
    try {
      var src = (document.currentScript && document.currentScript.src) || '';
      if (src) out.unshift(new URL('../api/bootstrap', src).href);
    } catch (e) { /* noop */ }
    return out;
  }

  function request(path, options) {
    options = options || {};
    var headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    var opts = {
      method: options.method || 'GET',
      headers: headers,
      credentials: 'same-origin',
      cache: 'no-store'
    };
    if (options.body !== undefined) opts.body = JSON.stringify(options.body);
    return fetch(apiBase + path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { var err = new Error(data && data.error ? data.error : 'HTTP ' + res.status); err.status = res.status; throw err; }
        return data;
      });
    });
  }

  function hydrateUser(user) {
    if (!user) return;
    currentUser = user;
    /* Список выданных тем кладём в отдельный ключ: theme.js читает его
       синхронно при загрузке, до ответа сервера — тема не мигает. */
    try {
      localStorage.setItem(LS_GRANTS, JSON.stringify({
        themes: user.themes || [], login: user.login
      }));
    } catch (e) { /* noop */ }
    if (global.CollegeTheme && CollegeTheme.apply) CollegeTheme.apply();
    var l = normLogin(user.login), found = false;
    mirror.users = mirror.users.map(function (u) {
      if (normLogin(u.login) === l) { found = true; return user; }
      return u;
    });
    if (!found) mirror.users.push(user);
    saveMirror();
  }

  /* --------------------------------------------------------- публичный API */
  var CollegeDB = {

    /** Текущий режим: 'server' или 'local' */
    mode: function () { return mode; },

    /** Работаем с сервером? */
    isServer: function () { return mode === 'server'; },

    /**
     * Инициализация: определяет режим и подгружает список пользователей.
     * @returns {Promise<boolean>} true, если обнаружен бэкенд
     */
    init: function () {
      if (initPromise) return initPromise;
      token = sGet(LS_TOKEN, localStorage) || sGet(LS_TOKEN, sessionStorage) || null;
      var candidates = apiCandidates();
      var tryNext = function (i) {
        if (i >= candidates.length) { mode = 'local'; return Promise.resolve(false); }
        var headers = { 'Accept': 'application/json' };
        if (token) headers.Authorization = 'Bearer ' + token;
        return fetch(candidates[i], {
          method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: headers
        })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (data) {
            if (data && data.ok && data.service === 'college-id') {
              mode = 'server';
              /* request() уже получает пути вида /api/login. Здесь нужен
                 только origin; старый код создавал /api/api/login. */
              apiBase = new URL(candidates[i], global.location.href).origin;
              /* Сервер является единственным источником истины. Удаляем
                 прежнюю браузерную БД, чтобы старые аккаунты не участвовали
                 во входе после полного сброса серверной базы. */
              localDb = { version: 1, updatedAt: nowISO(), users: [] };
              sDel(LS_USERS, localStorage);
              groupsCache = data.groups || [];
              stateCache = {
                maintenance: data.maintenance || { enabled: false },
                notice: data.notice || { active: false }
              };
              statsCache = data.stats || null;
              dataVersion = Number(data.dataVersion) || 0;
              teachingGroupsCache = data.teachingGroups || [];
              if (data.user) hydrateUser(data.user);
              saveMirror();
              emitSync();
              CollegeDB.startSync(20000);
              return true;
            }
            return tryNext(i + 1);
          })
          .catch(function () { return tryNext(i + 1); });
      };
      initPromise = tryNext(0);
      return initPromise;
    },

    /** Обновить локальную копию пользователей с сервера */
    refresh: function () {
      if (mode !== 'server') return Promise.resolve(false);
      var loadFull = function () {
        return request('/api/users').then(function (d) {
          mirror.users = d.users || [];
          if (d.dataVersion !== undefined) dataVersion = Number(d.dataVersion) || 0;
          saveMirror(); return true;
        });
      };
      var loadLogins = function () {
        return request('/api/users/logins').then(function (d) {
          var logins = d.logins || [];
          // сохраняем известные записи, добавляем новые как «пустышки» логинов
          var known = {};
          mirror.users.forEach(function (u) { known[normLogin(u.login)] = u; });
          mirror.users = logins.map(function (l) {
            return known[normLogin(l)] || { id: '', login: l, fio: l, birth: '', group: '', role: 'student', registeredAt: null };
          });
          saveMirror(); return true;
        });
      };
      return loadFull().catch(loadLogins).catch(function () { return false; });
    },

    /** Подписка на изменения данных: cb() вызывается при обновлении кэша */
    onSync: function (cb) {
      if (typeof cb === 'function') syncListeners.push(cb);
    },

    /** Перевод студента в другую группу (роль dev) */
    setGroup: function (login, group) {
      var rec = CollegeDB.findByLogin(login);
      var role = normRole(rec && rec.role);
      if (mode === 'server') {
        return request('/api/users/' + encodeURIComponent(login),
          { method: 'PUT', body: { role: role, group: String(group || '') } })
          .then(function (d) {
            var l = normLogin(login);
            mirror.users = mirror.users.map(function (u) {
              return normLogin(u.login) === l ? Object.assign({}, u, { group: String(group || '') }) : u;
            });
            if (d && d.dataVersion !== undefined) dataVersion = Number(d.dataVersion) || 0;
            saveMirror(); emitSync(); return true;
          }).catch(function () { return false; });
      }
      var u = findLocal(login);
      if (!u) return Promise.resolve(false);
      u.group = String(group || '');
      local.save(localDb);
      return Promise.resolve(true);
    },

    /* ------------------------------- расписание ------------------------------- */
    /** Загрузить расписание группы: { "2026-03-02": [ {...} ] } */
    loadSchedule: function (group) {
      if (mode !== 'server') {
        try { return Promise.resolve((JSON.parse(localStorage.getItem('collegeid_schedule')) || {})); }
        catch (e) { return Promise.resolve({}); }
      }
      return cachedRequest('schedule', String(group || ''),
        '/api/schedule?group=' + encodeURIComponent(group || ''),
        function (d) { return d.days || {}; }, 60000)
        .catch(function () { return {}; });
    },

    /** Сохранить расписание группы (староста/куратор своей группы, dev — любой) */
    saveSchedule: function (group, days) {
      if (mode !== 'server') {
        try { localStorage.setItem('collegeid_schedule', JSON.stringify(days || {})); } catch (e) { /* noop */ }
        return Promise.resolve(true);
      }
      return request('/api/schedule', { method: 'PUT', body: { group: group, days: days || {} } })
        .then(function (d) {
          if (d && d.dataVersion !== undefined) dataVersion = Number(d.dataVersion) || 0;
          cacheSet('schedule', String(group || ''), days || {}, dataVersion);
          emitSync(); return true;
        });
    },

    /**
     * Актуальные данные текущего пользователя прямо с сервера.
     * Важно для смены группы: зеркало в браузере может быть устаревшим.
     */
    me: function () {
      if (mode !== 'server') {
        var s = CollegeDB.session();
        return Promise.resolve(s ? CollegeDB.findByLogin(s.login) : null);
      }
      /* Bootstrap уже принёс актуального пользователя — не делаем второй
         запрос /api/me на критическом пути загрузки страницы. */
      if (currentUser) return Promise.resolve(clone(currentUser));
      return request('/api/me').then(function (d) {
        if (d && d.user) {
          hydrateUser(d.user);
          return d.user;
        }
        return null;
      }).catch(function () {
        var s = CollegeDB.session();
        return s ? CollegeDB.findByLogin(s.login) : null;
      });
    },

    /** Журнал посещаемости и оценок группы */
    loadAttendance: function (group) {
      if (mode !== 'server') {
        try { return Promise.resolve(JSON.parse(localStorage.getItem('collegeid_att_' + group)) || {}); }
        catch (e) { return Promise.resolve({}); }
      }
      return cachedRequest('attendance', String(group || ''),
        '/api/attendance?group=' + encodeURIComponent(group || ''),
        function (d) { return d.days || {}; }, 45000)
        .catch(function () { return {}; });
    },

    /** Сохранить журнал (староста/куратор своей группы, dev — любой) */
    saveAttendance: function (group, days) {
      if (mode !== 'server') {
        try { localStorage.setItem('collegeid_att_' + group, JSON.stringify(days || {})); } catch (e) { /* noop */ }
        return Promise.resolve(true);
      }
      return request('/api/attendance', { method: 'PUT', body: { group: group, days: days || {} } })
        .then(function (d) {
          if (d && d.dataVersion !== undefined) dataVersion = Number(d.dataVersion) || 0;
          cacheSet('attendance', String(group || ''), days || {}, dataVersion);
          emitSync(); return true;
        });
    },

    /* ------------------------------- награды ------------------------------- */
    /** Значки текущего пользователя (полные объекты) */
    myBadges: function () { return clone(myBadgesCache); },

    /** Свои значки загружаются лениво, после основной разметки. */
    loadMyBadges: function () {
      if (mode !== 'server') return Promise.resolve([]);
      if (myBadgesCache.length) return Promise.resolve(clone(myBadgesCache));
      return request('/api/badges/mine').then(function (d) {
        myBadgesCache = d.badges || [];
        return clone(myBadgesCache);
      }).catch(function () { return []; });
    },

    /** Эксклюзивные темы, выданные текущему пользователю */
    myThemes: function () {
      return (currentUser && Array.isArray(currentUser.themes)) ? currentUser.themes.slice() : [];
    },

    /** Каталог всех значков (для показа чужих значков) */
    loadBadgeCatalog: function () {
      if (mode !== 'server') return Promise.resolve([]);
      if (badgeCatalog) return Promise.resolve(clone(badgeCatalog));
      return request('/api/badges').then(function (d) {
        badgeCatalog = d.badges || [];
        return clone(badgeCatalog);
      }).catch(function () { return []; });
    },

    /** Создать значок в каталоге (dev) */
    createBadge: function (name, image) {
      return request('/api/badges', { method: 'POST', body: { name: name, image: image } })
        .then(function (d) {
          if (d.badge) { badgeCatalog = (badgeCatalog || []).concat([d.badge]); }
          emitSync(); return d.badge;
        });
    },

    /** Удалить значок из каталога и у всех (dev) */
    deleteBadge: function (id) {
      return request('/api/badges/' + encodeURIComponent(id), { method: 'DELETE' })
        .then(function () {
          badgeCatalog = (badgeCatalog || []).filter(function (b) { return b.id !== id; });
          emitSync(); return true;
        });
    },

    /** Выдать или забрать значки и темы (dev) */
    setGrants: function (login, grants) {
      return request('/api/grants/' + encodeURIComponent(login), { method: 'PUT', body: grants })
        .then(function (d) {
          if (d.user) hydrateUser(d.user);
          emitSync(); return d.user;
        });
    },

    /** Сохранить оформление профиля: {avatar, banner, accent} */
    saveProfile: function (data) {
      if (mode !== 'server') return Promise.reject(new Error('Нужен сервер'));
      return request('/api/profile', { method: 'PUT', body: data })
        .then(function (d) {
          if (d && d.user) { hydrateUser(d.user); emitSync(); }
          return d && d.user;
        });
    },

    /** Рейтинг группы: топ-10 без ФИО */
    rating: function (group) {
      if (mode !== 'server') return Promise.resolve(null);
      var key = String(group || (currentUser && currentUser.group) || 'mine');
      return cachedRequest('rating', key,
        '/api/rating' + (group ? ('?group=' + encodeURIComponent(group)) : ''),
        function (d) { return d; }, 60000)
        .catch(function () { return null; });
    },

    /* ------------------------------- поддержка ------------------------------- */
    /** Публичная статистика колледжа (без авторизации) */
    stats: function () {
      if (mode !== 'server') return Promise.resolve(null);
      if (statsCache) return Promise.resolve(clone(statsCache));
      return request('/api/stats').then(function (s) {
        statsCache = s;
        return clone(s);
      }).catch(function () { return null; });
    },

    /** Версия чатов — для живого обновления без перезагрузки */
    supportVersion: function () {
      return request('/api/support/version')
        .then(function (d) {
          var v = Number(d.version) || 0;
          if (supportVersionCache > -1 && v !== supportVersionCache) fastCache.support = {};
          supportVersionCache = v;
          return v;
        })
        .catch(function () { return -1; });
    },

    /** Список чатов: оператору — все, пользователю — свой */
    supportChats: function () {
      return request('/api/support/chats')
        .then(function (d) { return d.chats || []; })
        .catch(function () { return []; });
    },

    /** Сообщения чата (оператор указывает login собеседника) */
    supportChat: function (login) {
      var key = String(login || 'mine');
      return cachedRequest('support', key,
        '/api/support/chat' + (login ? ('?login=' + encodeURIComponent(login)) : ''),
        function (d) { return d; }, 10000)
        .catch(function () { return { messages: [] }; });
    },

    /** Отправить сообщение: {to?, text, image} */
    supportSend: function (data) {
      return request('/api/support/message', { method: 'POST', body: data })
        .then(function (d) {
          /* Следующее чтение чата обязательно идёт в сеть. */
          fastCache.support = {};
          return d.message;
        });
    },

    /* --------------------------- оповещения и техработы --------------------------- */
    /** Публичное состояние системы: {maintenance, notice} */
    state: function () { return clone(stateCache); },

    /** Загрузить состояние с сервера */
    loadState: function () {
      if (mode !== 'server') return Promise.resolve(clone(stateCache));
      return request('/api/state').then(function (d) {
        stateCache = { maintenance: d.maintenance || { enabled: false }, notice: d.notice || { active: false } };
        if (d.dataVersion !== undefined) dataVersion = Number(d.dataVersion) || 0;
        return clone(stateCache);
      }).catch(function () { return clone(stateCache); });
    },

    /** Включить/выключить технические работы (роль dev) */
    setMaintenance: function (enabled, message) {
      return request('/api/maintenance', { method: 'PUT', body: { enabled: !!enabled, message: message || '' } })
        .then(function (d) {
          stateCache.maintenance = d.maintenance;
          if (d.dataVersion !== undefined) dataVersion = Number(d.dataVersion) || 0;
          emitSync(); return true;
        });
    },

    /** Опубликовать объявление всем (роль dev) */
    publishNotice: function (data) {
      return request('/api/notice', { method: 'POST', body: data })
        .then(function (d) {
          stateCache.notice = d.notice;
          if (d.dataVersion !== undefined) dataVersion = Number(d.dataVersion) || 0;
          emitSync(); return d.notice;
        });
    },

    /** Снять объявление (роль dev) */
    clearNotice: function () {
      return request('/api/notice', { method: 'DELETE' })
        .then(function (d) {
          stateCache.notice = { active: false };
          if (d.dataVersion !== undefined) dataVersion = Number(d.dataVersion) || 0;
          emitSync(); return true;
        });
    },

    /** Текущая версия данных сервера */
    dataVersion: function () { return dataVersion; },

    /** Принудительно свериться с сервером и обновить кэш */
    sync: function () { return checkVersion(); },

    /** Запустить фоновую синхронизацию (вызывается страницами один раз) */
    startSync: function (intervalMs) {
      if (mode !== 'server' || syncTimer) return;
      var period = intervalMs || 30000;
      /* Bootstrap только что принёс актуальную версию. Не дублируем запрос
         /api/version на критическом пути — первая проверка будет по таймеру. */
      syncTimer = setInterval(checkVersion, period);
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) checkVersion();       // обновляем при возврате на вкладку
      });
      window.addEventListener('focus', function () { checkVersion(); });
      window.addEventListener('storage', function (ev) {
        if (ev && ev.key === LS_MIRROR) emitSync();  // другая вкладка того же браузера
      });
    },

    /** Все пользователи (без хэшей паролей) */
    all: function () {
      if (mode === 'server') return clone(mirror.users);
      return localDb.users.map(pubLocal);
    },

    /** Количество пользователей */
    count: function () {
      return mode === 'server' ? mirror.users.length : localDb.users.length;
    },

    /** Занят ли логин (синхронно, по локальной копии) */
    exists: function (login) {
      if (mode === 'server') {
        var l = normLogin(login);
        return mirror.users.some(function (u) { return normLogin(u.login) === l; });
      }
      return !!findLocal(login);
    },

    /** Найти пользователя по логину (без хэша) */
    findByLogin: function (login) {
      if (mode === 'server') {
        var l = normLogin(login);
        for (var i = 0; i < mirror.users.length; i++) {
          if (normLogin(mirror.users[i].login) === l) return clone(mirror.users[i]);
        }
        return null;
      }
      var u = findLocal(login);
      return u ? pubLocal(u) : null;
    },

    /**
     * Регистрация: логин, пароль, ФИО, дата рождения, группа.
     * @throws {Error} 'LOGIN_TAKEN' — логин занят
     */
    add: function (data) {
      if (mode === 'server') {
        return request('/api/register', {
          method: 'POST',
          body: { login: data.login, pass: data.pass, fio: data.fio, birth: data.birth, group: data.group }
        }).then(function (d) {
          if (d.token) { token = d.token; sSet(LS_TOKEN, token); }
          hydrateUser(d.user);
          return d.user;
        }).catch(function (err) {
          if (err && err.status === 409) throw new Error('LOGIN_TAKEN');
          throw err;
        });
      }
      /* --- локальный режим --- */
      var login = String(data.login || '').trim();
      if (findLocal(login)) return Promise.reject(new Error('LOGIN_TAKEN'));
      return hashPass(data.pass).then(function (h) {
        var user = {
          id: uid(), login: login, passHash: h,
          fio: String(data.fio || '').trim().replace(/\s+/g, ' '),
          birth: data.birth || '', group: data.group || '',
          role: 'student', registeredAt: nowISO()
        };
        localDb.users.push(user);
        localDb.updatedAt = nowISO();
        local.save(localDb);
        return pubLocal(user);
      });
    },

    /**
     * Проверка логина и пароля → пользователь или null.
     * При недоступности сервера автоматически пробует локальную базу.
     */
    verify: function (login, password) {
      if (mode === 'server') {
        return request('/api/login', { method: 'POST', body: { login: login, pass: password } })
          .then(function (d) {
            if (d.token) { token = d.token; sSet(LS_TOKEN, token); }
            hydrateUser(d.user);
            return d.user;
          })
          .catch(function (err) {
            if (err && err.status === 401) return null;      // неверные данные
            if (err && err.status === 429) return null;       // лимит попыток
            /* Если сервер уже обнаружен, не разрешаем вход через старую
               локальную копию: это создавало ложную авторизацию. */
            throw err;
          });
      }
      return verifyLocal(login, password);
    },

    /**
     * Смена роли пользователя.
     * @param {string} login  логин
     * @param {string} role   'dev' (разработчик) или 'student'
     * Локальный режим — меняет сразу. Сервер — требует, чтобы текущая
     * сессия уже имела роль разработчика.
     */
    normRole: normRole,

    roleName: function (role) {
      var map = { student: 'Студент', prefect: 'Староста', curator: 'Куратор',
        teacher: 'Преподаватель', support: 'Оператор поддержки', dev: 'Разработчик' };
      return map[normRole(role)] || 'Студент';
    },

    /** Сравнение ФИО: профиль (полное) ↔ расписание (с инициалами) */
    fioKey: fioKey,

    /** Расписания всех групп — нужно преподавателю для поиска своих пар */
    loadAllSchedules: function () {
      if (mode !== 'server') return Promise.resolve({});
      return request('/api/schedule/all')
        .then(function (d) { return d.schedule || {}; })
        .catch(function () { return {}; });
    },

    /** Группы, где текущий пользователь указан преподавателем (из bootstrap) */
    teachingGroups: function () { return teachingGroupsCache.slice(); },

    /** Только свои пары преподавателя/куратора, без расписаний всего колледжа */
    loadTeachingSchedules: function () {
      if (mode !== 'server') return Promise.resolve({});
      return cachedRequest('teaching', 'mine', '/api/schedule/mine',
        function (d) { return d.schedule || {}; }, 60000)
        .catch(function () { return {}; });
    },

    /** Участники конкретной группы; значительно легче полного /api/users */
    loadGroupUsers: function (group) {
      if (mode !== 'server') {
        return Promise.resolve(localDb.users.map(pubLocal).filter(function (u) { return u.group === group; }));
      }
      return cachedRequest('groupUsers', String(group || ''),
        '/api/group-users?group=' + encodeURIComponent(group || ''),
        function (d) { return d.users || []; }, 45000)
        .then(function (list) {
          /* Сливаем группу в зеркало, не удаляя пользователей других групп. */
          var keep = mirror.users.filter(function (u) { return u.group !== group; });
          mirror.users = keep.concat(list);
          saveMirror();
          return clone(list);
        }).catch(function () { return []; });
    },

    /** Список групп (синхронно) */
    listGroups: function () {
      return mode === 'server' ? clone(groupsCache) : clone(localDb.groups || []);
    },

    /** Загрузить справочник групп */
    loadGroups: function () {
      if (mode !== 'server') return Promise.resolve(clone(localDb.groups || []));
      return request('/api/groups').then(function (d) {
        groupsCache = d.groups || [];
        if (d.dataVersion !== undefined) dataVersion = Number(d.dataVersion) || 0;
        saveMirror();
        return clone(groupsCache);
      }).catch(function () { return clone(groupsCache); });
    },

    /** Создать группу (роль dev) */
    addGroup: function (g) {
      var item = {
        code: String(g.code || '').trim().toUpperCase(),
        name: String(g.name || '').trim(),
        course: Number(g.course) || 1
      };
      if (!item.code || !item.name) return Promise.reject(new Error('Укажите код и название'));
      if (mode === 'server') {
        return request('/api/groups', { method: 'POST', body: item })
          .then(function (d) {
            if (d.groups) groupsCache = d.groups;
            if (d.dataVersion !== undefined) dataVersion = Number(d.dataVersion) || 0;
            saveMirror(); emitSync(); return true;
          });
      }
      localDb.groups = localDb.groups || [];
      if (localDb.groups.some(function (x) { return x.code === item.code; }))
        return Promise.reject(new Error('GROUP_EXISTS'));
      localDb.groups.push(item); local.save(localDb);
      return Promise.resolve(true);
    },

    /** Удалить группу (роль dev) */
    removeGroup: function (code) {
      if (mode === 'server') {
        return request('/api/groups/' + encodeURIComponent(code), { method: 'DELETE' })
          .then(function (d) {
            if (d.groups) groupsCache = d.groups;
            if (d.dataVersion !== undefined) dataVersion = Number(d.dataVersion) || 0;
            saveMirror(); emitSync(); return true;
          })
          .catch(function () { return false; });
      }
      localDb.groups = (localDb.groups || []).filter(function (x) { return x.code !== code; });
      local.save(localDb);
      return Promise.resolve(true);
    },

    /** Создать аккаунт старосты/куратора (роль dev) */
    createUser: function (data) {
      var p = {
        login: String(data.login || '').trim(), pass: String(data.pass || ''),
        fio: String(data.fio || '').trim(), group: String(data.group || ''),
        role: normRole(data.role)
      };
      if (mode === 'server') {
        return request('/api/users', { method: 'POST', body: p }).then(function (d) {
          if (d.user) {
            mirror.users.push(d.user);
            if (d.dataVersion !== undefined) dataVersion = Number(d.dataVersion) || 0;
            saveMirror();
          }
          return d.user;
        });
      }
      if (findLocal(p.login)) return Promise.reject(new Error('LOGIN_TAKEN'));
      return hashPass(p.pass).then(function (h) {
        var u = { id: uid(), login: p.login, passHash: h, fio: p.fio || p.login,
          birth: '', group: p.group, role: p.role, registeredAt: nowISO() };
        localDb.users.push(u); local.save(localDb);
        return pubLocal(u);
      });
    },

    setRole: function (login, role) {
      var r = normRole(role);
      if (mode === 'server') {
        return request('/api/users/' + encodeURIComponent(login), { method: 'PUT', body: { role: r } })
          .then(function (d) {
            var l = normLogin(login);
            mirror.users = mirror.users.map(function (u) {
              return normLogin(u.login) === l ? Object.assign({}, u, { role: r }) : u;
            });
            if (d && d.dataVersion !== undefined) dataVersion = Number(d.dataVersion) || 0;
            saveMirror(); emitSync();
            return true;
          })
          .catch(function () { return false; });
      }
      var u = findLocal(login);
      if (!u) return Promise.resolve(false);
      u.role = r;
      local.save(localDb);
      return Promise.resolve(true);
    },

    /**
     * Сброс всей базы (удалить всех пользователей).
     * Только для разработчика (роль dev/admin) при работающем сервере.
     * Перед удалением автоматически создаётся бэкап в Data/backups/.
     */
    reset: function () {
      if (mode !== 'server') return Promise.reject(new Error('Сброс доступен только через сервер'));
      return request('/api/reset', { method: 'POST' })
        .then(function () {
          mirror.users = []; saveMirror();
          return true;
        });
    },

    /** Удаление пользователя (на сервере — только администратору) */
    remove: function (login) {
      if (mode === 'server') {
        return request('/api/users/' + encodeURIComponent(login), { method: 'DELETE' })
          .then(function () {
            var l = normLogin(login);
            mirror.users = mirror.users.filter(function (u) { return normLogin(u.login) !== l; });
            saveMirror(); return true;
          })
          .catch(function () { return false; });
      }
      var l = normLogin(login), n = localDb.users.length;
      localDb.users = localDb.users.filter(function (u) { return normLogin(u.login) !== l; });
      if (localDb.users.length !== n) { local.save(localDb); return true; }
      return false;
    },

    /** JSON локальной базы (в серверном режиме вернёт локальную копию) */
    exportJSON: function () {
      return JSON.stringify(mode === 'server'
        ? { version: 1, updatedAt: nowISO(), mode: 'mirror', users: mirror.users }
        : localDb, null, 2);
    },

    /** Скачать файл с данными. Сервер: полная база через /api/export. */
    exportFile: function () {
      if (mode === 'server') {
        return request('/api/export').then(function (data) {
          download(JSON.stringify(data, null, 2), 'college-users.json');
          return true;
        }).catch(function () {
          download(CollegeDB.exportJSON(), 'college-users-local.json');
          return false;
        });
      }
      download(CollegeDB.exportJSON(), 'college-users.json');
      return Promise.resolve(true);
    },

    /** Импорт (только локальный режим — на сервере базу переносит папка Data/) */
    importJSON: function (json) {
      if (mode === 'server') return false;
      try {
        var d = JSON.parse(json);
        if (!d || !Array.isArray(d.users)) return false;
        localDb = { version: 1, updatedAt: nowISO(), users: d.users };
        local.save(localDb);
        return true;
      } catch (e) { return false; }
    },

    /* ----------------------------------------------------------- сессия */
    /**
     * Сохранить сессию.
     * Всегда в localStorage: пользователь не должен разлогиниваться при
     * закрытии вкладки, браузера или установленного приложения.
     */
    saveSession: function (login) {
      sSet(LS_SESSION, JSON.stringify({ login: login, ts: Date.now() }), localStorage);
      sDel(LS_SESSION, sessionStorage);
      if (token) {
        sSet(LS_TOKEN, token, localStorage);
        sDel(LS_TOKEN, sessionStorage);
      }
    },

    /** Текущая сессия или null */
    session: function () {
      try {
        var raw = sGet(LS_SESSION, localStorage) || sGet(LS_SESSION, sessionStorage);
        if (raw) return JSON.parse(raw);
      } catch (e) { /* noop */ }
      return null;
    },

    /** Токен сервера (если есть) */
    getToken: function () { return token; },

    /** Завершить сессию и уведомить сервер */
    clearSession: function () {
      sDel(LS_SESSION, localStorage); sDel(LS_SESSION, sessionStorage);
      sDel(LS_TOKEN, localStorage); sDel(LS_TOKEN, sessionStorage);
      if (mode === 'server' && token) {
        request('/api/logout', { method: 'POST' }).catch(function () { /* noop */ });
      }
      token = null;
      currentUser = null;
    }
  };

  /* -------------------------------------------------------- вспомогательные */
  function verifyLocal(login, password) {
    var rec = findLocal(login);
    if (!rec) return Promise.resolve(null);
    return hashPass(password).then(function (h) {
      return h === rec.passHash ? pubLocal(rec) : null;
    });
  }

  function download(text, filename) {
    try {
      var blob = new Blob([text], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      return true;
    } catch (e) { return false; }
  }

  /* --------------------------------------------------- сид локального режима */
  if (!localDb.users.length) {
    hashPass('demo123').then(function (h) {
      localDb.users.push({
        id: uid(), login: 'demo', fio: 'Демо Студентов', birth: '2002-05-14',
        group: 'ИС-101', passHash: h, role: 'student', registeredAt: nowISO()
      });
      local.save(localDb);
    });
  }

  global.CollegeDB = CollegeDB;

})(window);
