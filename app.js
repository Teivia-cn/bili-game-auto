/**
 * B站游戏中心活动自动解析+完成任务+抽奖 主程序
 */
const express = require('express');
const path = require('path');
const {
  initDatabase,
  accountOps,
  activityOps,
  taskRecordOps,
  lotteryRecordOps,
  lotteryPlanOps,
  logOps,
  settingOps,
  extractUid
} = require('./lib/db');
const api = require('./lib/api');
const { parseActivityPage, isEraPage } = require('./lib/parser');
const { executeActivityTasks, executeForAllAccounts, executeActivityFull, executeFullForAllAccounts, executeSuperMode, validateAccount } = require('./lib/task');
const { executeLottery, executeLotteryForAllAccounts } = require('./lib/lottery');
const scheduler = require('./lib/scheduler');

const app = express();
const PORT = process.env.PORT || 2333;

// 中间件
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ============ API路由 ============

// --- 账户管理 ---
app.get('/api/accounts', (req, res) => {
  try {
    const accounts = accountOps.getAll();
    // 不返回完整cookie
    const safe = accounts.map(a => ({
      ...a,
      cookie: a.cookie.slice(0, 20) + '...',
      cookie_preview: a.cookie.slice(0, 50)
    }));
    res.json({ code: 0, data: safe });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

app.post('/api/accounts', async (req, res) => {
  try {
    const { name, cookie } = req.body;
    if (!name || !cookie) {
      return res.json({ code: -1, message: '名称和Cookie不能为空' });
    }

    // 检查名称是否已存在
    const existing = accountOps.getByName(name);
    if (existing) {
      return res.json({ code: -1, message: '账户名称已存在' });
    }

    // 验证cookie
    const info = await api.getUserInfo(cookie);
    if (!info.isLogin) {
      return res.json({ code: -1, message: 'Cookie无效或已过期，请重新获取' });
    }

    const result = accountOps.add(name, cookie);
    accountOps.updateUid(result.lastInsertRowid, String(info.uid));

    logOps.add('info', 'account', `添加账户: ${name} (${info.uname})`);
    res.json({ code: 0, data: { id: result.lastInsertRowid, uid: info.uid, uname: info.uname } });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

app.put('/api/accounts/:id', (req, res) => {
  try {
    const { id } = req.params;
    const data = req.body;
    accountOps.update(Number(id), data);
    res.json({ code: 0 });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

app.delete('/api/accounts/:id', (req, res) => {
  try {
    accountOps.remove(Number(req.params.id));
    res.json({ code: 0 });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

app.post('/api/accounts/:id/validate', async (req, res) => {
  try {
    const account = accountOps.getById(Number(req.params.id));
    if (!account) return res.json({ code: -1, message: '账户不存在' });
    const result = await validateAccount(account);
    res.json({ code: 0, data: result });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

// --- 活动管理 ---
app.get('/api/activities', (req, res) => {
  try {
    const activities = activityOps.getAll();
    // 附加任务数量
    const result = activities.map(a => ({
      ...a,
      tasks: JSON.parse(a.tasks_json || '[]'),
      task_count: JSON.parse(a.tasks_json || '[]').length
    }));
    res.json({ code: 0, data: result });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

app.get('/api/activities/active', (req, res) => {
  try {
    const activities = activityOps.getActive();
    const result = activities.map(a => ({
      ...a,
      tasks: JSON.parse(a.tasks_json || '[]')
    }));
    res.json({ code: 0, data: result });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

app.post('/api/activities/scrape', async (req, res) => {
  try {
    const result = await scheduler.scrapeActivities();
    res.json({ code: 0, data: result });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

app.post('/api/activities/:id/parse', async (req, res) => {
  try {
    const activity = activityOps.getById(req.params.id);
    if (!activity) return res.json({ code: -1, message: '活动不存在' });

    if (!isEraPage(activity.link)) {
      return res.json({ code: -1, message: '非era页面，无法解析' });
    }

    const html = await api.fetchHTML(activity.link);
    const parseResult = parseActivityPage(html);

    if (parseResult.success) {
      activityOps.updateParseResult(activity.id, {
        activity_group_id: parseResult.activityGroupId,
        appkey: parseResult.appkey,
        app_secret: parseResult.appSecret,
        activity_id: parseResult.activityId,
        lotteryActivityId: parseResult.lotteryActivityId,
        tasks: parseResult.tasks,
        parse_status: 1
      });
      res.json({ code: 0, data: parseResult });
    } else {
      res.json({ code: -1, message: parseResult.error });
    }
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

app.post('/api/activities/parse-all', async (req, res) => {
  try {
    const { force } = req.body;
    if (force) {
      // 重置所有era活动的解析状态，以便重新解析
      const activities = activityOps.getAll();
      for (const a of activities) {
        if (a.link && a.link.includes('/blackboard/')) {
          const { getDb } = require('./lib/db');
          getDb().prepare('UPDATE activities SET parse_status=0 WHERE id=?').run(a.id);
        }
      }
      const { log } = require('./lib/api');
      log('info', 'scheduler', `已重置 ${activities.filter(a => a.link && a.link.includes('/blackboard/')).length} 个era活动的解析状态`);
    }
    await scheduler.parseNewActivities();
    res.json({ code: 0, message: '解析完成' });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

// --- 任务执行 ---
app.post('/api/tasks/execute', async (req, res) => {
  try {
    const { activity_id, account_id } = req.body;

    if (activity_id && account_id) {
      // 执行指定活动的指定账户任务
      const activity = activityOps.getById(activity_id);
      const account = accountOps.getById(account_id);
      if (!activity || !account) return res.json({ code: -1, message: '活动或账户不存在' });
      const result = await executeActivityTasks(activity, account);
      res.json({ code: 0, data: result });
    } else if (activity_id) {
      // 执行指定活动的所有账户任务
      const activity = activityOps.getById(activity_id);
      if (!activity) return res.json({ code: -1, message: '活动不存在' });
      const result = await executeForAllAccounts(activity);
      res.json({ code: 0, data: result });
    } else {
      // 执行所有活动任务
      await scheduler.runAutoTasks();
      res.json({ code: 0, message: '任务执行完成' });
    }
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

app.get('/api/tasks/records', (req, res) => {
  try {
    const { account_id } = req.query;
    if (account_id) {
      const records = taskRecordOps.getByAccount(Number(account_id));
      res.json({ code: 0, data: records });
    } else {
      const stats = taskRecordOps.getStats();
      res.json({ code: 0, data: stats });
    }
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

// --- 抽奖 ---
app.post('/api/lottery/execute', async (req, res) => {
  try {
    const { activity_id, account_id, max_draws } = req.body;

    if (activity_id && account_id) {
      const activity = activityOps.getById(activity_id);
      const account = accountOps.getById(account_id);
      if (!activity || !account) return res.json({ code: -1, message: '活动或账户不存在' });
      const result = await executeLottery(activity, account, max_draws || 0);
      res.json({ code: 0, data: result });
    } else if (activity_id) {
      const activity = activityOps.getById(activity_id);
      if (!activity) return res.json({ code: -1, message: '活动不存在' });
      const result = await executeLotteryForAllAccounts(activity, max_draws || 0);
      res.json({ code: 0, data: result });
    } else {
      return res.json({ code: -1, message: '请指定活动' });
    }
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

app.get('/api/lottery/records', (req, res) => {
  try {
    const { account_id } = req.query;
    if (account_id) {
      const records = lotteryRecordOps.getByAccount(Number(account_id));
      res.json({ code: 0, data: records });
    } else {
      const stats = lotteryRecordOps.getStats();
      res.json({ code: 0, data: stats });
    }
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

app.get('/api/lottery/wins', (req, res) => {
  try {
    const { account_id } = req.query;
    const records = lotteryRecordOps.getWins(account_id ? Number(account_id) : null);
    res.json({ code: 0, data: records });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

// --- 抽奖计划 ---
app.get('/api/lottery-plans', (req, res) => {
  try {
    const plans = lotteryPlanOps.getAll();
    res.json({ code: 0, data: plans });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

app.post('/api/lottery-plans', (req, res) => {
  try {
    const { activity_id, cron_expr } = req.body;
    if (!activity_id) return res.json({ code: -1, message: '请指定活动' });
    const result = lotteryPlanOps.add(activity_id, cron_expr);
    scheduler.rescheduleLottery(result.lastInsertRowid);
    res.json({ code: 0, data: { id: result.lastInsertRowid } });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

app.put('/api/lottery-plans/:id', (req, res) => {
  try {
    lotteryPlanOps.update(Number(req.params.id), req.body);
    scheduler.rescheduleLottery(Number(req.params.id));
    res.json({ code: 0 });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

app.delete('/api/lottery-plans/:id', (req, res) => {
  try {
    lotteryPlanOps.remove(Number(req.params.id));
    res.json({ code: 0 });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

// --- 日志 ---
app.get('/api/logs', (req, res) => {
  try {
    const { limit = 100, module } = req.query;
    const logs = logOps.getRecent(Number(limit), module);
    res.json({ code: 0, data: logs });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

app.delete('/api/logs', (req, res) => {
  try {
    logOps.clear();
    res.json({ code: 0 });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

// --- 调度器 ---
app.get('/api/scheduler/status', (req, res) => {
  try {
    const jobs = scheduler.getJobStatus();
    res.json({ code: 0, data: jobs });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

app.post('/api/scheduler/trigger', async (req, res) => {
  try {
    const { job } = req.body;
    if (!job) return res.json({ code: -1, message: '请指定任务名称' });
    const result = await scheduler.triggerJob(job);
    res.json({ code: 0, data: result });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

app.put('/api/scheduler/settings', (req, res) => {
  try {
    const { name, cron_expr } = req.body;
    if (!name || !cron_expr) return res.json({ code: -1, message: '参数不完整' });
    const success = scheduler.updateSchedule(name, cron_expr);
    res.json({ code: 0, data: { success } });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

// --- 执行模式设置 ---
app.get('/api/settings/mode', (req, res) => {
  try {
    const mode = settingOps.get('execution_mode', '1');
    res.json({ code: 0, data: { mode } });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

app.post('/api/settings/mode', (req, res) => {
  try {
    const { mode } = req.body;
    if (!['1', '2', '3'].includes(String(mode))) return res.json({ code: -1, message: '无效的模式值' });
    const result = scheduler.switchMode(mode);
    res.json({ code: 0, data: result });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

// --- 组合执行(模式二) ---
app.post('/api/tasks/execute-full', async (req, res) => {
  try {
    const { activity_id, account_id } = req.body;

    if (activity_id && account_id) {
      const activity = activityOps.getById(activity_id);
      const account = accountOps.getById(account_id);
      if (!activity || !account) return res.json({ code: -1, message: '活动或账户不存在' });
      const result = await executeActivityFull(activity, account);
      res.json({ code: 0, data: result });
    } else if (activity_id) {
      const activity = activityOps.getById(activity_id);
      if (!activity) return res.json({ code: -1, message: '活动不存在' });
      const result = await executeFullForAllAccounts(activity);
      res.json({ code: 0, data: result });
    } else {
      // 执行所有活动全流程
      await scheduler.runAutoFull();
      res.json({ code: 0, message: '全流程执行完成' });
    }
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

// --- 超级模式(模式三) ---
app.post('/api/tasks/execute-super', async (req, res) => {
  try {
    const result = await executeSuperMode();
    res.json({ code: 0, data: result });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

// --- 仪表盘统计 ---
app.get('/api/dashboard', (req, res) => {
  try {
    const accounts = accountOps.getAll();
    const activities = activityOps.getActive();
    const taskStats = taskRecordOps.getStats();
    const lotteryStats = lotteryRecordOps.getStats();
    const plans = lotteryPlanOps.getAll();
    const recentLogs = logOps.getRecent(10);
    const mode = settingOps.get('execution_mode', '1');

    res.json({
      code: 0,
      data: {
        accounts: {
          total: accounts.length,
          enabled: accounts.filter(a => a.enabled).length
        },
        activities: {
          total: activities.length,
          parsed: activities.filter(a => a.parse_status === 1).length
        },
        tasks: taskStats,
        lottery: lotteryStats,
        plans: {
          total: plans.length,
          enabled: plans.filter(p => p.enabled).length
        },
        mode,
        recentLogs
      }
    });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ 启动 ============
async function start() {
  try {
    // 等待数据库初始化完成
    await initDatabase();
    console.log('[OK] 数据库初始化完成');

    app.listen(PORT, () => {
      console.log(`\n========================================`);
      console.log(`  B站游戏中心活动自动化工具 v1.0.0`);
      console.log(`  管理面板: http://localhost:${PORT}`);
      console.log(`========================================\n`);

      // 初始化调度器
      scheduler.init();

      api.log('info', 'main', `服务启动在端口 ${PORT}`);
    });
  } catch (e) {
    console.error('[FATAL] 启动失败:', e);
    process.exit(1);
  }
}

start();
