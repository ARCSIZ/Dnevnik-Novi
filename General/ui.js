/* ==========================================================================
   General/ui.js — НАВИГАЦИЯ, ЖЕСТЫ И ЦЕНТР УВЕДОМЛЕНИЙ
   --------------------------------------------------------------------------
   Подключается после остальных скриптов:

     <link rel="stylesheet" href="../General/liquid.css">
     <script src="../General/ui.js"></script>

   Что делает:
   1) определяет класс устройства и включает облегчённый профиль стекла;
   2) ведёт капсулу дока ТОЛЬКО через transform (анимация на композиторе);
   3) включает жесты: свайп между разделами и свайп от края — «назад»;
   4) обслуживает центр уведомлений вместо старого колокольчика.

   Важно: здесь нет SVG-фильтров и нет вложенных backdrop-filter —
   именно они раньше вызывали рывки навигации на телефонах.
   ========================================================================== */

(function (global) {
  'use strict';

  /* ------------------------------------------------- класс устройства */
  function detectTier() {
    var html = document.documentElement;
    /* Если пользователь уже выбрал лёгкий режим — ничего не навязываем. */
    if (html.classList.contains('lite')) return 'min';

    var cores = navigator.hardwareConcurrency || 4;
    var mem = navigator.deviceMemory || 4;
    var slowNet = false;
    try {
      var c = navigator.connection;
      slowNet = !!(c && (c.saveData || /2g/.test(c.effectiveType || '')));
    } catch (e) { /* noop */ }

    /* Нет поддержки backdrop-filter — стекло всё равно не отрисуется. */
    var supportsBlur = false;
    try {
      supportsBlur = CSS.supports('backdrop-filter', 'blur(1px)')
        || CSS.supports('-webkit-backdrop-filter', 'blur(1px)');
    } catch (e) { /* noop */ }

    if (!supportsBlur || slowNet || mem <= 2 || cores <= 2) return 'min';
    if (mem <= 4 || cores <= 4) return 'low';
    return 'high';
  }

  function applyTier() {
    var tier = detectTier();
    var html = document.documentElement;
    html.classList.toggle('perf-low', tier === 'low');
    html.classList.toggle('perf-min', tier === 'min');
    global.CollegeTier = tier;
  }

  /* --------------------------------------------- капсула активного пункта */
  function initCapsule() {
    var dock = document.querySelector('.dock');
    if (!dock) return;

    var cap = dock.querySelector('.dock-capsule');
    if (!cap) {
      cap = document.createElement('span');
      cap.className = 'dock-capsule';
      cap.setAttribute('aria-hidden', 'true');
      dock.prepend(cap);
    }
    /* Старые элементы прошлых версий больше не нужны. */
    var legacy = dock.querySelector('.dock-bend');
    if (legacy) legacy.remove();

    var raf = 0, lastX = null;

    function place(animate) {
      var btn = dock.querySelector('.dock-btn.on');
      if (!btn) { cap.style.opacity = '0'; return; }

      /* Ширина выставляется один раз: кнопки дока всегда равной ширины.
         Дальше двигаем только transform — вёрстка не пересчитывается. */
      var w = btn.offsetWidth;
      if (cap.offsetWidth !== w) cap.style.width = w + 'px';

      var x = btn.offsetLeft - dock.clientLeft;
      if (!animate) {
        var prev = cap.style.transition;
        cap.style.transition = 'none';
        cap.style.transform = 'translate3d(' + x + 'px,0,0)';
        cap.offsetHeight;                      // применяем до возврата анимации
        cap.style.transition = prev;
      } else {
        cap.style.transform = 'translate3d(' + x + 'px,0,0)';
        if (lastX !== null && lastX !== x && global.CollegeTier === 'high') {
          cap.classList.remove('slide');
          cap.offsetHeight;
          cap.classList.add('slide');
          setTimeout(function () { cap.classList.remove('slide'); }, 600);
        }
      }
      lastX = x;
      cap.style.opacity = '1';
    }

    function schedule(animate) {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(function () { raf = 0; place(animate); });
    }

    dock.addEventListener('click', function (e) {
      if (e.target.closest('.dock-btn')) schedule(true);
    });

    /* Следим за сменой активного пункта из кода страницы. */
    var mo = new MutationObserver(function () { schedule(true); });
    dock.querySelectorAll('.dock-btn').forEach(function (b) {
      mo.observe(b, { attributes: true, attributeFilter: ['class'] });
    });

    place(false);
    setTimeout(function () { place(false); }, 300);

    var rt = 0;
    global.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { place(false); }, 120);
    });
    global.addEventListener('orientationchange', function () {
      setTimeout(function () { place(false); }, 240);
    });

    global.CollegeDock = { sync: function () { schedule(false); } };
  }

  /* ------------------------------------------------------------- жесты */
  function initGestures() {
    if (!('ontouchstart' in global)) return;
    var x0 = 0, y0 = 0, t0 = 0, active = false;

    function skip(el) {
      return !!(el.closest && el.closest(
        'input,textarea,select,button,a,#feed,.glist,#chats,.menu,canvas,' +
        '[data-noswipe],#notifPanel,#lightbox'));
    }

    document.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1 || skip(e.target)) { active = false; return; }
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
      t0 = Date.now(); active = true;
    }, { passive: true });

    document.addEventListener('touchend', function (e) {
      if (!active) return;
      active = false;
      var t = e.changedTouches[0];
      var dx = t.clientX - x0, dy = t.clientY - y0, dt = Date.now() - t0;
      if (dt > 600 || Math.abs(dx) < 72 || Math.abs(dy) > Math.abs(dx) * 0.6) return;

      /* Свайп от левого края — «назад» на внутренних страницах. */
      if (dx > 90 && x0 < 48) {
        var back = document.getElementById('btnBack');
        if (back) { back.click(); buzz(); }
      }
      /* Свайп по категориям отключён: в дневнике свайп листает дни. */
    }, { passive: true });

    function buzz() { if (navigator.vibrate) { try { navigator.vibrate(8); } catch (e) {} } }
  }

  /* ------------------------------------------- центр уведомлений */
  var KEY = 'collegeid_notif_log';
  function log() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; }
  }
  function saveLog(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(-40))); } catch (e) { /* noop */ }
  }
  function push(item) {
    var list = log();
    list.push(Object.assign(
      { id: 'n' + Date.now(), at: new Date().toISOString(), read: false }, item));
    saveLog(list); paintBadge();
  }
  function unread() { return log().filter(function (n) { return !n.read; }).length; }

  function css() {
    if (document.getElementById('notif-css')) return;
    var s = document.createElement('style');
    s.id = 'notif-css';
    s.textContent = [
      '#notifBtn{position:relative}',
      '#notifDot{position:absolute;top:4px;right:5px;min-width:16px;height:16px;padding:0 4px;',
      ' border-radius:99px;background:#f43f5e;color:#fff;font-size:9.5px;font-weight:800;',
      ' display:none;align-items:center;justify-content:center;box-shadow:0 0 0 2px rgba(7,7,13,.9)}',
      '#notifDot.on{display:flex}',
      '#notifPanel{position:fixed;inset:0;z-index:240;display:none;',
      ' align-items:flex-start;justify-content:flex-end;padding:14px}',
      '#notifPanel.on{display:flex}',
      '#notifPanel .bg{position:absolute;inset:0;background:rgba(5,5,10,.62)}',
      '#notifPanel .box{position:relative;width:100%;max-width:400px;max-height:78vh;overflow:auto;',
      ' margin-top:58px;border-radius:24px;padding:16px;color:#fff;',
      ' background:rgba(16,16,24,.96);border:1px solid rgba(255,255,255,.14);',
      ' box-shadow:0 28px 64px -22px rgba(0,0,0,.9);font-family:Manrope,system-ui,sans-serif;',
      ' animation:nfIn .22s ease-out}',
      '@keyframes nfIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}',
      '#notifPanel h4{margin:0;font-size:15px;font-weight:800}',
      '#notifPanel .it{display:flex;gap:10px;padding:11px 12px;border-radius:14px;margin-top:8px;',
      ' background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07)}',
      '#notifPanel .it.new{border-color:rgba(var(--glow,99,102,241),.45);',
      ' background:rgba(var(--glow,99,102,241),.1)}',
      '#notifPanel .it .ic{width:32px;height:32px;flex:none;border-radius:10px;display:flex;',
      ' align-items:center;justify-content:center;background:rgba(255,255,255,.07);font-size:15px}',
      '#notifPanel .it b{display:block;font-size:13px}',
      '#notifPanel .it p{margin:2px 0 0;font-size:11.5px;line-height:1.45;color:rgba(255,255,255,.55)}',
      '#notifPanel .it time{display:block;margin-top:4px;font-family:"JetBrains Mono",monospace;',
      ' font-size:9.5px;color:rgba(255,255,255,.3)}',
      '#notifPanel .empty{padding:34px 10px;text-align:center;color:rgba(255,255,255,.4);font-size:13px}',
      '#notifPanel .act{display:flex;gap:8px;margin-top:12px}',
      '#notifPanel .act button{flex:1;height:38px;border:0;border-radius:12px;cursor:pointer;',
      ' font-family:inherit;font-weight:700;font-size:12.5px;color:#fff;background:rgba(255,255,255,.08)}',
      '#notifPanel .act button:hover{background:rgba(255,255,255,.15)}'
    ].join('\n');
    document.head.appendChild(s);
  }

  function paintBadge() {
    var dot = document.getElementById('notifDot');
    if (!dot) return;
    var n = unread();
    dot.textContent = n > 9 ? '9+' : String(n);
    dot.classList.toggle('on', n > 0);
  }

  var ICONS = {
    grade: '📊', att: '📋', sched: '🗓', support: '💬',
    chat: '✉️', notice: '📢', system: '⚙️'
  };

  function openPanel() {
    css();
    var p = document.getElementById('notifPanel');
    if (!p) {
      p = document.createElement('div');
      p.id = 'notifPanel';
      p.innerHTML = '<div class="bg"></div><div class="box"></div>';
      document.body.appendChild(p);
      p.querySelector('.bg').addEventListener('click', function () { p.classList.remove('on'); });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') p.classList.remove('on');
      });
    }
    var list = log().slice().reverse();
    function when(iso) {
      var d = new Date(iso), diff = (Date.now() - d) / 60000;
      if (diff < 1) return 'только что';
      if (diff < 60) return Math.round(diff) + ' мин назад';
      if (diff < 1440) return Math.round(diff / 60) + ' ч назад';
      return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    }
    p.querySelector('.box').innerHTML =
      '<h4>Уведомления</h4>'
      + (list.length
        ? list.map(function (n) {
          return '<div class="it' + (n.read ? '' : ' new') + '">'
            + '<span class="ic">' + (ICONS[n.type] || '🔔') + '</span>'
            + '<span style="min-width:0"><b>' + (n.title || 'Уведомление') + '</b>'
            + '<p>' + (n.body || '') + '</p>'
            + '<time>' + when(n.at) + '</time></span></div>';
        }).join('')
        : '<div class="empty">Пока ничего нового.<br>Здесь появятся оценки, замены и ответы поддержки.</div>')
      + '<div class="act"><button id="nfRead">Прочитано</button>'
      + '<button id="nfClear">Очистить</button></div>';
    p.classList.add('on');

    var r = document.getElementById('nfRead');
    if (r) r.addEventListener('click', function () {
      saveLog(log().map(function (n) { n.read = true; return n; }));
      paintBadge(); openPanel();
    });
    var c = document.getElementById('nfClear');
    if (c) c.addEventListener('click', function () { saveLog([]); paintBadge(); openPanel(); });
  }

  function initNotifications() {
    css();
    var btn = document.getElementById('notifBtn') || document.getElementById('bell');
    if (!btn) return;
    btn.id = 'notifBtn';
    if (!document.getElementById('notifDot')) {
      var dot = document.createElement('span');
      dot.id = 'notifDot';
      btn.appendChild(dot);
    }
    btn.addEventListener('click', function (e) {
      e.preventDefault(); openPanel();
      setTimeout(function () {
        saveLog(log().map(function (n) { n.read = true; return n; }));
        paintBadge();
      }, 1200);
    });
    paintBadge();
  }

  global.CollegeNotifications = { push: push, open: openPanel, unread: unread };

  /* ------------------------------------------- ЖИВОЙ DYNAMIC ISLAND */
  var BELLS = [
    { n: 1, s: 540,  e: 630,  txt: '09:00–10:30' },
    { n: 2, s: 645,  e: 735,  txt: '10:45–12:15' },
    { n: 3, s: 780,  e: 870,  txt: '13:00–14:30' },
    { n: 4, s: 880,  e: 970,  txt: '14:40–16:10' },
    { n: 5, s: 980,  e: 1070, txt: '16:20–17:50' }
  ];

  function pad2(n) { return String(n).padStart(2, '0'); }

  function todayScheduleLessons() {
    try {
      if (!global.CollegeDB || !CollegeDB.session) return [];
      var s = CollegeDB.session();
      if (!s) return [];
      var u = CollegeDB.findByLogin ? CollegeDB.findByLogin(s.login) : null;
      var grp = (u && u.group) || '';
      if (!grp || !CollegeDB.diaryCache) return [];
      var cached = CollegeDB.diaryCache(grp);
      if (!cached || !cached.schedule) return [];
      var now = new Date();
      var key = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
      return (cached.schedule[key] || []).filter(function (L) { return !L.event; });
    } catch (e) { return []; }
  }

  function currentIslandState() {
    var now = new Date();
    var mins = now.getHours() * 60 + now.getMinutes();
    var dayShort = now.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' })
      .replace('.', '');
    dayShort = dayShort.charAt(0).toUpperCase() + dayShort.slice(1);
    var dayFull = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
    dayFull = dayFull.charAt(0).toUpperCase() + dayFull.slice(1);
    var timeStr = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    var lessons = todayScheduleLessons();

    /* Проверяем, идёт ли сейчас пара или перемена */
    for (var i = 0; i < BELLS.length; i++) {
      var b = BELLS[i];
      if (mins >= b.s && mins < b.e) {
        var left = b.e - mins;
        var pct = Math.min(100, Math.max(0, Math.round(((mins - b.s) / (b.e - b.s)) * 100)));
        var found = lessons.filter(function (x) { return Number(x.slot) === b.n; })[0];
        var subj = found && found.name ? found.name : (b.n + ' пара');
        return {
          compact: b.n + ' пара · ' + left + 'м',
          dayFull: dayFull,
          timeStr: timeStr,
          statusTitle: 'Сейчас идёт ' + b.n + ' пара (' + b.txt + ')',
          statusSub: subj + ' · осталось ' + left + ' мин',
          pct: pct,
          live: true,
          mood: 'Во время пары слежу за временем 👀'
        };
      }
      if (i < BELLS.length - 1 && mins >= b.e && mins < BELLS[i + 1].s) {
        var bLeft = BELLS[i + 1].s - mins;
        return {
          compact: 'Перемена · ' + bLeft + 'м',
          dayFull: dayFull,
          timeStr: timeStr,
          statusTitle: 'Сейчас перемена',
          statusSub: 'До ' + (i + 2) + ' пары осталось ' + bLeft + ' мин',
          pct: 0,
          live: true,
          mood: 'Перемена! Можно передохнуть ☕'
        };
      }
    }

    var hour = now.getHours();
    var mood = hour < 6 ? 'Ночной дозор в острове 🌙'
      : hour < 12 ? 'Доброе утро! Готов к учебному дню ✨'
      : hour < 18 ? 'Сижу в острове, присматриваю за делами 👀'
      : 'Добрый вечер! Пары позади, отдыхаем 🎧';

    var sub = lessons.length
      ? ('По расписанию сегодня пар: ' + lessons.length)
      : (mins < BELLS[0].s ? 'Первая пара начинается в 09:00' : 'Учебные пары на сегодня завершены');

    return {
      compact: dayShort + ' · ' + timeStr,
      dayFull: dayFull,
      timeStr: timeStr,
      statusTitle: mins < BELLS[0].s ? 'До начала занятий' : 'Вне учебных пар',
      statusSub: sub,
      pct: 0,
      live: false,
      mood: mood
    };
  }

  function initLivingIsland() {
    if (document.getElementById('live-island')) return;
    if (/work\.html$/i.test(location.pathname)) return;

    var st = document.createElement('style');
    st.id = 'live-island-css';
    st.textContent = [
      '#live-island{position:fixed;left:50%;top:max(7px,calc(env(safe-area-inset-top,0px) * 0.22));',
      ' transform:translate3d(-50%,0,0);z-index:290;width:auto;min-width:168px;max-width:calc(100vw - 24px);',
      ' background:#000;color:#fff;border-radius:999px;',
      ' border:1px solid rgba(255,255,255,.15);',
      ' box-shadow:0 14px 36px -8px rgba(0,0,0,.92),0 0 0 .5px rgba(255,255,255,.08),',
      ' inset 0 1px 0 rgba(255,255,255,.18);',
      ' font-family:Manrope,system-ui,sans-serif;user-select:none;-webkit-user-select:none;',
      ' transition:width .38s cubic-bezier(.32,1.28,.38,1),border-radius .34s ease,',
      ' box-shadow .3s ease,transform .25s ease;overflow:hidden}',
      '#live-island:active:not(.open){transform:translate3d(-50%,0,0) scale(.96)}',
      '#live-island.open{width:min(352px,calc(100vw - 20px));border-radius:28px;',
      ' box-shadow:0 26px 64px -14px rgba(0,0,0,.96),0 0 0 1px rgba(var(--glow,99,102,241),.32),',
      ' inset 0 1px 0 rgba(255,255,255,.24)}',
      '#live-island .li-bar{height:36px;padding:0 13px;display:flex;align-items:center;',
      ' justify-content:space-between;gap:10px;cursor:pointer}',
      '#live-island.open .li-bar{height:44px;padding:0 15px;border-bottom:1px solid rgba(255,255,255,.08)}',
      /* Глазки существа внутри острова */
      '.li-eyes{display:inline-flex;align-items:center;gap:5px;padding:3px 5px;border-radius:99px;',
      ' background:rgba(255,255,255,.04);position:relative;flex:none}',
      '.li-eye{width:10px;height:13px;border-radius:99px;background:#fff;position:relative;',
      ' overflow:hidden;display:inline-flex;align-items:center;justify-content:center;',
      ' box-shadow:0 0 8px rgba(255,255,255,.55);',
      ' transition:transform .16s ease,height .16s ease,border-radius .16s ease,background .2s ease}',
      '#live-island.open .li-eye{width:12px;height:15px}',
      '.li-pupil{width:5px;height:6px;border-radius:99px;background:#050508;',
      ' position:relative;transition:transform .12s ease-out}',
      '.li-pupil::after{content:"";position:absolute;top:1px;left:1px;width:2px;height:2px;',
      ' border-radius:99px;background:#fff}',
      /* Моргание и эмоции */
      '.li-eyes.blink .li-eye{transform:scaleY(.08)}',
      '.li-eyes.wink .li-eye:last-child{transform:scaleY(.1)}',
      '.li-eyes.sleepy .li-eye{height:7px;border-radius:3px 3px 99px 99px;opacity:.85}',
      '.li-eyes.happy .li-eye{background:transparent;box-shadow:none;border-top:2.5px solid #a5b4fc;',
      ' border-radius:99px 99px 0 0;height:8px;transform:translateY(1px)}',
      '.li-eyes.happy .li-pupil{display:none}',
      /* Текст компактной пилюли */
      '.li-compact{font-size:11.5px;font-weight:700;letter-spacing:-.01em;color:rgba(255,255,255,.9);',
      ' white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:190px}',
      '.li-dot{width:7px;height:7px;border-radius:99px;flex:none;',
      ' background:var(--accent,#6366f1);box-shadow:0 0 8px var(--accent,#6366f1)}',
      '.li-dot.live{background:#34d399;box-shadow:0 0 10px #34d399}',
      /* Раскрытая карточка острова */
      '.li-body{display:none;padding:13px 15px 14px}',
      '#live-island.open .li-body{display:block}',
      '.li-mood{font-size:12px;color:rgba(255,255,255,.72);margin-bottom:10px;',
      ' display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.li-pet{border:0;border-radius:99px;padding:5px 10px;font-family:inherit;font-size:11px;',
      ' font-weight:700;color:#fff;cursor:pointer;flex:none;',
      ' background:linear-gradient(120deg,var(--accent,#6366f1),var(--accent2,#a855f7))}',
      '.li-pet:active{transform:scale(.94)}',
      '.li-card{padding:10px 12px;border-radius:16px;background:rgba(255,255,255,.05);',
      ' border:1px solid rgba(255,255,255,.08)}',
      '.li-day{font-size:13px;font-weight:800;color:#fff;display:flex;align-items:center;',
      ' justify-content:space-between;gap:8px}',
      '.li-time{font-family:"JetBrains Mono",monospace;font-size:12px;color:var(--accent-l,#a5b4fc)}',
      '.li-st-t{font-size:11.5px;font-weight:700;color:rgba(255,255,255,.88);margin-top:7px}',
      '.li-st-s{font-size:11px;color:rgba(255,255,255,.5);margin-top:2px}',
      '.li-prog{height:4px;border-radius:99px;background:rgba(255,255,255,.1);overflow:hidden;margin-top:8px}',
      '.li-prog i{display:block;height:100%;border-radius:99px;',
      ' background:linear-gradient(90deg,#34d399,#22d3ee);transition:width .5s ease}'
    ].join('\n');
    document.head.appendChild(st);

    var el = document.createElement('div');
    el.id = 'live-island';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Динамический остров');
    el.innerHTML =
      '<div class="li-bar" id="liBar" title="Нажмите, чтобы раскрыть остров">'
        + '<span class="li-eyes" id="liEyes">'
          + '<span class="li-eye"><span class="li-pupil"></span></span>'
          + '<span class="li-eye"><span class="li-pupil"></span></span>'
        + '</span>'
        + '<span class="li-compact" id="liCompact">—</span>'
        + '<span class="li-dot" id="liDot"></span>'
      + '</div>'
      + '<div class="li-body">'
        + '<div class="li-mood">'
          + '<span id="liMoodText">Сижу в острове 👀</span>'
          + '<button type="button" class="li-pet" id="liPet">Погладить ✨</button>'
        + '</div>'
        + '<div class="li-card">'
          + '<div class="li-day"><span id="liDayFull">—</span><span class="li-time" id="liTime">—</span></div>'
          + '<div class="li-st-t" id="liStTitle">—</div>'
          + '<div class="li-st-s" id="liStSub">—</div>'
          + '<div class="li-prog" id="liProgWrap" style="display:none"><i id="liProgBar" style="width:0%"></i></div>'
        + '</div>'
      + '</div>';
    document.body.appendChild(el);

    var eyes = document.getElementById('liEyes');
    var pupils = el.querySelectorAll('.li-pupil');
    var customMoodUntil = 0;

    function refreshIsland() {
      var info = currentIslandState();
      document.getElementById('liCompact').textContent = info.compact;
      document.getElementById('liDayFull').textContent = info.dayFull;
      document.getElementById('liTime').textContent = info.timeStr;
      document.getElementById('liStTitle').textContent = info.statusTitle;
      document.getElementById('liStSub').textContent = info.statusSub;
      document.getElementById('liDot').classList.toggle('live', !!info.live);
      if (Date.now() > customMoodUntil) {
        document.getElementById('liMoodText').textContent = info.mood;
      }
      var pw = document.getElementById('liProgWrap');
      var pb = document.getElementById('liProgBar');
      if (info.pct > 0) {
        pw.style.display = 'block';
        pb.style.width = info.pct + '%';
      } else {
        pw.style.display = 'none';
      }
      var hr = new Date().getHours();
      eyes.classList.toggle('sleepy', hr >= 23 || hr < 6);
    }

    refreshIsland();
    setInterval(function () {
      if (!document.hidden) refreshIsland();
    }, 15000);

    /* Живое моргание и взгляд по сторонам */
    function blink() {
      if (document.hidden || eyes.classList.contains('happy')) return;
      eyes.classList.add('blink');
      setTimeout(function () {
        eyes.classList.remove('blink');
        /* Иногда двойное моргание — выглядит живо */
        if (Math.random() < 0.28) {
          setTimeout(function () {
            eyes.classList.add('blink');
            setTimeout(function () { eyes.classList.remove('blink'); }, 130);
          }, 140);
        }
      }, 140);
    }
    (function scheduleBlink() {
      setTimeout(function () {
        blink();
        /* Иногда сам посматривает по сторонам, если курсор не двигают */
        if (Math.random() < 0.45) {
          var rx = ((Math.random() - 0.5) * 4).toFixed(1);
          var ry = ((Math.random() - 0.5) * 2.4).toFixed(1);
          pupils.forEach(function (p) { p.style.transform = 'translate3d(' + rx + 'px,' + ry + 'px,0)'; });
          setTimeout(function () {
            pupils.forEach(function (p) { p.style.transform = 'translate3d(0,0,0)'; });
          }, 900);
        }
        scheduleBlink();
      }, 2400 + Math.random() * 3400);
    })();

    /* Взгляд за курсором или касанием пальца */
    function lookAt(x, y) {
      var r = eyes.getBoundingClientRect();
      var cx = r.left + r.width / 2;
      var cy = r.top + r.height / 2;
      var dx = Math.max(-2.6, Math.min(2.6, (x - cx) / 70));
      var dy = Math.max(-1.8, Math.min(1.8, (y - cy) / 70));
      pupils.forEach(function (p) {
        p.style.transform = 'translate3d(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px,0)';
      });
    }
    global.addEventListener('mousemove', function (e) {
      if (global.CollegeTier === 'min') return;
      lookAt(e.clientX, e.clientY);
    }, { passive: true });
    global.addEventListener('touchstart', function (e) {
      if (e.touches && e.touches[0]) lookAt(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });

    /* Раскрытие/сворачивание острова */
    document.getElementById('liBar').addEventListener('click', function (e) {
      e.stopPropagation();
      refreshIsland();
      el.classList.toggle('open');
      eyes.classList.add('wink');
      setTimeout(function () { eyes.classList.remove('wink'); }, 260);
      if (navigator.vibrate) { try { navigator.vibrate(8); } catch (err) {} }
    });

    /* Кнопка «Погладить» — вызывает радостные глазки ^ ^ и фразу */
    var PET_PHRASES = [
      'Мур-р! Только пятёрок тебе сегодня ✨',
      'Я живу прямо в твоём острове 🖤',
      'Слежу, чтобы перемены длились дольше 😉',
      'Ты супер! Удачного учебного дня 🚀',
      'Береги силы и не забывай отдыхать ☕'
    ];
    document.getElementById('liPet').addEventListener('click', function (e) {
      e.stopPropagation();
      eyes.classList.remove('blink', 'wink', 'sleepy');
      eyes.classList.add('happy');
      customMoodUntil = Date.now() + 5000;
      var phrase = PET_PHRASES[Math.floor(Math.random() * PET_PHRASES.length)];
      document.getElementById('liMoodText').textContent = phrase;
      if (navigator.vibrate) { try { navigator.vibrate([10, 40, 12]); } catch (err) {} }
      setTimeout(function () { eyes.classList.remove('happy'); }, 1800);
    });

    document.addEventListener('click', function (e) {
      if (el.classList.contains('open') && !e.target.closest('#live-island')) {
        el.classList.remove('open');
      }
    });
  }

  function boot() {
    applyTier(); initCapsule(); initGestures(); initNotifications(); initLivingIsland();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})(window);
