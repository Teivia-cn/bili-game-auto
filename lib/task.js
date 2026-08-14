/**
 * 任务执行器 - 自动完成活动任务
 */
const {
  getTaskDetail,
  reportTask,
  getUserInfo,
  followUser,
  reserveGameVersion,
  log
} = require('./api');
const { activityOps, taskRecordOps, accountOps } = require('./db');

// 延迟加载lottery模块(避免循环依赖)
let _lottery = null;
function getLottery() {
  if (!_lottery) _lottery = require('./lottery');
  return _lottery;
}

/**
 * 延迟函数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 执行单个活动的任务
 * @param {Object} activity - 活动对象(从数据库获取)
 * @param {Object} account - 账户对象
 */
async function executeActivityTasks(activity, account, fast = false) {
  const tasks = activityOps.getTasks(activity.id);
  if (tasks.length === 0) {
    log('info', 'task', `活动「${activity.title}」无任务配置`);
    return { success: true, message: '无任务', results: [] };
  }

  // 检查是否有需要API配置的任务类型(generic/report类)
  const hasApiDependentTasks = tasks.some(t => !t.type || t.type === 'task' || t.type === 'share' || t.type === 'navigate');
  if (hasApiDependentTasks && (!activity.activity_group_id || !activity.appkey || !activity.app_secret)) {
    // 过滤掉需要API配置但缺少配置的任务
    const runnableTasks = tasks.filter(t => t.type === 'follow' || t.type === 'reserve');
    if (runnableTasks.length === 0) {
      log('warn', 'task', `活动「${activity.title}」缺少API配置，跳过`);
      return { success: false, message: '缺少API配置', results: [] };
    }
    log('warn', 'task', `活动「${activity.title}」缺少API配置，仅执行关注/预约任务`);
  }

  const results = [];

  for (const task of tasks) {
    try {
      const taskType = task.type || 'task';
      log('info', 'task', `执行任务: ${task.name} (类型: ${taskType}, ID: ${task.taskId}) - 账户: ${account.name}`);

      // 跳过缺少API配置的任务
      const needsApi = !taskType || taskType === 'task' || taskType === 'share' || taskType === 'navigate';
      if (needsApi && (!activity.activity_group_id || !activity.appkey)) {
        log('warn', 'task', `任务「${task.name}」需要API配置，跳过`);
        results.push({ task: task.name, status: 'skipped', reason: '缺少API配置' });
        continue;
      }

      let result;

      switch (taskType) {
        case 'follow':
          result = await executeFollowTask(task, activity, account);
          break;
        case 'reserve':
          result = await executeReserveTask(task, activity, account);
          break;
        case 'share':
        case 'navigate':
          result = await executeReportTask(task, activity, account);
          break;
        default:
          result = await executeGenericTask(task, activity, account);
          break;
      }

      results.push(result);

      // 任务间隔
      await sleep(fast ? 300 : 1000 + Math.random() * 2000);

    } catch (e) {
      log('error', 'task', `执行任务「${task.name}」出错: ${e.message}`);
      taskRecordOps.upsert(account.id, activity.id, task.taskId, task.name, 'failed', e.message);
      results.push({ task: task.name, status: 'error', error: e.message });
    }
  }

  const successCount = results.filter(r => r.status === 'success' || r.status === 'skipped').length;
  return {
    success: successCount > 0,
    message: `完成 ${successCount}/${tasks.length} 个任务`,
    results
  };
}

/**
 * 执行关注任务
 */
async function executeFollowTask(task, activity, account) {
  if (!task.followMid) {
    log('warn', 'task', `关注任务「${task.name}」缺少目标用户ID`);
    taskRecordOps.upsert(account.id, activity.id, task.taskId, task.name, 'failed', '缺少目标用户ID');
    return { task: task.name, status: 'failed', error: '缺少目标用户ID' };
  }

  try {
    const followResult = await followUser(task.followMid, account.cookie);
    if (followResult && followResult.code === 0) {
      log('info', 'task', `关注用户 ${task.followMid} 成功`);
      taskRecordOps.upsert(account.id, activity.id, task.taskId, task.name, 'success', JSON.stringify(followResult));
      return { task: task.name, status: 'success', data: followResult };
    } else {
      // code 22013 表示已经关注过了
      if (followResult && followResult.code === 22013) {
        log('info', 'task', `已经关注过用户 ${task.followMid}`);
        taskRecordOps.upsert(account.id, activity.id, task.taskId, task.name, 'success', '已关注');
        return { task: task.name, status: 'skipped', reason: '已关注' };
      }
      const msg = followResult ? followResult.message : '未知错误';
      log('warn', 'task', `关注用户失败: ${msg}`);
      taskRecordOps.upsert(account.id, activity.id, task.taskId, task.name, 'failed', msg);
      return { task: task.name, status: 'failed', error: msg };
    }
  } catch (e) {
    log('error', 'task', `关注用户异常: ${e.message}`);
    taskRecordOps.upsert(account.id, activity.id, task.taskId, task.name, 'failed', e.message);
    return { task: task.name, status: 'error', error: e.message };
  }
}

