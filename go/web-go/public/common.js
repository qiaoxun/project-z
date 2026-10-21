/* 共用前端库：i18n、请求、SSE、棋盘渲染、提示（老师端/学生端/入口页共用） */
(function () {
  'use strict';

  var I18N = {
    zh: {
      app_title: '围棋课堂',
      connected: '已连接', disconnected: '连接中断，重连中…',
      entry_hint: '局域网围棋教学系统',
      entry_teacher: '老师端', entry_student: '学生端',
      entry_teacher_desc: '演示 · 对战 · 出题', entry_student_desc: '输入名字进入课堂',
      board: '棋盘', mode: '模式',
      mode_teaching: '教学', mode_battle: '对战', mode_study: '学习',
      rules_on: '围棋规则', rules_off: '自由摆子',
      free_color: '摆子颜色', black: '黑', white: '白',
      prev: '上一步', next: '下一步', pass: '停一手', clear_board: '清空棋盘',
      turn_black: '黑方落子', turn_white: '白方落子', captured: '提子',
      students: '学生', no_students: '暂无学生', online: '在线', offline: '离线',
      battling_tag: '对战中',
      pick_student: '选择学生', pick_teacher_color: '老师执',
      start_battle: '开始对战', end_battle: '结束对战',
      battle_between: '对局', vs: 'vs',
      your_turn: '轮到你落子', not_your_turn: '还没轮到你', wait_opponent: '等待对方落子',
      undo: '悔棋',
      study_setup_hint: '摆好棋局后点击「开始练习」，学生端将收到这份棋谱',
      study_start: '开始练习', study_resend: '重新下发棋谱', study_end: '结束练习',
      study_active_hint: '练习进行中：学生在自己的棋盘上自由操作，不会同步回老师端',
      study_wait: '老师正在出题，请稍候…',
      study_go: '已收到棋谱，请自由练习（操作仅在本机显示）',
      study_reset: '回到初始棋谱',
      teaching_hint: '教学模式：所有学生实时同步观看此棋盘',
      free_hint: '自由摆子：忽略规则，可连续摆同色棋子',
      spectating: '观战中', watch_only: '观看中，等待老师操作…',
      you_play_black: '你执黑', you_play_white: '你执白',
      teacher: '老师',
      pwd_title: '老师登录', pwd_label: '请输入老师口令', pwd_join: '进入', pwd_wrong: '口令错误',
      name_title: '学生登录', name_label: '你的名字', name_join: '进入课堂',
      name_taken: '这个名字已被使用，请换一个', name_required: '请输入名字',
      rejoin_hint: '连接已过期，重新输入名字即可回到课堂',
      hello: '你好', change_name: '换名字', current_mode: '当前模式',
      confirm_leave_battle: '对战进行中，切换模式将结束当前对局。确定切换吗？',
      confirm_end_study: '练习进行中，切换模式将结束本次练习。确定切换吗？',
      student_offline: '该学生已离线，无法开始对战',
      illegal: '这一步不能下在这里'
    },
    en: {
      app_title: 'Go Classroom',
      connected: 'Connected', disconnected: 'Reconnecting…',
      entry_hint: 'LAN Go teaching system',
      entry_teacher: 'Teacher', entry_student: 'Student',
      entry_teacher_desc: 'Demo · Battle · Exercises', entry_student_desc: 'Enter your name to join',
      board: 'Board', mode: 'Mode',
      mode_teaching: 'Teaching', mode_battle: 'Battle', mode_study: 'Study',
      rules_on: 'Go rules', rules_off: 'Free placement',
      free_color: 'Stone color', black: 'Black', white: 'White',
      prev: 'Prev', next: 'Next', pass: 'Pass', clear_board: 'Clear board',
      turn_black: 'Black to play', turn_white: 'White to play', captured: 'Captures',
      students: 'Students', no_students: 'No students yet', online: 'online', offline: 'offline',
      battling_tag: 'battling',
      pick_student: 'Choose student', pick_teacher_color: 'Teacher plays',
      start_battle: 'Start battle', end_battle: 'End battle',
      battle_between: 'Battle', vs: 'vs',
      your_turn: 'Your turn', not_your_turn: 'Not your turn yet', wait_opponent: 'Waiting for opponent',
      undo: 'Undo',
      study_setup_hint: 'Set up the position, then press "Start practice" to send it to students',
      study_start: 'Start practice', study_resend: 'Resend position', study_end: 'End practice',
      study_active_hint: 'Practice active: students play freely on their own boards, not synced back',
      study_wait: 'Teacher is preparing the exercise…',
      study_go: 'Position received — practice freely (shown on this device only)',
      study_reset: 'Reset to start',
      teaching_hint: 'Teaching: all students see this board live',
      free_hint: 'Free placement: rules off, same color can be repeated',
      spectating: 'Spectating', watch_only: 'Watching — waiting for the teacher…',
      you_play_black: 'You play Black', you_play_white: 'You play White',
      teacher: 'Teacher',
      pwd_title: 'Teacher sign-in', pwd_label: 'Enter teacher password', pwd_join: 'Sign in', pwd_wrong: 'Wrong password',
      name_title: 'Student sign-in', name_label: 'Your name', name_join: 'Join class',
      name_taken: 'This name is already taken', name_required: 'Please enter a name',
      rejoin_hint: 'Session expired — type your name to rejoin',
      hello: 'Hello', change_name: 'Change name', current_mode: 'Mode',
      confirm_leave_battle: 'A battle is in progress. Switching mode will end it. Continue?',
      confirm_end_study: 'Practice is in progress. Switching mode will end it. Continue?',
      student_offline: 'That student is offline',
      illegal: 'Cannot play there'
    }
  };

  var lang = localStorage.getItem('go-lang') || 'zh';

  function t(key) {
    var d = I18N[lang] || I18N.zh;
    if (d[key] !== undefined) return d[key];
    if (I18N.zh[key] !== undefined) return I18N.zh[key];
    return key;
  }

  function getLang() { return lang; }

  function applyI18n(root) {
    var scope = root || document;
    var list = scope.querySelectorAll('[data-i18n]');
    for (var i = 0; i < list.length; i++) {
      list[i].textContent = t(list[i].getAttribute('data-i18n'));
    }
    list = scope.querySelectorAll('[data-i18n-ph]');
    for (var j = 0; j < list.length; j++) {
      list[j].placeholder = t(list[j].getAttribute('data-i18n-ph'));
    }
    var btn = document.getElementById('lang-btn');
    if (btn) btn.textContent = (lang === 'zh') ? 'EN' : '中文';
  }

  function setLang(l) {
    lang = l;
    localStorage.setItem('go-lang', l);
    applyI18n();
    if (typeof window.onLangChange === 'function') window.onLangChange(l);
  }

  /* ---------- API 请求 ---------- */

  async function api(path, body) {
    var r = await fetch('/api/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    var d = {};
    try { d = await r.json(); } catch (e) { /* ignore */ }
    if (!r.ok) {
      var err = new Error(d.error || ('http_' + r.status));
      err.code = d.error;
      err.status = r.status;
      throw err;
    }
    return d;
  }

  /* ---------- SSE ---------- */

  function openEvents(url, h) {
    var es = new EventSource(url);
    es.onmessage = function (e) {
      var m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.type === 'state') { if (h.onState) h.onState(m.state); }
      else if (m.type === 'expired') { es.close(); if (h.onExpired) h.onExpired(); }
    };
    es.onopen = function () { if (h.onStatus) h.onStatus(true); };
    es.onerror = function () { if (h.onStatus) h.onStatus(false); };
    return es;
  }

  /* ---------- 轻提示 ---------- */

  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2500);
  }

  /* ---------- 棋盘渲染 ---------- */

  function starPoints(size) {
    var pts = [];
    if (size === 9) {
      pts = [{ x: 2, y: 2 }, { x: 6, y: 2 }, { x: 2, y: 6 }, { x: 6, y: 6 }, { x: 4, y: 4 }];
    } else if (size === 13) {
      pts = [
        { x: 3, y: 3 }, { x: 9, y: 3 }, { x: 3, y: 9 }, { x: 9, y: 9 }, { x: 6, y: 6 },
        { x: 3, y: 6 }, { x: 9, y: 6 }, { x: 6, y: 3 }, { x: 6, y: 9 }
      ];
    } else if (size === 19) {
      pts = [
        { x: 3, y: 3 }, { x: 9, y: 3 }, { x: 15, y: 3 },
        { x: 3, y: 9 }, { x: 9, y: 9 }, { x: 15, y: 9 },
        { x: 3, y: 15 }, { x: 9, y: 15 }, { x: 15, y: 15 }
      ];
    }
    return pts;
  }

  class BoardUI {
    constructor(el, onClick) {
      this.el = el;
      this.onClick = onClick;
      this.size = 0;
    }

    setSize(size) {
      if (this.size === size) return;
      this.size = size;
      this.el.innerHTML = '';
      this.el.style.gridTemplateColumns = 'repeat(' + size + ', 1fr)';
      this.el.style.gridTemplateRows = 'repeat(' + size + ', 1fr)';
      var stars = starPoints(size);
      for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
          var cell = document.createElement('div');
          cell.className = 'cell';
          cell.dataset.x = x;
          cell.dataset.y = y;
          if (y === 0) cell.classList.add('top');
          if (y === size - 1) cell.classList.add('bottom');
          if (x === 0) cell.classList.add('left');
          if (x === size - 1) cell.classList.add('right');
          if (stars.some(function (p) { return p.x === x && p.y === y; })) cell.classList.add('star-point');
          var preview = document.createElement('div');
          preview.className = 'stone preview';
          preview.style.display = 'none';
          cell.appendChild(preview);
          (function (cx, cy, self) {
            cell.addEventListener('click', function () { if (self.onClick) self.onClick(cx, cy); });
          })(x, y, this);
          this.el.appendChild(cell);
        }
      }
    }

    /* game: { board, lastMove }；opts: { interactive, previewColor } */
    render(game, opts) {
      opts = opts || {};
      var interactive = !!opts.interactive;
      var previewColor = opts.previewColor || null;
      this.el.classList.toggle('interactive', interactive);
      var cells = this.el.children;
      for (var i = 0; i < cells.length; i++) {
        var cell = cells[i];
        var x = +cell.dataset.x, y = +cell.dataset.y;
        var stone = (game && game.board && game.board[y]) ? game.board[y][x] : null;
        var old = cell.querySelector('.stone:not(.preview)');
        if (old) old.remove();
        var preview = cell.querySelector('.preview');
        if (stone) {
          var el = document.createElement('div');
          el.className = 'stone ' + stone;
          if (game.lastMove && game.lastMove.x === x && game.lastMove.y === y) el.classList.add('last-move');
          cell.appendChild(el);
          if (preview) preview.style.display = 'none';
        } else if (preview) {
          if (interactive && previewColor) {
            preview.style.display = '';
            preview.className = 'stone preview ' + previewColor;
          } else {
            preview.style.display = 'none';
          }
        }
      }
    }
  }

  window.GO_COMMON = {
    t: t, getLang: getLang, setLang: setLang, applyI18n: applyI18n,
    api: api, openEvents: openEvents, toast: toast, BoardUI: BoardUI
  };
})();
