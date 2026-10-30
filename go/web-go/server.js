#!/usr/bin/env node
/**
 * 围棋课堂 · 局域网教学服务器（零依赖）
 * 启动：node server.js [老师口令] [端口]
 *   默认口令 123456，默认端口 3000
 *
 * 通信方式：SSE 下行推送（/events）+ HTTP POST 上行操作（/api/*）
 * 全部状态存于内存，任何端刷新/重连后都会收到完整状态。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Game } = require('./public/go-engine.js');

const PASSWORD = process.argv[2] || process.env.TEACHER_PASSWORD || '123456';
const PORT = Number(process.argv[3] || process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ---------- 题库（data/problems.json 持久化，服务重启不丢） ---------- */

const BANK_FILE = path.join(__dirname, 'data', 'problems.json');

function loadBank() {
  try {
    const arr = JSON.parse(fs.readFileSync(BANK_FILE, 'utf8'));
    if (Array.isArray(arr)) return arr.filter((p) => p && p.id && p.snapshot);
  } catch (e) { /* 文件不存在或损坏：空库 */ }
  return [];
}

function saveBank() {
  fs.mkdirSync(path.dirname(BANK_FILE), { recursive: true });
  const tmp = BANK_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(hub.bank));
  fs.renameSync(tmp, BANK_FILE);
}

/* 题目列表只回元数据，不带盘面 */
function bankMeta() {
  return hub.bank.slice().reverse().map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category || '',
    note: p.note || '',
    size: p.size,
    createdAt: p.createdAt,
    hasSolution: !!(p.solution && Array.isArray(p.solution.lines) && p.solution.lines.length)
  }));
}

const cloneSolution = (s) => (s ? JSON.parse(JSON.stringify(s)) : null);

/* 当前盘面快照（题库存的就是它，学生练习收到的也是它） */
function boardSnapshot() {
  const s = hub.game.serialize();
  return {
    size: hub.size,
    board: s.board,
    currentPlayer: s.currentPlayer,
    captures: s.captures,
    lastMove: s.lastMove,
    koPoint: s.koPoint,
    passCount: s.passCount
  };
}

/* 换一盘棋：重开棋局、结束对战、退出练习、清掉正解 */
function replaceBoard(size) {
  hub.size = size;
  hub.game = new Game(size);
  hub.battle = null;
  hub.solution = null;
  if (hub.study.phase === 'active') hub.study = { phase: 'setup', snapshot: null, version: hub.study.version + 1 };
}

/* ---------- 房间状态（内存，服务重启即重置） ---------- */

const hub = {
  size: 13,
  mode: 'teaching',        // teaching | battle | study
  freeMode: false,         // 教学/学习摆棋时的「自由摆子」开关（对战模式忽略）
  game: new Game(13),
  battle: null,            // { studentId, teacherColor }
  study: { phase: 'setup', snapshot: null, version: 0 },
  solution: null,          // 当前棋局的正解（导入带分支的 SGF 时获得），随练习下发判题
  bank: loadBank(),
  students: new Map()      // id -> { id, name, token, online }
};
let teacherToken = null;

const conns = new Set();          // { res, role: 'teacher'|'student', studentId? }
const offlineTimers = new Map();  // studentId -> setTimeout 句柄（掉线宽限）

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store',
  'Connection': 'keep-alive'
};

const randToken = () => crypto.randomBytes(16).toString('hex');
const studentName = (id) => { const s = hub.students.get(id); return s ? s.name : ''; };

/* ---------- 状态广播 ---------- */

function payload() {
  return {
    type: 'state',
    state: {
      size: hub.size,
      mode: hub.mode,
      freeMode: hub.freeMode,
      game: hub.game.serialize(),
      battle: hub.battle ? {
        studentId: hub.battle.studentId,
        studentName: studentName(hub.battle.studentId),
        teacherColor: hub.battle.teacherColor
      } : null,
      study: {
        phase: hub.study.phase,
        version: hub.study.version,
        snapshot: hub.study.phase === 'active' ? hub.study.snapshot : null,
        solution: hub.study.phase === 'active' ? hub.study.solution : null
      },
      // 正解只随「练习中」的状态下发；平时只给老师端一个数量提示
      solution: hub.solution ? { lines: hub.solution.lines.length } : null,
      students: Array.from(hub.students.values())
        .map((s) => ({ id: s.id, name: s.name, online: s.online }))
    }
  };
}