/**
 * 执行预约游戏任务
 */
async function executeReserveTask(task, activity, account) {
  if (!task.gameVersionId) {
    log('warn', 'task', `预约任务「${task.name}」缺少游戏版本ID`);
    taskRecordOps.upsert(account.id, activity.id, task.taskId, task.name, 'failed', '缺少游戏版本ID');
    return { task: task.name, status: 'failed', error: '缺少游戏版本ID' };
  }

  try {
    const reserveResult = await reserveGameVersion(task.gameVersionId, task.sdkType, account.cookie);
    if (reserveResult && reserveResult.code === 0) {
      log('info', 'task', `预约游戏 ${task.gameVersionId} 成功`);
      taskRecordOps.upsert(account.id, activity.id, task.taskId, task.name, 'success', JSON.stringify(reserveResult));
      return { task: task.name, status: 'success', data: reserveResult };
    } else {
      const msg = reserveResult ? reserveResult.message : '未知错误';
      log('warn', 'task', `预约游戏失败: ${msg}`);
      taskRecordOps.upsert(account.id, activity.id, task.taskId, task.name, 'failed', msg);
      return { task: task.name, status: 'failed', error: msg };
    }
  } catch (e) {
    log('error', 'task', `预约游戏异常: ${e.message}`);
    taskRecordOps.upsert(account.id, activity.id, task.taskId, task.name, 'failed', e.message);
    return { task: task.name, status: 'error', error: e.message };
  }
}

/**
 * 执行需要上报的任务(share/navigate)
 */
async function executeReportTask(task, activity, account) {
  // 分享/浏览任务需要有activity_group_id和appkey才能上报
  if (!activity.activity_group_id || !activity.appkey) {
    log('warn', 'task', `活动「${activity.title}」缺少API配置，无法上报`);
    taskRecordOps.upsert(account.id, activity.id, task.taskId, task.name, 'failed', '缺少API配置');
    return { task: task.name, status: 'failed', error: '缺少API配置' };
  }

  // 检查activity_id是否为有效数字(非ACT开头的字符串)
  const reportTaskId = activity.activity_id;
  if (!reportTaskId || !/^\d+$/.test(reportTaskId)) {
    log('info', 'task', `任务「${task.name}」无有效数字任务ID(${reportTaskId || '空'})，跳过(通常由其他任务组件上报)`);
    taskRecordOps.upsert(account.id, activity.id, task.taskId, task.name, 'skipped', '无有效任务ID');
    return { task: task.name, status: 'skipped', reason: '无有效任务ID' };
  }

  try {
    const reportResult = await reportTask(
      reportTaskId,
      activity.activity_group_id,
      activity.activity_id || activity.id,
      activity.appkey,
      activity.app_secret,
      account.cookie
    );

    if (reportResult && reportResult.code === 0) {
      log('info', 'task', `任务「${task.name}」上报成功`);
      taskRecordOps.upsert(account.id, activity.id, task.taskId, task.name, 'success', JSON.stringify(reportResult));
      return { task: task.name, status: 'success', data: reportResult };
    } else {
      const msg = reportResult ? reportResult.message : '未知错误';
      log('warn', 'task', `任务「${task.name}」上报失败: ${msg}`);
      taskRecordOps.upsert(account.id, activity.id, task.taskId, task.name, 'failed', msg);
      return { task: task.name, status: 'failed', error: msg };
    }
  } catch (e) {
    log('error', 'task', `任务「${task.name}」上报异常: ${e.message}`);
    taskRecordOps.upsert(account.id, activity.id, task.taskId, task.name, 'failed', e.message);
    return { task: task.name, status: 'error', error: e.message };
  }
}

/**
 * 执行通用任务(带详情检查+重试上报)
 */
