/**
 * 数据库管理模块 - sql.js 纯JS实现 (无需原生编译)
 * 提供与 better-sqlite3 兼容的 API 接口
 */
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'bili-game.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let _db = null;       // sql.js Database 实例
let _ready = false;
let _saveTimer = null;

// ============ sql.js 兼容层 ============

/**
 * 将 sql.js 查询结果转为对象数组
 * sql.js exec 返回: [{columns: [...], values: [[...], ...]}]
 */
function resultToObjects(stmt) {
  const results = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    results.push(row);
  }
  stmt.free();
  return results;
}

/**
 * 兼容 better-sqlite3 的 Statement 包装
 */
class StatementWrapper {
  constructor(db, sql) {
    this._db = db;
    this._sql = sql;
  }

  all(...params) {
    const stmt = this._db.prepare(this._sql);
    if (params.length > 0) stmt.bind(params);
    const results = resultToObjects(stmt);
    return results;
  }

  get(...params) {
    const stmt = this._db.prepare(this._sql);
    if (params.length > 0) stmt.bind(params);
    let result = null;
    if (stmt.step()) {
      result = stmt.getAsObject();
    }
    stmt.free();
    return result;
  }

  run(...params) {
    this._db.run(this._sql, params);
    scheduleSave();
    return {
      changes: this._db.getRowsModified(),
      lastInsertRowid: Number(getLastInsertRowid(this._db))
    };
  }
}

/**
 * 获取最后插入的 rowid
 */
function getLastInsertRowid(db) {
  const stmt = db.prepare('SELECT last_insert_rowid() as id');
  let id = 0;
  if (stmt.step()) {
    id = stmt.get(0);
  }
  stmt.free();
  return id;
}

/**
 * 兼容 better-sqlite3 的 Database 包装
 */
class DatabaseWrapper {
  constructor(sqlDb) {
    this._db = sqlDb;
  }

  prepare(sql) {
    return new StatementWrapper(this._db, sql);
  }

  exec(sql) {
    this._db.run(sql);
    scheduleSave();
  }

  pragma(str) {
    try { this._db.run(`PRAGMA ${str}`); } catch (e) { /* ignore */ }
  }
}

/**
 * 延迟保存数据库到磁盘(防抖)
 */
function scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    saveToDisk();
  }, 500);
}

/**
 * 立即保存数据库到磁盘
 */
function saveToDisk() {
  if (!_db) return;
  try {
    const data = _db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  } catch (e) {
    console.error('[DB] 保存失败:', e.message);
  }
}

// ============ 初始化 ============

/**
 * 异步初始化数据库
 */
async function initDatabase() {
  const SQL = await initSqlJs();

  // 如果已有数据库文件则加载
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    _db = new SQL.Database(fileBuffer);
  } else {
    _db = new SQL.Database();
  }

  const wrapper = new DatabaseWrapper(_db);

  // 启用WAL模式(在sql.js中无实际意义，但保持兼容)
  wrapper.pragma('journal_mode = WAL');
  wrapper.pragma('foreign_keys = ON');

  // 初始化表结构
  wrapper.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      cookie TEXT NOT NULL,
      csrf TEXT NOT NULL DEFAULT '',
      uid TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      game_name TEXT,
      game_base_id INTEGER,
      title TEXT NOT NULL,
      cover TEXT,
      description TEXT DEFAULT '',
      link TEXT NOT NULL,
      begin_time TEXT,
      end_time TEXT,
      status INTEGER DEFAULT 1,
      is_top INTEGER DEFAULT 0,
      activity_group_id TEXT DEFAULT '',
      appkey TEXT DEFAULT '',
      app_secret TEXT DEFAULT '',
      activity_id TEXT DEFAULT '',
      tasks_json TEXT DEFAULT '[]',
      parse_status INTEGER DEFAULT 0,
      parsed_at TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS task_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      activity_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_name TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      result TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (activity_id) REFERENCES activities(id),
      UNIQUE(account_id, activity_id, task_id)
    );

    CREATE TABLE IF NOT EXISTS lottery_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      activity_id TEXT NOT NULL,
      activity_group_id TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      prize_name TEXT DEFAULT '',
      result_json TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (activity_id) REFERENCES activities(id)
    );

    CREATE TABLE IF NOT EXISTS lottery_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id TEXT NOT NULL,
      cron_expr TEXT DEFAULT '0 */2 * * *',
      enabled INTEGER DEFAULT 1,
      last_run TEXT,
      next_run TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (activity_id) REFERENCES activities(id)
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT DEFAULT 'info',
      module TEXT DEFAULT '',
      message TEXT NOT NULL,
      detail TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);

  // 迁移: 添加 lottery_activity_id 列(如果不存在)
  try {
    wrapper.exec(`ALTER TABLE activities ADD COLUMN lottery_activity_id TEXT DEFAULT ''`);
    console.log('[DB] 迁移: 添加 lottery_activity_id 列');
  } catch (e) {
    // 列已存在，忽略
  }

  _ready = true;
  console.log('[DB] 数据库初始化完成');
  return wrapper;
}

