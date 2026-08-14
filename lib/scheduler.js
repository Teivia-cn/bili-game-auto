/**
 * 调度器 - 定时任务管理
 */
const schedule = require('node-schedule');
const { fetchActivityList, log } = require('./api');
const { activityOps, lotteryPlanOps, settingOps, accountOps } = require('./db');
const { parseActivityPage, isEraPage } = require('./parser');
const { executeForAllAccounts, executeFullForAllAccounts, executeSuperMode } = require('./task');
const { executeAllPlannedLotteries } = require('./lottery');

// 存储所有定时任务
const jobs = {};
const cronExprs = {}; // 存储每个任务的cron表达式

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 初始化调度器
 */
function init() {
  log('info', 'scheduler', '调度器初始化中...');

  const mode = settingOps.get('execution_mode', '1');

  if (mode === '3') {
    // 模式三：超级模式 — 只需一个定时任务，内含抓取→解析→执行全流程
    const superCron = settingOps.get('auto_super_cron', '15 * * * *');
    scheduleJob('auto_super', superCron, runAutoSuper);
    log('info', 'scheduler', '当前模式: 模式三(超级模式-全并发)');
  } else {
    // 模式一/二 需要独立的抓取和解析定时任务
    const activityScrapeCron = settingOps.get('activity_scrape_cron', '0 * * * *');
    scheduleJob('activity_scrape', activityScrapeCron, scrapeActivities);

    const parseCron = settingOps.get('parse_cron', '*/30 * * * *');
    scheduleJob('activity_parse', parseCron, parseNewActivities);

    if (mode === '2') {
      const fullCron = settingOps.get('auto_full_cron', '15 * * * *');
      scheduleJob('auto_full', fullCron, runAutoFull);
      log('info', 'scheduler', '当前模式: 模式二(任务+抽奖组合)');
    } else {
      const taskCron = settingOps.get('task_cron', '15 * * * *');
      scheduleJob('auto_tasks', taskCron, runAutoTasks);
      const lotteryCron = settingOps.get('auto_lottery_cron', '0 */2 * * *');
      scheduleJob('auto_lottery', lotteryCron, runAutoLottery);
      log('info', 'scheduler', '当前模式: 模式一(任务/抽奖独立)');
    }
  }

  // 4. 加载抽奖计划
  loadLotteryPlans();

  // 5. 启动时立即执行一次活动抓取
  setTimeout(() => {
    scrapeActivities().then(() => parseNewActivities());
  }, 5000);

  log('info', 'scheduler', '调度器初始化完成');
}

/**
 * 注册定时任务
 */
function scheduleJob(name, cronExpr, fn) {
  if (jobs[name]) {
    jobs[name].cancel();
  }

  try {
    const job = schedule.scheduleJob(name, cronExpr, () => {
      log('info', 'scheduler', `执行定时任务: ${name}`);
      Promise.resolve(fn())
        .then(() => log('info', 'scheduler', `定时任务完成: ${name}`))
        .catch(e => log('error', 'scheduler', `定时任务失败: ${name} - ${e.message}`));
    });

    jobs[name] = job;
    cronExprs[name] = cronExpr;
    log('info', 'scheduler', `已注册定时任务: ${name} [${cronExpr}]`);
    return true;
  } catch (e) {
    log('error', 'scheduler', `注册定时任务失败: ${name} - ${e.message}`);
    return false;
  }
}

/**
 * 抓取活动列表
 */
async function scrapeActivities() {
  try {
    log('info', 'scraper', '开始抓取活动列表...');
    const activities = await fetchActivityList(1, 50);

    let newCount = 0;
    let updateCount = 0;

    for (const act of activities) {
      const existing = activityOps.getById(act.id);
      const result = activityOps.upsert(act);
      if (!existing) {
        newCount++;
      } else if (result.changes > 0) {
        updateCount++;
      }
    }

    log('info', 'scraper', `活动列表更新完成: 新增 ${newCount}, 更新 ${updateCount}, 总计 ${activities.length}`);
    return { newCount, updateCount, inserted: newCount, total: activities.length };
  } catch (e) {
    log('error', 'scraper', `抓取活动列表失败: ${e.message}`);
    throw e;
  }
}

/**
 * 解析新活动
 */
