/* ==========================================================================
   Data/store.js — ПЕРЕНОСНОЕ ФАЙЛОВОЕ ХРАНИЛИЩЕ (движок базы данных)
   --------------------------------------------------------------------------
   Зачем: вся база пользователей живёт внутри папки Data/ в виде обычного
   JSON-файла. Чтобы перенести проект на новый хостинг, достаточно скопировать
   папку Data/ целиком — данные, резервные копии и ключ сессий переедут вместе
   с ней. Внешний сервер БД (MySQL/PostgreSQL) не требуется.

   Возможности:
   • атомарная запись (временный файл + fsync + rename) — база не «ломается»
     даже при выключении питания в момент записи;
   • очередь записи — все изменения применяются строго по порядку;
   • автоматические резервные копии в Data/backups/ с очисткой старых;
   • восстановление после повреждённого JSON (испорченный файл сохраняется
     с расширением .corrupt-* для разбора, база стартует заново).

   Используется только сервером (server.js). Клиент его не подключает.
   ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');

function nowISO() { return new Date().toISOString(); }
function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

function createStore(opts) {
  const file = path.resolve(opts.file);
  const dir = path.dirname(file);
  const backupDir = opts.backupDir ? path.resolve(opts.backupDir) : path.join(dir, 'backups');
  const keep = Number(opts.keep) > 0 ? Number(opts.keep) : 20;
  const defaults = opts.defaults || {};

  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  /* ---------- чтение (с восстановлением) ---------- */
  function load() {
    try {
      if (!fs.existsSync(file)) return clone(defaults);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Некорректная структура');
      // дополняем недостающие поля значениями по умолчанию (миграция версий)
      const merged = clone(defaults);
      for (const k of Object.keys(parsed)) merged[k] = parsed[k];
      return merged;
    } catch (err) {
      try { fs.copyFileSync(file, file + '.corrupt-' + Date.now()); } catch (e) { /* noop */ }
      console.error('[store] ' + path.basename(file) + ' повреждён (' + err.message + '). Начинаем с чистого состояния, копия сохранена с суффиксом .corrupt-*');
      return clone(defaults);
    }
  }

  const data = load();

  /* ---------- атомарная запись ---------- */
  function atomicWrite() {
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8');
      fs.fsyncSync(fd);              // гарантируем попадание на диск
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);         // атомарная замена старого файла
  }

  /* ---------- очередь записи (строгий порядок операций) ---------- */
  let queue = Promise.resolve();

  function persist() {
    const job = () => {
      data.updatedAt = nowISO();
      atomicWrite();
    };
    queue = queue.then(job, job).catch(err => console.error('[store] Ошибка записи:', err.message));
    return queue;
  }

  /* ---------- публичное API ---------- */
  const store = {
    /** Данные базы (изменяйте внутри mutate) */
    data,

    /** Изменение с сохранением: mutate(d => { ... }) */
    mutate(fn) {
      let result;
      try { result = fn(data); }
      catch (err) { return Promise.reject(err); }
      return persist().then(() => result);
    },

    /** Немедленное сохранение текущего состояния */
    save() { return persist(); },

    /** Мгновенный снимок базы в Data/backups/ */
    backup() {
      try {
        const stamp = nowISO().replace(/[:.]/g, '-');
        const base = path.basename(file, '.json');
        const dest = path.join(backupDir, base + '-' + stamp + '.json');
        atomicWrite();                       // база актуальна
        fs.copyFileSync(file, dest);
        prune();
        return dest;
      } catch (e) { return null; }
    },

    /** Удаление старых копий, остаётся только `keep` последних */
    prune,

    /** Файл базы (для мониторинга/отладки) */
    file
  };

  function prune() {
    try {
      const base = path.basename(file, '.json');
      const list = fs.readdirSync(backupDir).filter(f => f.startsWith(base + '-')).sort();
      while (list.length > keep) fs.unlinkSync(path.join(backupDir, list.shift()));
    } catch (e) { /* noop */ }
  }

  return store;
}

module.exports = { createStore };
