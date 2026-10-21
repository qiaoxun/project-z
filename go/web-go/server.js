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

/* ---------- 房间状态（内存，服务重启即重置） ---------- */

const hub = {
  size: 13,
  mode: 'teaching',        // teaching | battle | study
  freeMode: false,         // 教学/学习摆棋时的「自由摆子」开关（对战模式忽略）
  game: new Game(13),
  battle: null,            // { studentId, teacherColor }
  study: { phase: 'setup', snapshot: null, version: 0 },
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
        snapshot: hub.study.phase === 'active' ? hub.study.snapshot : null
      },
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
  hub.size = size;
  hub.game = new Game(size);
  hub.battle = null; // 换棋盘视为结束对战
  if (hub.study.phase === 'active') hub.study = { phase: 'setup', snapshot: null, version: hub.study.version + 1 };
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
  hub.study = { phase: 'active', snapshot: hub.game.serialize(), version: hub.study.version + 1 };
  broadcast();
  return [200, { ok: true }];
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

api['reset'] = (body) => {
  if (!isTeacher(body)) return [401, { error: 'unauthorized' }];
  hub.game = new Game(hub.size);
  broadcast();
  return [200, { ok: true }];
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