/**
 * 获取数据库实例(同步，需先调用 initDatabase)
 */
function getDb() {
  if (!_ready) throw new Error('数据库未初始化，请先调用 initDatabase()');
  return new DatabaseWrapper(_db);
}

function isReady() {
  return _ready;
}

// ============ 数据库实例(延迟获取) ============
// 为了兼容原有代码直接 require('./db') 后使用的方式，
// 我们创建一个代理，在每次访问时获取最新的 db wrapper

let _dbWrapper = null;

function db() {
  if (!_dbWrapper) _dbWrapper = getDb();
  return _dbWrapper;
}

// ============ 账户操作 ============
const accountOps = {
  getAll: () => db().prepare('SELECT * FROM accounts ORDER BY id').all(),
  getEnabled: () => db().prepare('SELECT * FROM accounts WHERE enabled = 1 ORDER BY id').all(),
  getById: (id) => db().prepare('SELECT * FROM accounts WHERE id = ?').get(id),
  getByName: (name) => db().prepare('SELECT * FROM accounts WHERE name = ?').get(name),

  add: (name, cookie) => {
    const csrf = extractCsrf(cookie);
    return db().prepare(
      'INSERT INTO accounts (name, cookie, csrf) VALUES (?, ?, ?)'
    ).run(name, cookie, csrf);
  },

  update: (id, data) => {
    const csrf = data.cookie ? extractCsrf(data.cookie) : undefined;
    if (data.cookie) {
      db().prepare(
        'UPDATE accounts SET name=?, cookie=?, csrf=?, updated_at=datetime("now","localtime") WHERE id=?'
      ).run(data.name, data.cookie, csrf, id);
    } else {
      db().prepare(
        'UPDATE accounts SET name=?, enabled=?, updated_at=datetime("now","localtime") WHERE id=?'
      ).run(data.name, data.enabled ? 1 : 0, id);
    }
  },

  remove: (id) => {
    db().prepare('DELETE FROM task_records WHERE account_id = ?').run(id);
    db().prepare('DELETE FROM lottery_records WHERE account_id = ?').run(id);
    db().prepare('DELETE FROM accounts WHERE id = ?').run(id);
  },

  updateUid: (id, uid) => {
    db().prepare('UPDATE accounts SET uid=?, updated_at=datetime("now","localtime") WHERE id=?').run(uid, id);
  }
};