function broadcast() {
  const data = 'data: ' + JSON.stringify(payload()) + '\n\n';
  for (const c of conns) {
    try { c.res.write(data); } catch (e) { /* close 事件里清理 */ }
  }
}

/* ---------- HTTP 基础设施 ---------- */

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 200000) { reject(new Error('too_large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); }
      catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); return res.end();
  }
  let p = decodeURIComponent(pathname);
  if (p === '/' || p === '') p = '/index.html';
  else if (p === '/teacher' || p === '/teacher/') p = '/teacher.html';
  else if (p === '/student' || p === '/student/') p = '/student.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

/* ---------- SSE 连接 ---------- */

function rejectSSE(res) {
  res.writeHead(200, SSE_HEADERS);
  res.write('data: ' + JSON.stringify({ type: 'expired' }) + '\n\n');
  res.end();
}

function handleEvents(req, res, q) {
  const token = q.get('token') || '';
  const studentId = q.get('studentId');
  let conn;

  if (studentId !== null && studentId !== '') {
    const s = hub.students.get(studentId);
    if (!s || s.token !== token) return rejectSSE(res);
    conn = { res, role: 'student', studentId };
    s.online = true;
    const timer = offlineTimers.get(studentId);
    if (timer) { clearTimeout(timer); offlineTimers.delete(studentId); }
  } else {
    if (!teacherToken || token !== teacherToken) return rejectSSE(res);
    conn = { res, role: 'teacher' };
  }

  res.writeHead(200, SSE_HEADERS);
  res.write('retry: 1000\n\n');
  conns.add(conn);
  try { res.write('data: ' + JSON.stringify(payload()) + '\n\n'); } catch (e) {}

  if (conn.role === 'student') broadcast(); // 通知其他人「上线」

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) {}
  }, 15000);

  req.on('close', () => {
    clearInterval(ping);
    conns.delete(conn);
    if (conn.role === 'student') {
      const stillOnline = () => Array.from(conns).some((c) => c.role === 'student' && c.studentId === conn.studentId);
      if (!stillOnline()) {
        const t = setTimeout(() => {
          offlineTimers.delete(conn.studentId);
          const s = hub.students.get(conn.studentId);
          if (s && !stillOnline()) { s.online = false; broadcast(); }
        }, 4000);
        offlineTimers.set(conn.studentId, t);
      }
    }
  });
}

/* ---------- SGF 解析（保留变化分支用于提取正解，容忍前后杂讯/截断） ---------- */

