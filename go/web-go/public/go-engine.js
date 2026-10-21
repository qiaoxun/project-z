/**
 * 围棋引擎 —— 服务端与浏览器共用（UMD）
 * 规则：提子、打劫、禁自杀；规则模式下黑白自动轮流。
 * 另提供自由摆子（placeFree，忽略规则）与历史快照（上一步/下一步/悔棋）。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.GoEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DIRS = [{ dx: 0, dy: -1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 1, dy: 0 }];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  class Game {
    constructor(size) {
      this.size = size;
      this.reset();
    }

    reset() {
      this.board = [];
      for (var y = 0; y < this.size; y++) {
        var row = [];
        for (var x = 0; x < this.size; x++) row.push(null);
        this.board.push(row);
      }
      this.currentPlayer = 'black';
      this.captures = { black: 0, white: 0 };
      this.lastMove = null;
      this.koPoint = null;
      this.passCount = 0;
      this.history = [];
      this.historyIndex = -1;
      this._save();
    }

    /* ---------- 历史快照 ---------- */

    _snapshot() {
      return {
        board: clone(this.board),
        currentPlayer: this.currentPlayer,
        captures: { black: this.captures.black, white: this.captures.white },
        lastMove: this.lastMove ? { x: this.lastMove.x, y: this.lastMove.y } : null,
        koPoint: this.koPoint ? { x: this.koPoint.x, y: this.koPoint.y } : null,
        passCount: this.passCount
      };
    }

    _save() {
      this.history = this.history.slice(0, this.historyIndex + 1);
      this.history.push(this._snapshot());
      this.historyIndex = this.history.length - 1;
    }

    _restore(s) {
      this.board = clone(s.board);
      this.currentPlayer = s.currentPlayer;
      this.captures = { black: s.captures.black, white: s.captures.white };
      this.lastMove = s.lastMove ? { x: s.lastMove.x, y: s.lastMove.y } : null;
      this.koPoint = s.koPoint ? { x: s.koPoint.x, y: s.koPoint.y } : null;
      this.passCount = s.passCount || 0;
    }

    canPrev() { return this.historyIndex > 0; }
    canNext() { return this.historyIndex < this.history.length - 1; }
    atEnd() { return this.historyIndex >= this.history.length - 1; }

    previous() {
      if (!this.canPrev()) return false;
      this.historyIndex--;
      this._restore(this.history[this.historyIndex]);
      return true;
    }

    next() {
      if (!this.canNext()) return false;
      this.historyIndex++;
      this._restore(this.history[this.historyIndex]);
      return true;
    }

    /* 真悔棋：彻底移除最后一手（历史截断） */
    undo() {
      if (this.history.length <= 1) return false;
      this.history.pop();
      this.historyIndex = this.history.length - 1;
      this._restore(this.history[this.historyIndex]);
      return true;
    }

    /* 丢弃旧历史，以当前局面作为唯一历史起点（开局对战时用） */
    truncateHistory() {
      this.history = [this._snapshot()];
      this.historyIndex = 0;
    }

    /* ---------- 围棋规则 ---------- */

    isValidPos(x, y) {
      return Number.isInteger(x) && Number.isInteger(y) &&
        x >= 0 && x < this.size && y >= 0 && y < this.size;
    }

    getGroup(x, y) {
      var color = this.board[y][x];
      var group = [];
      var visited = new Set();
      var stack = [{ x: x, y: y }];
      while (stack.length > 0) {
        var pos = stack.pop();
        var key = pos.x + ',' + pos.y;
        if (visited.has(key)) continue;
        visited.add(key);
        if (!this.isValidPos(pos.x, pos.y)) continue;
        if (this.board[pos.y][pos.x] !== color) continue;
        group.push(pos);
        stack.push({ x: pos.x, y: pos.y - 1 });
        stack.push({ x: pos.x, y: pos.y + 1 });
        stack.push({ x: pos.x - 1, y: pos.y });
        stack.push({ x: pos.x + 1, y: pos.y });
      }
      return group;
    }

    getGroupLiberties(x, y) {
      var group = this.getGroup(x, y);
      var liberties = [];
      var seen = new Set();
      group.forEach(function (pos) {
        DIRS.forEach(function (d) {
          var nx = pos.x + d.dx, ny = pos.y + d.dy;
          var k = nx + ',' + ny;
          if (nx >= 0 && nx < this.size && ny >= 0 && ny < this.size &&
            this.board[ny][nx] === null && !seen.has(k)) {
            seen.add(k);
            liberties.push({ x: nx, y: ny });
          }
        }, this);
      }, this);
      return liberties;
    }

    _hasLiberty(x, y) { return this.getGroupLiberties(x, y).length > 0; }

    /* 落子后，检查四周对方棋块是否无气（返回应提掉的子） */
    _findCaptures(x, y, opponent) {
      var captured = [];
      DIRS.forEach(function (d) {
        var nx = x + d.dx, ny = y + d.dy;
        if (!this.isValidPos(nx, ny)) return;
        if (this.board[ny][nx] !== opponent) return;
        if (!this._hasLiberty(nx, ny)) {
          this.getGroup(nx, ny).forEach(function (pos) {
            if (!captured.some(function (c) { return c.x === pos.x && c.y === pos.y; })) captured.push(pos);
          });
        }
      }, this);
      return captured;
    }

    canPlace(x, y) {
      if (!this.isValidPos(x, y)) return false;
      if (this.board[y][x] !== null) return false;
      if (this.koPoint && this.koPoint.x === x && this.koPoint.y === y) return false;
      var opponent = this.currentPlayer === 'black' ? 'white' : 'black';
      this.board[y][x] = this.currentPlayer;
      var captured = this._findCaptures(x, y, opponent);
      var suicide = captured.length === 0 && !this._hasLiberty(x, y);
      this.board[y][x] = null;
      return !suicide;
    }

    /* 规则模式落子（自动轮流） */
    place(x, y) {
      if (!this.canPlace(x, y)) return false;
      var opponent = this.currentPlayer === 'black' ? 'white' : 'black';
      this.board[y][x] = this.currentPlayer;
      var captured = this._findCaptures(x, y, opponent);
      captured.forEach(function (p) { this.board[p.y][p.x] = null; }, this);
      this.captures[this.currentPlayer] += captured.length;
      // 简单劫判定：恰好提一子，且新落的子是单颗、仅剩一口气（恰在被提点上），
      // 则对方下一手不得立即回提该点。
      this.koPoint = null;
      if (captured.length === 1) {
        var c = captured[0];
        var group = this.getGroup(x, y);
        var libs = this.getGroupLiberties(x, y);
        if (group.length === 1 && libs.length === 1 &&
          libs[0].x === c.x && libs[0].y === c.y) {
          this.koPoint = { x: c.x, y: c.y };
        }
      }
      this.lastMove = { x: x, y: y };
      this.passCount = 0;
      this.currentPlayer = opponent;
      this._save();
      return true;
    }

    /* 自由摆子：忽略规则，可指定颜色、可连下同色（仅空点） */
    placeFree(x, y, color) {
      if (!this.isValidPos(x, y)) return false;
      if (color !== 'black' && color !== 'white') return false;
      if (this.board[y][x] !== null) return false;
      this.board[y][x] = color;
      this.lastMove = { x: x, y: y };
      this.passCount = 0;
      this.koPoint = null;
      this._save();
      return true;
    }

    pass() {
      this.passCount += 1;
      this.koPoint = null;
      this.lastMove = null;
      this.currentPlayer = this.currentPlayer === 'black' ? 'white' : 'black';
      this._save();
      return true;
    }

    /* ---------- 序列化 ---------- */

    serialize() {
      return Object.assign({
        size: this.size,
        historyLen: this.history.length,
        historyIndex: this.historyIndex
      }, this._snapshot());
    }
  }

  /* 从网络传输的局面（不含历史）重建一局棋，历史从当前局面重新开始 */
  Game.fromDisplay = function (s) {
    var g = new Game(s.size);
    g.board = clone(s.board);
    g.currentPlayer = s.currentPlayer || 'black';
    g.captures = {
      black: s.captures ? s.captures.black : 0,
      white: s.captures ? s.captures.white : 0
    };
    g.lastMove = s.lastMove ? { x: s.lastMove.x, y: s.lastMove.y } : null;
    g.koPoint = s.koPoint ? { x: s.koPoint.x, y: s.koPoint.y } : null;
    g.passCount = s.passCount || 0;
    g.history = [g._snapshot()];
    g.historyIndex = 0;
    return g;
  };

  return { Game: Game };
});