// ============ 活动操作 ============
const activityOps = {
  getAll: () => db().prepare('SELECT * FROM activities ORDER BY is_top DESC, begin_time DESC').all(),
  getActive: () => db().prepare(
    "SELECT * FROM activities WHERE status = 1 AND end_time >= date('now','localtime') ORDER BY is_top DESC, begin_time DESC"
  ).all(),
  getById: (id) => db().prepare('SELECT * FROM activities WHERE id = ?').get(id),
  getUnparsed: () => db().prepare('SELECT * FROM activities WHERE parse_status = 0 AND status = 1').all(),

  upsert: (activity) => {
    return db().prepare(`
      INSERT INTO activities (id, game_name, game_base_id, title, cover, description, link, begin_time, end_time, status, is_top)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        game_name=excluded.game_name, title=excluded.title, cover=excluded.cover,
        description=excluded.description, link=excluded.link, end_time=excluded.end_time,
        status=excluded.status, is_top=excluded.is_top,
        updated_at=datetime('now','localtime')
    `).run(
      activity.id, activity.game_name, activity.game_base_id, activity.title,
      activity.cover, activity.description, activity.link,
      activity.begin_time, activity.end_time, activity.status,
      activity.is_top ? 1 : 0
    );
  },

  updateParseResult: (id, data) => {
    db().prepare(`
      UPDATE activities SET
        activity_group_id=?, appkey=?, app_secret=?, activity_id=?,
        lottery_activity_id=?,
        tasks_json=?, parse_status=?, parsed_at=datetime('now','localtime'),
        updated_at=datetime('now','localtime')
      WHERE id=?
    `).run(
      data.activity_group_id || '', data.appkey || '', data.app_secret || '',
      data.activity_id || '', data.lotteryActivityId || '',
      JSON.stringify(data.tasks || []),
      data.parse_status || 1, id
    );
  },

  getTasks: (id) => {
    const row = db().prepare('SELECT tasks_json FROM activities WHERE id = ?').get(id);
    return row ? JSON.parse(row.tasks_json || '[]') : [];
  }
};

// ============ 任务记录操作 ============
const taskRecordOps = {
  getByAccount: (accountId) => db().prepare(
    'SELECT tr.*, a.title as activity_title FROM task_records tr JOIN activities a ON tr.activity_id = a.id WHERE tr.account_id = ? ORDER BY tr.created_at DESC'
  ).all(accountId),

  upsert: (accountId, activityId, taskId, taskName, status, result) => {
    return db().prepare(`
      INSERT INTO task_records (account_id, activity_id, task_id, task_name, status, result)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, activity_id, task_id) DO UPDATE SET
        status=excluded.status, result=excluded.result,
        updated_at=datetime('now','localtime')
    `).run(accountId, activityId, taskId, taskName, status, result || '');
  },

  getPending: (accountId, activityId) => db().prepare(
    "SELECT * FROM task_records WHERE account_id = ? AND activity_id = ? AND status IN ('pending','failed')"
  ).all(accountId, activityId),

  getStats: () => {
    const row = db().prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending
      FROM task_records
    `).get();
    // sql.js 返回的数值可能是 null 而非 0
    return {
      total: row.total || 0,
      total_done: row.success || 0,
      total_failed: row.failed || 0,
      success: row.success || 0,
      failed: row.failed || 0,
      pending: row.pending || 0
    };
  }
};

// ============ 抽奖记录操作 ============
const lotteryRecordOps = {
  getByAccount: (accountId) => db().prepare(
    'SELECT lr.*, a.title as activity_title FROM lottery_records lr JOIN activities a ON lr.activity_id = a.id WHERE lr.account_id = ? ORDER BY lr.created_at DESC'
  ).all(accountId),

  add: (accountId, activityId, activityGroupId) => {
    return db().prepare(
      'INSERT INTO lottery_records (account_id, activity_id, activity_group_id) VALUES (?, ?, ?)'
    ).run(accountId, activityId, activityGroupId);
  },

  updateResult: (id, status, prizeName, resultJson) => {
    db().prepare(
      'UPDATE lottery_records SET status=?, prize_name=?, result_json=? WHERE id=?'
    ).run(status, prizeName || '', resultJson || '', id);
  },

  getStats: () => {
    const row = db().prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN prize_name != '' AND prize_name != '谢谢参与' AND prize_name NOT LIKE '%谢谢参与%' THEN 1 ELSE 0 END) as won
      FROM lottery_records
    `).get();
    return {
      total: row.total || 0,
      total_draws: row.total || 0,
      total_wins: row.won || 0
    };
  },

  getWins: (accountId) => {
    let sql = `
      SELECT lr.*, a.title as activity_title
      FROM lottery_records lr
      JOIN activities a ON lr.activity_id = a.id
      WHERE lr.status = 'won'
        AND lr.prize_name != ''
        AND lr.prize_name != '谢谢参与'
        AND lr.prize_name NOT LIKE '%谢谢参与%'
    `;
    const params = [];
    if (accountId) {
      sql += ' AND lr.account_id = ?';
      params.push(accountId);
    }
    sql += ' ORDER BY lr.created_at DESC';
    return db().prepare(sql).all(...params);
  }
};