/* 解析为树：node = { props, children: [] }，主线 = 每层第一个孩子 */
function parseSgfTree(raw) {
  if (typeof raw !== 'string') return null;
  const start = raw.search(/\(\s*;/);
  if (start < 0) return null;
  let i = start;
  const n = raw.length;
  const skipWs = () => { while (i < n && /\s/.test(raw[i])) i++; };
  const readValue = () => { // raw[i] === '['
    let v = '';
    i++;
    while (i < n) {
      const c = raw[i];
      if (c === '\\') { i++; if (i < n) { v += raw[i]; i++; } continue; }
      if (c === ']') { i++; break; }
      v += c; i++;
    }
    return v;
  };
  const readNode = () => {
    i++; // ';'
    const node = { props: {}, children: [] };
    skipWs();
    while (i < n && /[A-Za-z]/.test(raw[i])) {
      let key = '';
      while (i < n && /[A-Za-z]/.test(raw[i])) key += raw[i++];
      const vals = [];
      skipWs();
      while (i < n && raw[i] === '[') vals.push(readValue());
      if (vals.length) {
        key = key.toUpperCase();
        node.props[key] = (node.props[key] || []).concat(vals);
      }
      skipWs();
    }
    return node;
  };

  function parseVariation() {
    skipWs();
    if (raw[i] !== '(') return null;
    i++;
    skipWs();
    if (raw[i] !== ';') {
      // 容错：不是节点序列就整段平衡跳过
      let d = 0;
      while (i < n) {
        const c = raw[i];
        if (c === '[') { readValue(); continue; }
        if (c === '(') d++;
        else if (c === ')') { if (d === 0) { i++; break; } d--; }
        i++;
      }
      return null;
    }
    const first = readNode();
    let last = first;
    for (;;) {
      skipWs();
      const c = raw[i];
      if (c === ';') {
        const nx = readNode();
        last.children.push(nx);
        last = nx;
      } else if (c === '(') {
        const sub = parseVariation();
        if (sub) last.children.push(sub);
      } else {
        break; // ')' 或结尾
      }
    }
    if (raw[i] === ')') i++;
    return first;
  }

  return parseVariation();
}

/* 节点上的着手（B/W），容忍坐标垃圾值（转成不可落子的 -1） */
function movesOfNode(node, size) {
  const ms = [];
  for (const key of ['B', 'W']) {
    const v = node.props[key] && node.props[key][0];
    if (v === undefined) continue;
    const isPass = v === '' || (size <= 19 && v === 'tt');
    let p = null;
    if (!isPass && v.length >= 2) p = { x: v.charCodeAt(0) - 97, y: v.charCodeAt(1) - 97 };
    ms.push({
      color: key === 'B' ? 'black' : 'white',
      pass: isPass,
      x: p ? p.x : -1,
      y: p ? p.y : -1
    });
  }
  return ms;
}

/* 从树提取主线（摆盘用），并从第一层分支提取正解（判题用） */
function parseSgf(raw) {
  const root = parseSgfTree(raw);
  if (!root) return null;

  const result = { size: 19, setup: [], moves: [], playerToMove: null, solution: null };
  const sz = root.props.SZ && root.props.SZ[0];
  if (sz) {
    const s = parseInt(sz, 10);
    if (s >= 2 && s <= 25) result.size = s;
  }
  if (root.props.PL && root.props.PL[0]) {
    result.playerToMove = root.props.PL[0].toLowerCase() === 'w' ? 'white' : 'black';
  }

  // 主线：沿第一个孩子走到底。首个着手之前的 AB/AW 都算摆子。
  let sawMove = false;
  for (let nd = root; nd; nd = nd.children[0]) {
    if (nd.props.B || nd.props.W) sawMove = true;
    if (!sawMove) {
      for (const v of (nd.props.AB || [])) {
        const p = { x: v.charCodeAt(0) - 97, y: v.charCodeAt(1) - 97 };
        if (p.x >= 0 && p.y >= 0) result.setup.push({ x: p.x, y: p.y, color: 'black' });
      }
      for (const v of (nd.props.AW || [])) {
        const p = { x: v.charCodeAt(0) - 97, y: v.charCodeAt(1) - 97 };
        if (p.x >= 0 && p.y >= 0) result.setup.push({ x: p.x, y: p.y, color: 'white' });
      }
    }
    for (const m of movesOfNode(nd, result.size)) result.moves.push(m);
  }
  if (!result.setup.length && !result.moves.length) return null;

  /* 正解：首个着手节点的父节点是分叉点，其每个孩子沿主线到底即一条正解线。
     若 SGF 用注释标了正解（goproblems 等题库惯例：C[RIGHT]/C[正解]），只认标记线；
     否则约定第一个分支为主线正解，其余第一层分支为备选正解。
     只保留「先行颜色 = 出题方」且坐标合法的线。 */
  let prev = null, cur = root;
  while (cur && !(cur.props.B || cur.props.W)) { prev = cur; cur = cur.children[0]; }
  if (cur) {
    const walkLine = (start) => {
      const moves = [];
      let marked = false;
      for (let nd = start; nd; nd = nd.children[0]) {
        const c = nd.props.C && nd.props.C[0];
        if (c && /right|正解|正确/i.test(c)) marked = true;
        for (const m of movesOfNode(nd, result.size)) moves.push(m);
      }
      return { moves, marked };
    };
    let rawLines = prev ? prev.children.map(walkLine) : [walkLine(cur)];
    rawLines = rawLines.filter((l) => l.moves.length);
    if (rawLines.some((l) => l.marked)) rawLines = rawLines.filter((l) => l.marked);
    const solver = result.playerToMove ||
      (rawLines[0] && rawLines[0].moves[0] && rawLines[0].moves[0].color);
    const valid = (ms) => ms.every((m) => m.pass || (m.x >= 0 && m.x < result.size && m.y >= 0 && m.y < result.size));
    const lines = rawLines
      .map((l) => l.moves)
      .filter((ms) => !ms[0].pass && ms[0].color === solver && valid(ms));
    if (solver && lines.length) result.solution = { playerToMove: solver, lines };
  }

  return result;
}

/* ---------- 权限辅助 ---------- */

const isTeacher = (b) => !!teacherToken && !!b && b.token === teacherToken;

function authStudent(b) {
  if (!b || !b.studentId) return null;
  const s = hub.students.get(String(b.studentId));
  return (s && b.token === s.token) ? s : null;
}

function intCoord(v) {
  if (Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return parseInt(v, 10);
  return NaN;
}

/* ---------- API ---------- */

const api = {};

api['teacher/auth'] = (body) => {
  if (String(body.password || '') !== PASSWORD) return [401, { error: 'wrong_password' }];
  teacherToken = randToken();
  return [200, { ok: true, token: teacherToken }];
};

api['join'] = (body) => {
  const name = String(body.name || '').trim().slice(0, 20);
  let s = body.id ? hub.students.get(String(body.id)) : null;

  if (s && body.token && body.token === s.token) {
    // 重连（同一学生），如改名则检查重名
    if (name && name !== s.name) {
      for (const o of hub.students.values()) {
        if (o.id !== s.id && o.name === name) return [409, { error: 'name_taken' }];
      }
      s.name = name;
    }
  } else {
    // 新学生注册（服务重启后旧 id 失效也走这里）
    if (!name) return [400, { error: 'name_required' }];
    for (const o of hub.students.values()) {
      if (o.name === name) return [409, { error: 'name_taken' }];
    }
    s = { id: crypto.randomBytes(8).toString('hex'), name, token: randToken(), online: false };
    hub.students.set(s.id, s);
  }
  broadcast();
  return [200, { ok: true, studentId: s.id, token: s.token, name: s.name }];
};

api['move'] = (body) => {
  const x = intCoord(body.x), y = intCoord(body.y);
  if (!hub.game.isValidPos(x, y)) return [400, { error: 'bad_coord' }];

  if (isTeacher(body)) {
    if (hub.mode === 'battle') {
      if (!hub.battle) return [403, { error: 'no_battle' }];
      if (hub.battle.teacherColor !== hub.game.currentPlayer) return [403, { error: 'not_your_turn' }];
      if (!hub.game.place(x, y)) return [409, { error: 'illegal' }];
    } else if (hub.freeMode) {
      if (body.color !== 'black' && body.color !== 'white') return [400, { error: 'bad_color' }];
      if (!hub.game.placeFree(x, y, body.color)) return [409, { error: 'illegal' }];
    } else {
      if (!hub.game.place(x, y)) return [409, { error: 'illegal' }];
    }
    broadcast();
    return [200, { ok: true }];
  }

  const s = authStudent(body);
  if (!s) return [401, { error: 'unauthorized' }];
  if (!(hub.mode === 'battle' && hub.battle && hub.battle.studentId === s.id)) {
    return [403, { error: 'not_allowed' }];
  }
  const myColor = hub.battle.teacherColor === 'black' ? 'white' : 'black';
  if (myColor !== hub.game.currentPlayer) return [403, { error: 'not_your_turn' }];
  if (!hub.game.place(x, y)) return [409, { error: 'illegal' }];
  broadcast();
  return [200, { ok: true }];
};

api['pass'] = (body) => {
  if (isTeacher(body)) {
    if (hub.mode === 'battle') {
      if (!hub.battle) return [403, { error: 'no_battle' }];
      if (hub.battle.teacherColor !== hub.game.currentPlayer) return [403, { error: 'not_your_turn' }];
    }
    hub.game.pass();
    broadcast();
    return [200, { ok: true }];
  }
  const s = authStudent(body);
  if (!s) return [401, { error: 'unauthorized' }];
  if (!(hub.mode === 'battle' && hub.battle && hub.battle.studentId === s.id)) {
    return [403, { error: 'not_allowed' }];
  }
  const myColor = hub.battle.teacherColor === 'black' ? 'white' : 'black';
  if (myColor !== hub.game.currentPlayer) return [403, { error: 'not_your_turn' }];
  hub.game.pass();
  broadcast();
  return [200, { ok: true }];
};

api['undo'] = (body) => {
  if (!isTeacher(body)) return [401, { error: 'unauthorized' }];
  if (hub.mode !== 'battle' || !hub.battle) return [403, { error: 'no_battle' }];
  if (!hub.game.undo()) return [409, { error: 'nothing_to_undo' }];
  broadcast();
  return [200, { ok: true }];
};

api['prev'] = (body) => {
  if (!isTeacher(body)) return [401, { error: 'unauthorized' }];
  if (hub.mode === 'battle') return [403, { error: 'no_nav_in_battle' }];
  if (!hub.game.previous()) return [409, { error: 'at_start' }];
  broadcast();
  return [200, { ok: true }];
};

api['next'] = (body) => {
  if (!isTeacher(body)) return [401, { error: 'unauthorized' }];
  if (hub.mode === 'battle') return [403, { error: 'no_nav_in_battle' }];
  if (!hub.game.next()) return [409, { error: 'at_end' }];
  broadcast();
  return [200, { ok: true }];
};

api['size'] = (body) => {
  if (!isTeacher(body)) return [401, { error: 'unauthorized' }];
  const size = body.size;
  if (size !== 9 && size !== 13 && size !== 19) return [400, { error: 'bad_size' }];
  replaceBoard(size);
  broadcast();
  return [200, { ok: true }];
};

api['mode'] = (body) => {
  if (!isTeacher(body)) return [401, { error: 'unauthorized' }];
  const m = String(body.mode || '');
  if (['teaching', 'battle', 'study'].indexOf(m) < 0) return [400, { error: 'bad_mode' }];
  hub.mode = m;
  hub.battle = null; // 离开对战则结束配对；进入对战需重新选择
  if (m === 'study') hub.study = { phase: 'setup', snapshot: null, version: hub.study.version + 1 };
  broadcast();
  return [200, { ok: true }];
};

api['battle/start'] = (body) => {
  if (!isTeacher(body)) return [401, { error: 'unauthorized' }];
  if (hub.mode !== 'battle') return [403, { error: 'not_in_battle_mode' }];
  const sid = String(body.studentId || '');
  const s = hub.students.get(sid);
  if (!s || !s.online) return [409, { error: 'student_offline' }];
  const tc = body.teacherColor === 'white' ? 'white' : 'black';
  hub.battle = { studentId: sid, teacherColor: tc };
  hub.game.currentPlayer = 'black'; // 黑先
  hub.game.passCount = 0;
  hub.game.koPoint = null;
  hub.game.lastMove = null;
  hub.game.truncateHistory(); // 悔棋只回退对战中的着法
  broadcast();
  return [200, { ok: true }];
};

api['battle/end'] = (body) => {
  if (!isTeacher(body)) return [401, { error: 'unauthorized' }];
  hub.battle = null;
  broadcast();
  return [200, { ok: true }];
};

api['study/start'] = (body) => {
  if (!isTeacher(body)) return [401, { error: 'unauthorized' }];
  if (hub.mode !== 'study') return [403, { error: 'not_in_study_mode' }];
  hub.study = {
    phase: 'active',
    snapshot: hub.game.serialize(),
    solution: cloneSolution(hub.solution),
    version: hub.study.version + 1
  };
  broadcast();
  return [200, { ok: true, graded: !!hub.study.solution }];
};

api['study/end'] = (body) => {
  if (!isTeacher(body)) return [401, { error: 'unauthorized' }];
  if (hub.mode !== 'study') return [403, { error: 'not_in_study_mode' }];
  hub.study = { phase: 'setup', snapshot: null, version: hub.study.version + 1 };
  broadcast();
  return [200, { ok: true }];
};

api['free'] = (body) => {
  if (!isTeacher(body)) return [401, { error: 'unauthorized' }];
  hub.freeMode = !!body.on;
  broadcast();
  return [200, { ok: true }];
};

api['import/sgf'] = (body) => {
  if (!isTeacher(body)) return [401, { error: 'unauthorized' }];
  if (hub.mode === 'battle' && hub.battle) return [403, { error: 'battle_active' }];
  const parsed = parseSgf(String(body.sgf || ''));
  if (!parsed) return [400, { error: 'bad_sgf' }];

  replaceBoard(parsed.size);

  const g = hub.game;
  let setupApplied = 0, movesApplied = 0, skipped = 0;
  for (const s of parsed.setup) {
    if (g.placeFree(s.x, s.y, s.color)) setupApplied++; else skipped++;
  }
  // 着手：主线颜色严格交替时按规则落子（正确提子/打劫），失败的单子退回自由摆；
  // 有同色连下（习题常见）则全部自由摆，保证摆出与棋谱一致的盘面。
  let alternating = true;
  for (let k = 1; k < parsed.moves.length; k++) {
    if (parsed.moves[k].color === parsed.moves[k - 1].color) { alternating = false; break; }
  }
  for (const m of parsed.moves) {
    let ok = false;
    if (m.pass) { g.pass(); ok = true; }
    else if (alternating && g.place(m.x, m.y)) ok = true;
    else ok = g.placeFree(m.x, m.y, m.color);
    if (ok) movesApplied++; else skipped++;
  }
  if (parsed.playerToMove) {
    g.currentPlayer = parsed.playerToMove;
  } else if (parsed.moves.length) {
    const first = parsed.moves[0].color;
    g.currentPlayer = (parsed.moves.length % 2 === 0)
      ? first
      : (first === 'black' ? 'white' : 'black');
  }

  // 主线与分支都解析成功时保留正解，学习模式下发后学生端自动判题
  hub.solution = parsed.solution;

  broadcast();
  return [200, {
    ok: true, size: parsed.size, setup: setupApplied, moves: movesApplied,
    skipped, historyLen: g.history.length,
    solutionLines: hub.solution ? hub.solution.lines.length : 0
  }];
};

api['reset'] = (body) => {
  if (!isTeacher(body)) return [401, { error: 'unauthorized' }];
  hub.game = new Game(hub.size);
  hub.solution = null;
  broadcast();
  return [200, { ok: true }];
};

/* ---------- 题库 ---------- */

api['bank/list'] = (body) => {
  if (!isTeacher(body)) return [401, { error: 'unauthorized' }];
  return [200, { list: bankMeta() }];
};

api['bank/save'] = (body) => {
  if (!isTeacher(body)) return [401, { error: 'unauthorized' }];
  const name = String(body.name || '').trim().slice(0, 60);
  if (!name) return [400, { error: 'name_required' }];
  if (!hub.game.serialize().board.some((row) => row.some((c) => c))) {
    return [400, { error: 'empty_board' }];
  }
  const category = String(body.category || '').trim().slice(0, 20);
  const note = String(body.note || '').trim().slice(0, 200);

  let p = body.id ? hub.bank.find((x) => x.id === String(body.id)) : null;
  if (p) {
    p.name = name;
    p.category = category;
    p.note = note;
    p.size = hub.size;
    p.snapshot = boardSnapshot();
    p.solution = cloneSolution(hub.solution);
    p.updatedAt = Date.now();
  } else {
    p = {
      id: crypto.randomBytes(8).toString('hex'),
      name, category, note,
      size: hub.size,
      createdAt: Date.now(),
      snapshot: boardSnapshot(),
      solution: cloneSolution(hub.solution)
    };
    hub.bank.push(p);
  }
  saveBank();
  return [200, { ok: true, id: p.id, list: bankMeta() }];
};

api['bank/load'] = (body) => {
  if (!isTeacher(body)) return [401, { error: 'unauthorized' }];
  const p = hub.bank.find((x) => x.id === String(body.id || ''));
  if (!p || !p.snapshot || !Array.isArray(p.snapshot.board)) return [404, { error: 'no_problem' }];
  replaceBoard(p.snapshot.size || p.size || hub.size);
  hub.game = Game.fromDisplay(p.snapshot);
  hub.solution = cloneSolution(p.solution);
  broadcast();
  return [200, { ok: true, size: hub.size, hasSolution: !!hub.solution }];
};

api['bank/delete'] = (body) => {
  if (!isTeacher(body)) return [401, { error: 'unauthorized' }];
  const k = hub.bank.findIndex((x) => x.id === String(body.id || ''));
  if (k < 0) return [404, { error: 'no_problem' }];
  hub.bank.splice(k, 1);
  saveBank();
  return [200, { ok: true, list: bankMeta() }];
};

/* ---------- 服务器 ---------- */

const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); }
  catch (e) { res.writeHead(400); return res.end(); }

  if (req.method === 'GET' && u.pathname === '/events') {
    return handleEvents(req, res, u.searchParams);
  }

  if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
    const fn = api[u.pathname.slice(5)];
    if (!fn) return json(res, 404, { error: 'not_found' });
    let body;
    try { body = await readBody(req); }
    catch (e) { return json(res, 400, { error: 'bad_request' }); }
    let out;
    try { out = fn(body); }
    catch (e) {
      console.error('API error:', u.pathname, e);
      return json(res, 500, { error: 'server_error' });
    }
    return json(res, out[0], out[1]);
  }

  return serveStatic(req, res, u.pathname);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用。换个端口试试：node server.js ' + PASSWORD + ' 3001');
    process.exit(1);
  }
  console.error(e);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('======================================');
  console.log(' 围棋课堂服务已启动 / Go classroom server started');
  console.log(' 老师口令 / teacher password: ' + PASSWORD);
  console.log('--------------------------------------');
  console.log(' 本机   / local :  http://localhost:' + PORT + '/');
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of (list || [])) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }
  ips.forEach((ip) => console.log(' 局域网 / LAN   :  http://' + ip + ':' + PORT + '/'));
  console.log('--------------------------------------');
  console.log(' 自定义口令与端口: node server.js <口令> <端口>');
  console.log('======================================');
});
