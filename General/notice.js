/* ==========================================================================
   General/notice.js — ОПОВЕЩЕНИЯ И ТЕХНИЧЕСКИЕ РАБОТЫ «Колледж·ID»
   --------------------------------------------------------------------------
   Подключается на всех страницах после Data/users.js:

     <script src="../Data/users.js"></script>
     <script src="../General/notice.js"></script>

   Делает две вещи:
   1) если разработчик включил техработы — переводит пользователя на
      General/work.html (роль «Разработчик» продолжает работать как обычно);
   2) показывает поверх экрана объявление, опубликованное из панели:
      баннер, оформленный текст (неон/стекло/акцент), кнопка закрытия.

   Объявление запоминается по id: закрытое повторно не всплывает,
   но новое объявление показывается снова у всех пользователей.
   ========================================================================== */

(function (global) {
  'use strict';

  var SEEN_KEY = 'collegeid_notice_seen';
  var WORK_PAGE = 'work.html';
  var onWorkPage = /work\.html$/i.test(location.pathname);
  var onAuthPage = /authorization\.html$/i.test(location.pathname);

  function base() {
    /* путь к папке General/ относительно текущей страницы */
    var s = document.currentScript && document.currentScript.src;
    try { return new URL('.', s || location.href).href; }
    catch (e) { return '../General/'; }
  }

  function seen() { try { return localStorage.getItem(SEEN_KEY) || ''; } catch (e) { return ''; } }
  function markSeen(id) { try { localStorage.setItem(SEEN_KEY, id); } catch (e) { /* noop */ } }

  /* ----------------------------------------------------------- стили */
  function injectCSS() {
    if (document.getElementById('notice-css')) return;
    var css = document.createElement('style');
    css.id = 'notice-css';
    css.textContent = [
      '#notice-wrap{position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;',
      ' padding:18px;background:rgba(5,5,10,.72);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);',
      ' opacity:0;transition:opacity .35s ease}',
      '#notice-wrap.show{opacity:1}',
      '#notice-box{position:relative;width:100%;max-width:470px;max-height:88vh;overflow:auto;border-radius:26px;',
      ' background:rgba(14,14,22,.98);border:1px solid rgba(255,255,255,.12);color:#fff;',
      ' box-shadow:0 40px 90px -24px rgba(0,0,0,.85);font-family:Manrope,system-ui,sans-serif;',
      ' transform:translateY(22px) scale(.97);transition:transform .4s cubic-bezier(.22,1,.36,1)}',
      '#notice-wrap.show #notice-box{transform:none}',
      '#notice-box .nb-banner{width:100%;max-height:190px;object-fit:cover;display:block;',
      ' border-radius:26px 26px 0 0;background:rgba(255,255,255,.04)}',
      '#notice-box .nb-pad{padding:22px 22px 20px}',
      '#notice-box h3{margin:0 0 10px;font-family:Unbounded,Manrope,sans-serif;font-weight:800;',
      ' font-size:19px;line-height:1.25;overflow-wrap:anywhere}',
      '#notice-box .nb-html{font-size:14px;line-height:1.65;color:rgba(255,255,255,.75);overflow-wrap:anywhere}',
      '#notice-box .nb-html p{margin:0 0 9px}',
      '#notice-box .nb-html b,#notice-box .nb-html strong{color:#fff}',
      '#notice-box .nb-html a{color:#a5b4fc}',
      '#notice-box .nb-html img{max-width:100%;border-radius:14px;margin:8px 0}',
      '#notice-box .nb-html ul,#notice-box .nb-html ol{margin:0 0 9px;padding-left:20px}',
      '#notice-box .nb-close{margin-top:18px;width:100%;height:46px;border:0;border-radius:14px;cursor:pointer;',
      ' font-family:inherit;font-weight:700;font-size:14px;color:#fff;',
      ' background:linear-gradient(120deg,#6366f1,#a855f7);box-shadow:0 14px 30px -10px rgba(124,58,237,.55)}',
      '#notice-box .nb-close:hover{filter:brightness(1.12)}',
      '#notice-box .nb-x{position:absolute;top:12px;right:12px;width:32px;height:32px;border-radius:11px;',
      ' border:1px solid rgba(255,255,255,.14);background:rgba(10,10,16,.6);color:rgba(255,255,255,.7);',
      ' cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:17px;line-height:1}',
      '#notice-box .nb-x:hover{background:rgba(255,255,255,.12);color:#fff}',
      '#notice-box .nb-meta{margin-top:12px;font-family:"JetBrains Mono",monospace;font-size:9.5px;',
      ' letter-spacing:.2em;text-transform:uppercase;color:rgba(255,255,255,.25);text-align:center}',
      /* темы оформления */
      '#notice-box.t-neon{border-color:rgba(168,85,247,.55);box-shadow:0 0 0 1px rgba(168,85,247,.25),',
      ' 0 0 44px -6px rgba(168,85,247,.6),0 40px 90px -24px rgba(0,0,0,.85)}',
      '#notice-box.t-neon h3{color:#f0abfc;text-shadow:0 0 10px rgba(232,121,249,.75),0 0 26px rgba(168,85,247,.5)}',
      '#notice-box.t-glass{background:rgba(18,18,30,.78);backdrop-filter:blur(26px);-webkit-backdrop-filter:blur(26px);',
      ' border-color:rgba(255,255,255,.18)}',
      '#notice-box.t-danger{border-color:rgba(251,113,133,.5)}',
      '#notice-box.t-danger h3{color:#fda4af}',
      '#notice-box.t-danger .nb-close{background:linear-gradient(120deg,#f43f5e,#f59e0b);',
      ' box-shadow:0 14px 30px -10px rgba(244,63,94,.55)}',
      /* утилиты оформления текста, доступные в редакторе */
      '.nb-html .neon{color:#f0abfc;text-shadow:0 0 8px rgba(232,121,249,.85),0 0 22px rgba(168,85,247,.55)}',
      '.nb-html .neon-cyan{color:#67e8f9;text-shadow:0 0 8px rgba(34,211,238,.85),0 0 22px rgba(6,182,212,.5)}',
      '.nb-html .grad{background:linear-gradient(100deg,#818cf8,#c084fc 55%,#e879f9);',
      ' -webkit-background-clip:text;background-clip:text;color:transparent}',
      '.nb-html .hl{background:rgba(99,102,241,.22);border-radius:6px;padding:1px 6px}',
      '.nb-html .big{font-size:1.25em;font-weight:800}',
      'html.lite #notice-wrap{backdrop-filter:none}',
      'html.lite #notice-box{transition:none;transform:none}'
    ].join('\n');
    document.head.appendChild(css);
  }

  /* -------------------------------------------------------- отрисовка */
  function render(notice) {
    if (document.getElementById('notice-wrap')) return;
    injectCSS();
    var wrap = document.createElement('div');
    wrap.id = 'notice-wrap';
    var html = '<div id="notice-box" class="t-' + (notice.theme || 'default') + '">'
      + (notice.dismissible !== false ? '<button class="nb-x" aria-label="Закрыть">✕</button>' : '')
      + (notice.banner ? '<img class="nb-banner" src="' + String(notice.banner).replace(/"/g, '&quot;') + '" alt="">' : '')
      + '<div class="nb-pad">'
      + (notice.title ? '<h3>' + notice.title + '</h3>' : '')
      + '<div class="nb-html">' + (notice.html || '') + '</div>'
      + (notice.dismissible !== false ? '<button class="nb-close">Понятно</button>' : '')
      + '<div class="nb-meta">Колледж·ID · объявление</div>'
      + '</div></div>';
    wrap.innerHTML = html;
    document.body.appendChild(wrap);
    requestAnimationFrame(function () { wrap.classList.add('show'); });

    function close() {
      markSeen(notice.id || '');
      wrap.classList.remove('show');
      setTimeout(function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }, 350);
    }
    var x = wrap.querySelector('.nb-x'), b = wrap.querySelector('.nb-close');
    if (x) x.addEventListener('click', close);
    if (b) b.addEventListener('click', close);
    if (notice.dismissible !== false) {
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
      });
    }
  }

  /* ------------------------------------------------------ применение */
  function apply() {
    if (!global.CollegeDB || !CollegeDB.state) return;
    var st = CollegeDB.state() || {};
    var m = st.maintenance || {}, n = st.notice || {};

    /* технические работы */
    if (m.enabled && !onWorkPage) {
      var s = CollegeDB.session && CollegeDB.session();
      var me = s && CollegeDB.findByLogin ? CollegeDB.findByLogin(s.login) : null;
      var role = CollegeDB.normRole ? CollegeDB.normRole(me && me.role) : 'student';
      if (role !== 'dev') { location.href = base() + WORK_PAGE; return; }
    }

    /* объявление */
    if (n.active && n.id && n.id !== seen() && !onWorkPage) render(n);
  }

  function start() {
    if (!global.CollegeDB) return;
    var ready = CollegeDB.isServer && CollegeDB.isServer()
      ? Promise.resolve(true) : CollegeDB.init();
    Promise.resolve(ready)
      .then(function () { return CollegeDB.loadState ? CollegeDB.loadState() : null; })
      .then(apply)
      .catch(function () { /* сервер недоступен — работаем как обычно */ });
    if (CollegeDB.onSync) CollegeDB.onSync(apply);
    if (CollegeDB.startSync) CollegeDB.startSync(20000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  global.CollegeNotice = { apply: apply, render: render };

})(window);