async function executeGenericTask(task, activity, account) {
  // 先获取任务详情
  let taskDetail = null;
  try {
    taskDetail = await getTaskDetail(
      task.taskId,
      activity.activity_group_id,
      activity.appkey,
      activity.app_secret,
      account.cookie
    );
    log('info', 'task', `任务详情: ${JSON.stringify(taskDetail)}`);
  } catch (e) {
    log('warn', 'task', `获取任务详情失败: ${e.message}`);
  }

  // 检查任务状态
  if (taskDetail && taskDetail.code === 0 && taskDetail.data) {
    const status = taskDetail.data.status;
    const completeCount = taskDetail.data.period_complete_count || 0;
    const completeLimit = taskDetail.data.period_complete_limit || 0;

    if (status === 2 || status === 'completed') {
      // 检查是否可重复完成
      if (completeLimit > 0 && completeCount < completeLimit) {
        log('info', 'task', `任务「${task.name}」已完成${completeCount}/${completeLimit}次，继续上报`);
      } else if (completeLimit === 0) {
        // limit=0 可能表示无限制，允许继续上报
        log('info', 'task', `任务「${task.name}」状态已完成但无次数限制，继续上报`);
      } else {
        log('info', 'task', `任务「${task.name}」已完成${completeCount}/${completeLimit}次，跳过`);
        taskRecordOps.upsert(account.id, activity.id, task.taskId, task.name, 'success', '已完成');
        return { task: task.name, status: 'skipped', reason: `已完成${completeCount}/${completeLimit}次` };
      }
    }
  }

  // 执行任务上报(带重试)
  const maxRetries = task.retryOnFailure ? 3 : 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const reportResult = await reportTask(
        task.taskId,
        activity.activity_group_id,
        activity.activity_id || activity.id,
        activity.appkey,
        activity.app_secret,
        account.cookie
      );

      if (reportResult && reportResult.code === 0) {
        log('info', 'task', `任务「${task.name}」上报成功`);
        taskRecordOps.upsert(account.id, activity.id, task.taskId, task.name, 'success', JSON.stringify(reportResult));
        return { task: task.name, status: 'success', data: reportResult };
      } else {
        const msg = reportResult ? reportResult.message : '未知错误';
        log('warn', 'task', `任务「${task.name}」上报失败(尝试${attempt}): ${msg}`);
        lastError = msg;
        if (attempt < maxRetries) {
          await sleep(2000 * attempt);
        }
      }
    } catch (e) {
      lastError = e.message;
      log('error', 'task', `任务「${task.name}」上报异常(尝试${attempt}): ${e.message}`);
      if (attempt < maxRetries) {
        await sleep(2000 * attempt);
      }
    }
  }

  taskRecordOps.upsert(account.id, activity.id, task.taskId, task.name, 'failed', lastError);
  return { task: task.name, status: 'failed', error: lastError };
}

/**
 * 模式二：完成活动任务后立即抽奖
 * @param {Object} activity - 活动对象
 * @param {Object} account - 账户对象
 * @returns {Object} 综合结果
 */
async function executeActivityFull(activity, account) {
  log('info', 'task', `[模式二] 为账户「${account.name}」执行活动「${activity.title}」全流程`);

  // 步骤1: 完成任务
  const taskResult = await executeActivityTasks(activity, account);
  log('info', 'task', `[模式二] 任务完成: ${taskResult.message}`);

  // 任务间隔
  await sleep(2000 + Math.random() * 2000);

  // 步骤2: 抽奖
  let lotteryResult = null;
  const lotteryActId = activity.lottery_activity_id || activity.activity_id;
  if (lotteryActId && activity.activity_group_id && activity.appkey && activity.app_secret) {
    try {
      const lottery = getLottery();
      lotteryResult = await lottery.executeLottery(activity, account, 0);
      log('info', 'task', `[模式二] 抽奖完成: ${lotteryResult.message}`);
    } catch (e) {
      log('error', 'task', `[模式二] 抽奖失败: ${e.message}`);
      lotteryResult = { success: false, message: e.message, results: [] };
    }
  } else {
    log('info', 'task', `[模式二] 活动「${activity.title}」无抽奖配置，跳过抽奖`);
  }

  return {
    account: account.name,
    taskResult,
    lotteryResult
  };
}

/**
 * 模式二：为所有启用账户执行活动全流程(任务+抽奖)
 */
async function executeFullForAllAccounts(activity) {
  const accounts = accountOps.getEnabled();
  if (accounts.length === 0) {
    log('warn', 'task', '没有启用的账户');
    return [];
  }

  const allResults = [];
  for (const account of accounts) {
    try {
      const result = await executeActivityFull(activity, account);
      allResults.push(result);
    } catch (e) {
      log('error', 'task', `账户「${account.name}」全流程执行出错: ${e.message}`);
      allResults.push({ account: account.name, taskResult: { success: false, error: e.message }, lotteryResult: null });
    }
    await sleep(3000 + Math.random() * 3000);
  }

  return allResults;
}