// ============ 抽奖计划操作 ============
const lotteryPlanOps = {
  getAll: () => db().prepare(
    'SELECT lp.*, a.title as activity_title, a.game_name FROM lottery_plans lp JOIN activities a ON lp.activity_id = a.id ORDER BY lp.enabled DESC, lp.id DESC'
  ).all(),

  add: (activityId, cronExpr) => {
    return db().prepare(
      'INSERT INTO lottery_plans (activity_id, cron_expr) VALUES (?, ?)'
    ).run(activityId, cronExpr || '0 */2 * * *');
  },

  update: (id, data) => {
    db().prepare(
      'UPDATE lottery_plans SET cron_expr=?, enabled=?, updated_at=datetime("now","localtime") WHERE id=?'
    ).run(data.cron_expr, data.enabled ? 1 : 0, id);
  },

  updateLastRun: (id) => {
    db().prepare(
      'UPDATE lottery_plans SET last_run=datetime("now","localtime") WHERE id=?'
    ).run(id);
  },

  remove: (id) => {
    db().prepare('DELETE FROM lottery_plans WHERE id = ?').run(id);
  },

  getEnabled: () => db().prepare(
    'SELECT lp.*, a.activity_group_id, a.appkey, a.app_secret, a.activity_id as bili_activity_id FROM lottery_plans lp JOIN activities a ON lp.activity_id = a.id WHERE lp.enabled = 1'
  ).all()
};

// ============ 日志操作 ============
const logOps = {
  add: (level, module, message, detail) => {
    db().prepare(
      'INSERT INTO logs (level, module, message, detail) VALUES (?, ?, ?, ?)'
    ).run(level, module, message, detail || '');
    // 保留最近5000条
    db().prepare(
      'DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 5000)'
    ).run();
  },

  getRecent: (limit = 100, module) => {
    if (module) {
      return db().prepare(
        'SELECT * FROM logs WHERE module = ? ORDER BY id DESC LIMIT ?'
      ).all(module, limit);
    }
    return db().prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit);
  },

  clear: () => db().prepare('DELETE FROM logs').run()
};

// ============ 设置操作 ============
const settingOps = {
  get: (key, defaultVal) => {
    const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : defaultVal;
  },
  set: (key, value) => {
    db().prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(key, value);
  }
};

// ============ 工具函数 ============
function extractCsrf(cookie) {
  const match = cookie.match(/bili_jct=([^;]+)/);
  return match ? match[1] : '';
}

function extractUid(cookie) {
  const match = cookie.match(/DedeUserID=([^;]+)/);
  return match ? match[1] : '';
}

module.exports = {
  initDatabase,
  getDb,
  isReady,
  accountOps,
  activityOps,
  taskRecordOps,
  lotteryRecordOps,
  lotteryPlanOps,
  logOps,
  settingOps,
  extractCsrf,
  extractUid
};
