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
        if (back) { back.click(); buzz(); return; }
      }
      /* Свайп по горизонтали — соседний раздел дока. */
      var btns = [].slice.call(document.querySelectorAll('.dock-btn'));
      if (!btns.length) return;
      var i = btns.findIndex(function (b) { return b.classList.contains('on'); });
      var next = dx < 0 ? i + 1 : i - 1;
      if (i > -1 && next >= 0 && next < btns.length) { btns[next].click(); buzz(); }
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

  function boot() { applyTier(); initCapsule(); initGestures(); initNotifications(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})(window);