/**
 * 为所有启用的账户执行活动任务
 * @param {Object} activity - 活动对象
 */
async function executeForAllAccounts(activity) {
  const accounts = accountOps.getEnabled();
  if (accounts.length === 0) {
    log('warn', 'task', '没有启用的账户');
    return [];
  }

  const allResults = [];
  for (const account of accounts) {
    try {
      log('info', 'task', `为账户「${account.name}」执行活动「${activity.title}」的任务`);
      const result = await executeActivityTasks(activity, account);
      allResults.push({ account: account.name, ...result });
    } catch (e) {
      log('error', 'task', `账户「${account.name}」执行任务出错: ${e.message}`);
      allResults.push({ account: account.name, success: false, error: e.message });
    }
    // 账户间隔
    await sleep(2000 + Math.random() * 3000);
  }

  return allResults;
}

/**
 * 模式三：超级模式 - 全部顺序执行(任务→抽奖，逐账户逐活动)
 * 活动依次处理，每个账户依次执行，先任务后抽奖，留足延迟避免风控
 */
async function executeSuperMode() {
  const accounts = accountOps.getEnabled();
  if (accounts.length === 0) {
    log('warn', 'task', '[模式三] 没有启用的账户');
    return { success: false, message: '没有启用的账户', results: [] };
  }

  const activities = activityOps.getActive().filter(a => a.parse_status === 1);
  if (activities.length === 0) {
    log('warn', 'task', '[模式三] 没有已解析的活动');
    return { success: false, message: '没有已解析的活动', results: [] };
  }

  log('info', 'task', `[模式三] 开始超级模式: ${activities.length} 个活动 × ${accounts.length} 个账户(全顺序)`);

  const allResults = [];

  for (const activity of activities) {
    log('info', 'task', `[模式三] 处理活动「${activity.title}」`);

    for (const account of accounts) {
      const lottery = getLottery();

      // 先执行任务
      let taskRes;
      try {
        taskRes = await executeActivityTasks(activity, account);
      } catch (e) {
        taskRes = { success: false, message: e.message, results: [] };
      }

      // 任务完成后等待一段时间再抽奖(让服务器处理完任务状态)
      await sleep(3000 + Math.random() * 2000);

      let lotteryRes;
      try {
        lotteryRes = await lottery.executeLottery(activity, account, 0);
      } catch (e) {
        lotteryRes = { success: false, message: e.message, results: [] };
      }

      log('info', 'task', `[模式三] 账户「${account.name}」活动「${activity.title}」: 任务=${taskRes.message}, 抽奖=${lotteryRes.message}`);

      allResults.push({
        account: account.name,
        taskResult: taskRes,
        lotteryResult: lotteryRes
      });

      // 账户间延迟
      await sleep(5000 + Math.random() * 3000);
    }

    // 活动间延迟
    await sleep(5000 + Math.random() * 5000);
  }

  const totalTasks = allResults.reduce((sum, r) => sum + (r.taskResult?.results?.length || 0), 0);
  const totalDraws = allResults.reduce((sum, r) => sum + (r.lotteryResult?.results?.length || 0), 0);
  const totalWins = allResults.reduce((sum, r) => sum + (r.lotteryResult?.results?.filter(x => x.status === 'won').length || 0), 0);

  log('info', 'task', `[模式三] 超级模式完成: ${totalTasks} 个任务, ${totalDraws} 次抽奖, ${totalWins} 次中奖`);

  return {
    success: true,
    message: `超级模式完成: ${activities.length} 活动, ${totalTasks} 任务, ${totalDraws} 抽奖, ${totalWins} 中奖`,
    results: allResults
  };
}

/**
 * 验证账户cookie是否有效
 */
async function validateAccount(account) {
  try {
    const info = await getUserInfo(account.cookie);
    if (info.isLogin) {
      accountOps.updateUid(account.id, String(info.uid));
      log('info', 'account', `账户「${account.name}」验证成功: ${info.uname} (${info.uid})`);
      return { valid: true, info };
    }
    return { valid: false, reason: 'Cookie已过期' };
  } catch (e) {
    return { valid: false, reason: e.message };
  }
}

module.exports = {
  executeActivityTasks,
  executeActivityFull,
  executeForAllAccounts,
  executeFullForAllAccounts,
  executeSuperMode,
  validateAccount,
  sleep
};
