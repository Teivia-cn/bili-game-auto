/**
 * 抽奖模块 - 自动执行抽奖
 */
const {
  getLotteryChance,
  drawLottery,
  log
} = require('./api');
const {
  activityOps,
  lotteryRecordOps,
  lotteryPlanOps,
  accountOps
} = require('./db');
const { sleep } = require('./task');

/**
 * 执行单个活动的抽奖
 * @param {Object} activity - 活动对象
 * @param {Object} account - 账户对象
 * @param {number} maxDraws - 最大抽奖次数(0=全部用完)
 */
async function executeLottery(activity, account, maxDraws = 0, fast = false) {
  // 抽奖使用 lottery_activity_id（可能与 task 的 activity_id 不同）
  const lotteryActId = activity.lottery_activity_id || activity.activity_id;
  if (!activity.activity_group_id || !activity.appkey || !activity.app_secret || !lotteryActId) {
    log('warn', 'lottery', `活动「${activity.title}」缺少抽奖配置，跳过`);
    return { success: false, message: '缺少抽奖配置', results: [] };
  }

  const results = [];

  try {
    // 先查询剩余抽奖机会
    const chanceResult = await getLotteryChance(
      lotteryActId,
      activity.activity_group_id,
      activity.appkey,
      activity.app_secret,
      account.cookie
    );

    let chances = 0;
    if (chanceResult && chanceResult.code === 0 && chanceResult.data) {
      chances = chanceResult.data.remained ?? chanceResult.data.lottery_chance ?? chanceResult.data.chance ?? 0;
      log('info', 'lottery', `账户「${account.name}」在活动「${activity.title}」剩余 ${chances} 次抽奖机会`);
    } else {
      const msg = chanceResult ? chanceResult.message : '未知错误';
      log('warn', 'lottery', `查询抽奖机会失败: ${msg}`);
      // 即使查询失败也尝试抽奖
      chances = maxDraws || 1;
    }

    if (chances <= 0) {
      log('info', 'lottery', `账户「${account.name}」在活动「${activity.title}」无抽奖机会`);
      return { success: true, message: '无抽奖机会', results: [] };
    }

    // 确定实际抽奖次数
    const drawCount = maxDraws > 0 ? Math.min(chances, maxDraws) : chances;
    log('info', 'lottery', `准备抽奖 ${drawCount} 次`);

    for (let i = 0; i < drawCount; i++) {
      try {
        // 创建抽奖记录
        const record = lotteryRecordOps.add(
          account.id,
          activity.id,
          activity.activity_group_id
        );

        const result = await drawLottery(
          lotteryActId,
          activity.activity_group_id,
          activity.appkey,
          activity.app_secret,
          account.cookie
        );

        if (result && result.code === 0) {
          const prizeName = result.data ? (result.data.prize_name || result.data.name || '未知奖品') : '未知';
          // "谢谢参与"不算中奖
          const isConsolation = prizeName === '谢谢参与' || prizeName.includes('谢谢参与');
          const isWin = result.data && result.data.is_win !== false && prizeName !== '未知奖品' && !isConsolation;

          lotteryRecordOps.updateResult(
            record.lastInsertRowid,
            isWin ? 'won' : 'no_prize',
            prizeName,
            JSON.stringify(result)
          );

          log('info', 'lottery', `抽奖结果: ${isWin ? '中奖' : '未中奖'} - ${prizeName}`);
          results.push({
            draw: i + 1,
            status: isWin ? 'won' : 'no_prize',
            prize: prizeName,
            data: result
          });
        } else {
          const msg = result ? result.message : '未知错误';
          lotteryRecordOps.updateResult(record.lastInsertRowid, 'failed', '', JSON.stringify(result));
          log('warn', 'lottery', `抽奖失败: ${msg}`);
          results.push({ draw: i + 1, status: 'failed', error: msg });

          // 如果是次数不足，停止后续抽奖
          if (msg.includes('chance') || msg.includes('次数') || msg.includes('不足')) {
            log('info', 'lottery', '抽奖次数不足，停止');
            break;
          }
        }

        // 抽奖间隔
        await sleep(fast ? 500 : 1500 + Math.random() * 2000);

      } catch (e) {
        log('error', 'lottery', `抽奖异常: ${e.message}`);
        results.push({ draw: i + 1, status: 'error', error: e.message });
      }
    }

  } catch (e) {
    log('error', 'lottery', `执行抽奖出错: ${e.message}`);
    return { success: false, message: e.message, results };
  }

  const wonCount = results.filter(r => r.status === 'won').length;
  return {
    success: true,
    message: `抽奖 ${results.length} 次${wonCount > 0 ? `，中奖 ${wonCount} 次` : ''}`,
    results
  };
}

/**
 * 为所有启用账户执行抽奖
 */
async function executeLotteryForAllAccounts(activity, maxDraws = 0) {
  const accounts = accountOps.getEnabled();
  if (accounts.length === 0) {
    log('warn', 'lottery', '没有启用的账户');
    return [];
  }

  const allResults = [];
  for (const account of accounts) {
    try {
      log('info', 'lottery', `为账户「${account.name}」执行活动「${activity.title}」的抽奖`);
      const result = await executeLottery(activity, account, maxDraws);
      allResults.push({ account: account.name, ...result });
    } catch (e) {
      log('error', 'lottery', `账户「${account.name}」抽奖出错: ${e.message}`);
      allResults.push({ account: account.name, success: false, error: e.message });
    }
    await sleep(3000 + Math.random() * 5000);
  }

  return allResults;
}

/**
 * 执行所有已计划活动的抽奖
 */
async function executeAllPlannedLotteries() {
  const plans = lotteryPlanOps.getEnabled();
  if (plans.length === 0) {
    log('info', 'lottery', '没有启用的抽奖计划');
    return;
  }

  log('info', 'scheduler', `开始执行 ${plans.length} 个抽奖计划`);

  for (const plan of plans) {
    try {
      const activity = activityOps.getById(plan.activity_id);
      if (!activity) {
        log('warn', 'scheduler', `活动 ${plan.activity_id} 不存在，跳过`);
        continue;
      }

      // 检查活动是否仍在进行中
      if (activity.end_time && new Date(activity.end_time) < new Date()) {
        log('info', 'scheduler', `活动「${activity.title}」已结束，跳过`);
        continue;
      }

      log('info', 'scheduler', `执行抽奖计划: 「${activity.title}」`);
      const results = await executeLotteryForAllAccounts(activity);

      // 更新最后执行时间
      lotteryPlanOps.updateLastRun(plan.id);

      // 记录结果摘要
      const totalDraws = results.reduce((sum, r) => sum + (r.results ? r.results.length : 0), 0);
      const totalWins = results.reduce((sum, r) => sum + (r.results ? r.results.filter(x => x.status === 'won').length : 0), 0);
      log('info', 'scheduler', `抽奖计划完成: 共 ${totalDraws} 次抽奖，${totalWins} 次中奖`);

    } catch (e) {
      log('error', 'scheduler', `执行抽奖计划出错: ${e.message}`);
    }

    // 计划间隔
    await sleep(5000);
  }
}

module.exports = {
  executeLottery,
  executeLotteryForAllAccounts,
  executeAllPlannedLotteries
};
