/* ==========================================================================
   General/notify.js — РАБОЧИЕ УВЕДОМЛЕНИЯ «Колледж·ID»
   --------------------------------------------------------------------------
   Следит за данными пользователя и присылает системные уведомления:
     • новые оценки;
     • отметки посещаемости (Н, У, Б, О);
     • изменения расписания и замены;
     • ответы поддержки;
     • объявления колледжа.

   Уважает настройки из «Настройки → Уведомления»: каждое событие можно
   отключить, есть звук и счётчик в заголовке вкладки.
   Работает, пока открыта любая вкладка сайта.
   ========================================================================== */

(function (global) {
  'use strict';

  var SNAP = 'collegeid_notify_snapshot';
  var baseTitle = document.title;
  var unread = 0;

  function opt(key) {
    try { return global.CollegeTheme ? global.CollegeTheme.get(key) !== false : true; }
    catch (e) { return true; }
  }
  function snap() {
    try { return JSON.parse(localStorage.getItem(SNAP)) || {}; } catch (e) { return {}; }
  }
  function saveSnap(s) {
    try { localStorage.setItem(SNAP, JSON.stringify(s)); } catch (e) { /* noop */ }
  }

  /* короткий сигнал без внешних файлов */
  function beep() {
    if (!opt('nSound')) return;
    try {
      var Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx(), o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
      o.start(); o.stop(ctx.currentTime + 0.32);
      setTimeout(function () { try { ctx.close(); } catch (e) {} }, 600);
    } catch (e) { /* noop */ }
  }

  function bumpTitle() {
    if (!opt('nTitle')) return;
    unread++;
    document.title = '(' + unread + ') ' + baseTitle;
  }
  global.addEventListener('focus', function () {
    unread = 0; document.title = baseTitle;
  });

  function show(title, body, o) {
    o = o || {};
    beep();
    if (document.hidden || o.force) bumpTitle();
    try {
      if (!global.Notification || Notification.permission !== 'granted') return;
      var n = new Notification(title, {
        body: body,
        icon: o.icon || '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: o.tag || 'collegeid',
        renotify: true,
        silent: true
      });
      n.onclick = function () {
        global.focus();
        if (o.url) location.href = o.url;
        n.close();
      };
      setTimeout(function () { try { n.close(); } catch (e) {} }, 12000);
    } catch (e) { /* noop */ }
  }

  /* ------------------------------------------------- наблюдение за данными */
  function digestAttendance(att, login) {
    var grades = 0, marks = 0;
    Object.keys(att || {}).forEach(function (date) {
      var rec = (att[date] || {})[login] || {};
      Object.keys(rec).forEach(function (slot) {
        var r = rec[slot] || {};
        grades += (r.g || []).length;
        if (r.st) marks++;
      });
    });
    return { grades: grades, marks: marks };
  }
  function digestSchedule(sch) {
    var n = 0, repl = 0;
    Object.keys(sch || {}).forEach(function (d) {
      (sch[d] || []).forEach(function (L) { n++; if (L.replaced) repl++; });
    });
    return { lessons: n, repl: repl };
  }

  function watch() {
    var DB = global.CollegeDB;
    if (!DB || !DB.isServer || !DB.isServer()) return;
    var s = DB.session && DB.session();
    if (!s) return;
    var me = DB.findByLogin(s.login);
    if (!me) return;
    var group = me.group || '';
    var prev = snap();

    function tick() {
      /* объявления */
      if (opt('nNotice') && DB.state) {
        var st = DB.state() || {};
        var nt = st.notice || {};
        if (nt.active && nt.id && nt.id !== prev.noticeId) {
          if (prev.noticeId !== undefined) {
            show('Объявление колледжа', (nt.title || 'Открыто новое объявление'), { tag: 'notice' });
          }
          prev.noticeId = nt.id; saveSnap(prev);
        }
      }
      /* поддержка */
      if (opt('nSupport') && DB.supportVersion) {
        DB.supportVersion().then(function (v) {
          if (v < 0) return;
          if (prev.supportVer !== undefined && v > prev.supportVer) {
            DB.supportChat().then(function (d) {
              var ms = (d && d.messages) || [];
              var last = ms[ms.length - 1];
              if (last && last.from === 'staff') {
                show('Ответ поддержки',
                  last.text ? String(last.text).slice(0, 120) : 'Прислан скриншот',
                  { tag: 'support', url: '/Students/support.html' });
              }
            });
          }
          prev.supportVer = v; saveSnap(prev);
        });
      }
      if (!group) return;
      /* оценки и посещаемость */
      if ((opt('nGrades') || opt('nAtt')) && DB.loadAttendance) {
        DB.loadAttendance(group).then(function (att) {
          var d = digestAttendance(att, me.login);
          if (prev.grades !== undefined) {
            if (opt('nGrades') && d.grades > prev.grades) {
              show('Новая оценка', 'Преподаватель выставил оценку — откройте дневник',
                { tag: 'grade', url: '/Students/diary.html' });
            }
            if (opt('nAtt') && d.marks > prev.marks) {
              show('Отметка посещаемости', 'В журнале появилась новая отметка',
                { tag: 'att', url: '/Students/diary.html' });
            }
          }
          prev.grades = d.grades; prev.marks = d.marks; saveSnap(prev);
        });
      }
      /* расписание */
      if (opt('nSched') && DB.loadSchedule) {
        DB.loadSchedule(group).then(function (sch) {
          var d = digestSchedule(sch);
          if (prev.lessons !== undefined) {
            if (d.repl > prev.repl) {
              show('Замена пары', 'В расписании появилась замена', { tag: 'sched', url: '/Students/diary.html' });
            } else if (d.lessons !== prev.lessons) {
              show('Расписание обновлено', 'Староста изменил расписание группы',
                { tag: 'sched', url: '/Students/diary.html' });
            }
          }
          prev.lessons = d.lessons; prev.repl = d.repl; saveSnap(prev);
        });
      }
    }

    tick();
    setInterval(tick, 25000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
  }

  global.CollegeNotify = { show: show, watch: watch };

  function start() {
    if (!global.CollegeDB) return;
    var ready = (global.CollegeDB.isServer && global.CollegeDB.isServer())
      ? Promise.resolve(true) : global.CollegeDB.init();
    Promise.resolve(ready).then(watch).catch(function () { /* noop */ });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

})(window);
