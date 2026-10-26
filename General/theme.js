/* ==========================================================================
   General/theme.js — ОФОРМЛЕНИЕ «Колледж·ID»
   --------------------------------------------------------------------------
   Применяет выбранные пользователем настройки внешнего вида на всех
   страницах сайта. Подключается ПЕРВЫМ, до остальных скриптов:

     <script src="../General/theme.js"></script>

   Хранит: акцентный цвет, фон, плотность, скругления, эффекты.
   Настройки сохраняются в браузере и применяются мгновенно.
   ========================================================================== */

(function (global) {
  'use strict';

  var KEY = 'collegeid_theme';

  var ACCENTS = [
    { id: 'indigo',  name: 'Индиго',    c1: '#6366f1', c2: '#a855f7' },
    { id: 'ocean',   name: 'Океан',     c1: '#0ea5e9', c2: '#2563eb' },
    { id: 'emerald', name: 'Изумруд',   c1: '#10b981', c2: '#14b8a6' },
    { id: 'sunset',  name: 'Закат',     c1: '#f59e0b', c2: '#f43f5e' },
    { id: 'rose',    name: 'Роза',      c1: '#f43f5e', c2: '#ec4899' },
    { id: 'violet',  name: 'Фиалка',    c1: '#8b5cf6', c2: '#d946ef' },
    { id: 'lime',    name: 'Лайм',      c1: '#84cc16', c2: '#22c55e' },
    { id: 'mono',    name: 'Графит',    c1: '#64748b', c2: '#94a3b8' }
  ];

  var THEMES = [
    { id: 'midnight', name: 'Полночь', desc: 'Классический тёмный',
      preview: 'linear-gradient(135deg,#0b0b14,#15152a)', bg: '#07070d', soft: '13,13,21' },
    { id: 'obsidian', name: 'Обсидиан', desc: 'Глубокий чёрный',
      preview: 'linear-gradient(135deg,#000,#101014)', bg: '#000000', soft: '10,10,14' },
    { id: 'nebula',   name: 'Туманность', desc: 'С фиолетовым отливом',
      preview: 'linear-gradient(135deg,#0d0a1a,#1c1333)', bg: '#0a0714', soft: '18,14,32' },
    { id: 'deepsea',  name: 'Глубина', desc: 'Синие тона',
      preview: 'linear-gradient(135deg,#050b14,#0d1b2e)', bg: '#050a12', soft: '11,19,31' },
    { id: 'forest',   name: 'Хвоя', desc: 'Тёмно-зелёный',
      preview: 'linear-gradient(135deg,#06110d,#0e2019)', bg: '#050f0b', soft: '10,24,19' },
    { id: 'carbon',   name: 'Карбон', desc: 'Нейтральный серый',
      preview: 'linear-gradient(135deg,#0f0f11,#1b1b20)', bg: '#0c0c0f', soft: '22,22,27' }
  ];

  var DEFAULTS = {
    accent: 'indigo', bg: 'midnight', density: 'normal', radius: 'normal',
    anim: true, particles: true, blur: true,
    nGrades: true, nAtt: true, nSched: true, nSupport: true, nNotice: true,
    nSound: false, nTitle: true
  };

  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY)) || {};
      var out = {};
      Object.keys(DEFAULTS).forEach(function (k) {
        out[k] = (s[k] === undefined) ? DEFAULTS[k] : s[k];
      });
      return out;
    } catch (e) { return JSON.parse(JSON.stringify(DEFAULTS)); }
  }
  var cfg = load();
  var listeners = [];

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { /* noop */ }
  }

  function injectCSS() {
    if (document.getElementById('theme-css')) return;
    var st = document.createElement('style');
    st.id = 'theme-css';
    st.textContent = [
      ':root{--accent:#6366f1;--accent2:#a855f7;--bg:#07070d;--soft:13,13,21;--radius:1}',
      'body{background:var(--bg)!important}',
      /* акцент подменяет индиго/фиолетовый по всему интерфейсу */
      'html[data-accent] .text-indigo-300,html[data-accent] .text-indigo-300\\/70,',
      'html[data-accent] .text-indigo-300\\/80{color:var(--accent-l)!important}',
      'html[data-accent] .bg-indigo-500{background:var(--accent)!important}',
      'html[data-accent] .from-indigo-500{--tw-gradient-from:var(--accent)!important}',
      'html[data-accent] .to-purple-600,html[data-accent] .to-purple-500{--tw-gradient-to:var(--accent2)!important}',
      'html[data-accent] .border-indigo-400\\/25{border-color:color-mix(in srgb,var(--accent) 35%,transparent)!important}',
      /* фон карточек подстраивается под выбранную тему */
      'html[data-bg] .card{background:rgba(var(--soft),.82)!important}',
      /* плотность */
      'html[data-density="compact"]{font-size:14.5px}',
      'html[data-density="cozy"]{font-size:16.5px}',
      'html[data-density="compact"] .card{padding-top:.85rem;padding-bottom:.85rem}',
      /* скругления */
      'html[data-radius="sharp"] .card,html[data-radius="sharp"] .panel,',
      'html[data-radius="sharp"] .row,html[data-radius="sharp"] .lcard{border-radius:10px!important}',
      'html[data-radius="soft"] .card{border-radius:32px!important}',
      'html[data-radius="soft"] .panel,html[data-radius="soft"] .row{border-radius:24px!important}',
      /* выключатели эффектов */
      'html.no-anim *{animation:none!important;transition-duration:.08s!important}',
      'html.no-blur *{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}',
      'html.no-blur .card{background:rgba(var(--soft),.97)!important}',
      'html.no-particles canvas#fx{display:none!important}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);
  }

  function apply() {
    injectCSS();
    var a = ACCENTS.filter(function (x) { return x.id === cfg.accent; })[0] || ACCENTS[0];
    var t = THEMES.filter(function (x) { return x.id === cfg.bg; })[0] || THEMES[0];
    var r = document.documentElement;

    r.style.setProperty('--accent', a.c1);
    r.style.setProperty('--accent2', a.c2);
    r.style.setProperty('--accent-l', a.c2);
    r.style.setProperty('--bg', t.bg);
    r.style.setProperty('--soft', t.soft);
    r.setAttribute('data-accent', cfg.accent);
    r.setAttribute('data-bg', cfg.bg);
    r.setAttribute('data-density', cfg.density);
    r.setAttribute('data-radius', cfg.radius);
    r.classList.toggle('no-anim', cfg.anim === false);
    r.classList.toggle('no-blur', cfg.blur === false);
    r.classList.toggle('no-particles', cfg.particles === false);

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t.bg);

    listeners.forEach(function (cb) { try { cb(cfg); } catch (e) { /* noop */ } });
  }

  global.CollegeTheme = {
    ACCENTS: ACCENTS, THEMES: THEMES,
    all: function () { return JSON.parse(JSON.stringify(cfg)); },
    get: function (k) { return cfg[k]; },
    set: function (k, v) { cfg[k] = v; save(); apply(); },
    reset: function () { cfg = JSON.parse(JSON.stringify(DEFAULTS)); save(); apply(); },
    onChange: function (cb) { if (typeof cb === 'function') listeners.push(cb); }
  };

  apply();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  }

})(window);