async function parseNewActivities() {
  try {
    const unparsed = activityOps.getUnparsed();
    if (unparsed.length === 0) {
      log('info', 'parser', '没有待解析的活动');
      return;
    }

    log('info', 'parser', `发现 ${unparsed.length} 个待解析活动`);

    for (const activity of unparsed) {
      try {
        if (!isEraPage(activity.link)) {
          log('info', 'parser', `活动「${activity.title}」为外部链接，跳过解析`);
          activityOps.updateParseResult(activity.id, { parse_status: 2 });
          continue;
        }

        log('info', 'parser', `解析活动页面: 「${activity.title}」`);
        const { fetchHTML } = require('./api');
        const html = await fetchHTML(activity.link);
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
          log('info', 'parser', `活动「${activity.title}」解析成功: ${parseResult.tasks.length}个任务`);
        } else {
          activityOps.updateParseResult(activity.id, { parse_status: 2 });
          log('warn', 'parser', `活动「${activity.title}」解析失败: ${parseResult.error}`);
        }

        // 解析间隔
        await new Promise(r => setTimeout(r, 2000));

      } catch (e) {
        log('error', 'parser', `解析活动「${activity.title}」出错: ${e.message}`);
        activityOps.updateParseResult(activity.id, { parse_status: 2 });
      }
    }
  } catch (e) {
    log('error', 'parser', `解析新活动失败: ${e.message}`);
  }
}

/**
 * 自动执行所有活动任务(根据模式决定行为)
 */
async function runAutoTasks() {
  const mode = settingOps.get('execution_mode', '1');

  if (mode === '2') {
    // 模式二由 runAutoFull 处理，这里跳过
    log('info', 'task', '当前为模式二(任务+抽奖)，跳过独立任务执行');
    return;
  }

  if (mode === '3') {
    // 模式三由 runAutoSuper 处理，这里跳过
    log('info', 'task', '当前为模式三(超级模式)，跳过独立任务执行');
    return;
  }

  // 模式一：独立执行任务
  try {
    const activities = activityOps.getActive();
    const parsedActivities = activities.filter(a => a.parse_status === 1);

    if (parsedActivities.length === 0) {
      log('info', 'task', '没有已解析的活动可执行任务');
      return;
    }

    log('info', 'task', `[模式一] 开始自动执行 ${parsedActivities.length} 个活动的任务`);

    for (const activity of parsedActivities) {
      try {
        await executeForAllAccounts(activity);
      } catch (e) {
        log('error', 'task', `活动「${activity.title}」任务执行失败: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 3000));
    }

    log('info', 'task', '[模式一] 自动任务执行完成');
  } catch (e) {
    log('error', 'task', `自动任务执行失败: ${e.message}`);
  }
}

/**
 * 模式二：自动执行所有活动全流程(任务+抽奖)
 */
async function runAutoFull() {
  try {
    const activities = activityOps.getActive();
    const parsedActivities = activities.filter(a => a.parse_status === 1);

    if (parsedActivities.length === 0) {
      log('info', 'task', '[模式二] 没有已解析的活动');
      return;
    }

    log('info', 'task', `[模式二] 开始执行 ${parsedActivities.length} 个活动的全流程(任务+抽奖)`);

    let totalTaskSuccess = 0;
    let totalLotteryDraws = 0;
    let totalLotteryWins = 0;

    for (const activity of parsedActivities) {
      try {
        const results = await executeFullForAllAccounts(activity);

        for (const r of results) {
          if (r.taskResult) {
            const tc = (r.taskResult.results || []).filter(x => x.status === 'success').length;
            totalTaskSuccess += tc;
          }
          if (r.lotteryResult) {
            totalLotteryDraws += (r.lotteryResult.results || []).length;
            totalLotteryWins += (r.lotteryResult.results || []).filter(x => x.status === 'won').length;
          }
        }
      } catch (e) {
        log('error', 'task', `[模式二] 活动「${activity.title}」全流程执行失败: ${e.message}`);
      }
      await sleep(5000);
    }

    log('info', 'task', `[模式二] 全流程完成: 任务成功${totalTaskSuccess}个, 抽奖${totalLotteryDraws}次, 中奖${totalLotteryWins}次`);
  } catch (e) {
    log('error', 'task', `[模式二] 自动执行失败: ${e.message}`);
  }
}

/**
 * 模式三：超级模式自动执行(抓取→解析→全并发执行)
 */
async function runAutoSuper() {
  try {
    // 第一步：抓取活动列表
    log('info', 'task', '[模式三] 第一步：抓取活动列表...');
    await scrapeActivities();

    // 第二步：解析新活动
    log('info', 'task', '[模式三] 第二步：解析新活动...');
    await parseNewActivities();

    // 第三步：并发执行所有活动的任务+抽奖
    log('info', 'task', '[模式三] 第三步：并发执行任务+抽奖...');
    const result = await executeSuperMode();
    log('info', 'task', `[模式三] 超级模式完成: ${result.message}`);
  } catch (e) {
    log('error', 'task', `[模式三] 超级模式自动执行失败: ${e.message}`);
  }
}

/**
 * 自动对所有已解析活动执行抽奖
 */
async function runAutoLottery() {
  const mode = settingOps.get('execution_mode', '1');
  if (mode === '2') {
    log('info', 'lottery', '当前为模式二(任务+抽奖)，跳过独立抽奖');
    return;
  }
  if (mode === '3') {
    log('info', 'lottery', '当前为模式三(超级模式)，跳过独立抽奖');
    return;
  }

  try {
    const activities = activityOps.getActive();
    const parsedActivities = activities.filter(a => a.parse_status === 1 && a.activity_id && a.appkey && a.app_secret);

    if (parsedActivities.length === 0) {
      log('info', 'lottery', '没有可抽奖的已解析活动');
      return;
    }

    const accounts = accountOps.getEnabled();
    if (accounts.length === 0) {
      log('warn', 'lottery', '没有启用的账户，跳过自动抽奖');
      return;
    }

    log('info', 'lottery', `开始自动抽奖: ${parsedActivities.length} 个活动 × ${accounts.length} 个账户`);

    let totalDraws = 0;
    let totalWins = 0;

    for (const activity of parsedActivities) {
      try {
        const results = await executeAllPlannedLotteriesForActivity(activity);
        const draws = results.reduce((sum, r) => sum + (r.results ? r.results.length : 0), 0);
        const wins = results.reduce((sum, r) => sum + (r.results ? r.results.filter(x => x.status === 'won').length : 0), 0);
        totalDraws += draws;
        totalWins += wins;
        if (draws > 0) {
          log('info', 'lottery', `活动「${activity.title}」: ${draws} 次抽奖, ${wins} 次中奖`);
        }
      } catch (e) {
        log('error', 'lottery', `活动「${activity.title}」抽奖失败: ${e.message}`);
      }
      await sleep(3000);
    }

    log('info', 'lottery', `自动抽奖完成: 共 ${totalDraws} 次抽奖, ${totalWins} 次中奖`);
  } catch (e) {
    log('error', 'lottery', `自动抽奖失败: ${e.message}`);
  }
}

/**
 * 对单个活动执行所有账户的抽奖
 */
async function executeAllPlannedLotteriesForActivity(activity) {
  const { executeLotteryForAllAccounts } = require('./lottery');
  return await executeLotteryForAllAccounts(activity, 0);
}

/**
 * 加载所有抽奖计划
 */
function loadLotteryPlans() {
  const plans = lotteryPlanOps.getAll();
  for (const plan of plans) {
    if (plan.enabled) {
      scheduleJob(`lottery_${plan.id}`, plan.cron_expr, () => {
        return executeAllPlannedLotteries();
      });
    }
  }
  log('info', 'scheduler', `已加载 ${plans.filter(p => p.enabled).length} 个抽奖计划`);
}

/**
 * 添加/更新抽奖计划的定时任务
 */
function rescheduleLottery(planId) {
  const plans = lotteryPlanOps.getAll();
  const plan = plans.find(p => p.id === planId);
  if (!plan) return false;

  if (plan.enabled) {
    scheduleJob(`lottery_${plan.id}`, plan.cron_expr, () => {
      return executeAllPlannedLotteries();
    });
  } else {
    if (jobs[`lottery_${plan.id}`]) {
      jobs[`lottery_${plan.id}`].cancel();
      delete jobs[`lottery_${plan.id}`];
      delete cronExprs[`lottery_${plan.id}`];
    }
  }
  return true;
}

/**
 * 更新调度配置
 */
function updateSchedule(name, cronExpr) {
  settingOps.set(name + '_cron', cronExpr);

  const fnMap = {
    'activity_scrape': scrapeActivities,
    'activity_parse': parseNewActivities,
    'auto_tasks': runAutoTasks,
    'auto_lottery': runAutoLottery,
    'auto_full': runAutoFull,
    'auto_super': runAutoSuper
  };

  if (fnMap[name]) {
    scheduleJob(name, cronExpr, fnMap[name]);
    return true;
  }
  return false;
}

/**
 * 切换执行模式 (1=独立, 2=组合)
 */
function switchMode(newMode) {
  const oldMode = settingOps.get('execution_mode', '1');
  if (oldMode === String(newMode)) return { changed: false, mode: oldMode };

  settingOps.set('execution_mode', String(newMode));

  // 取消旧模式的所有任务
  const oldJobs = oldMode === '3' ? ['auto_super']
    : oldMode === '2' ? ['auto_full', 'activity_scrape', 'activity_parse']
    : ['auto_tasks', 'auto_lottery', 'activity_scrape', 'activity_parse'];
  for (const name of oldJobs) {
    if (jobs[name]) {
      jobs[name].cancel();
      delete jobs[name];
      delete cronExprs[name];
      log('info', 'scheduler', `已取消定时任务: ${name}`);
    }
  }

  // 注册新模式的任务
  if (String(newMode) === '3') {
    // 模式三不需要独立的抓取/解析任务，auto_super 一个任务搞定全流程
    const superCron = settingOps.get('auto_super_cron', '15 * * * *');
    scheduleJob('auto_super', superCron, runAutoSuper);
    log('info', 'scheduler', '已切换到模式三(超级模式-全并发)');
  } else {
    // 模式一/二 需要独立的抓取和解析定时任务
    const activityScrapeCron = settingOps.get('activity_scrape_cron', '0 * * * *');
    scheduleJob('activity_scrape', activityScrapeCron, scrapeActivities);
    const parseCron = settingOps.get('parse_cron', '*/30 * * * *');
    scheduleJob('activity_parse', parseCron, parseNewActivities);

    if (String(newMode) === '2') {
      const fullCron = settingOps.get('auto_full_cron', '15 * * * *');
      scheduleJob('auto_full', fullCron, runAutoFull);
      log('info', 'scheduler', '已切换到模式二(任务+抽奖组合)');
    } else {
      const taskCron = settingOps.get('task_cron', '15 * * * *');
      scheduleJob('auto_tasks', taskCron, runAutoTasks);
      const lotteryCron = settingOps.get('auto_lottery_cron', '0 */2 * * *');
      scheduleJob('auto_lottery', lotteryCron, runAutoLottery);
      log('info', 'scheduler', '已切换到模式一(任务/抽奖独立)');
    }
  }

  // 重新加载抽奖计划的定时任务
  loadLotteryPlans();

  return { changed: true, mode: String(newMode) };
}

/**
 * 获取所有定时任务状态
 */
function getJobStatus() {
  const result = {};
  for (const [name, job] of Object.entries(jobs)) {
    result[name] = {
      name,
      cron_expr: cronExprs[name] || '',
      nextRun: job.nextInvocation() ? job.nextInvocation().toISOString() : null,
      running: job.running || false,
      last_run: job.lastRun || null
    };
  }
  return result;
}

/**
 * 手动触发任务
 */
async function triggerJob(name) {
  const fnMap = {
    'activity_scrape': scrapeActivities,
    'activity_parse': parseNewActivities,
    'auto_tasks': runAutoTasks,
    'auto_lottery': runAutoLottery,
    'auto_full': runAutoFull,
    'auto_super': runAutoSuper,
    'lottery': executeAllPlannedLotteries
  };

  if (fnMap[name]) {
    log('info', 'scheduler', `手动触发任务: ${name}`);
    return await fnMap[name]();
  }
  throw new Error(`未知任务: ${name}`);
}

module.exports = {
  init,
  scheduleJob,
  scrapeActivities,
  parseNewActivities,
  runAutoTasks,
  runAutoFull,
  runAutoSuper,
  runAutoLottery,
  loadLotteryPlans,
  rescheduleLottery,
  updateSchedule,
  switchMode,
  getJobStatus,
  triggerJob
};
