/**
 * 活动页面解析器 - 从B站era活动页面提取任务和抽奖配置
 */
const { log } = require('./api');

/**
 * 从HTML中提取 __BILIACT_EVAPAGEDATA__ 数据
 */
function extractPageData(html) {
  // 方法1: 直接匹配 window.__BILIACT_EVAPAGEDATA__ = {...}
  const marker = 'window.__BILIACT_EVAPAGEDATA__';
  const idx = html.indexOf(marker);
  if (idx < 0) return null;

  // 找到 = 号后面的JSON
  const eqIdx = html.indexOf('=', idx);
  if (eqIdx < 0) return null;

  const jsonStart = eqIdx + 1;
  // 跳过空白
  let start = jsonStart;
  while (start < html.length && /\s/.test(html[start])) start++;

  if (html[start] !== '{') return null;

  // 大括号计数法提取完整JSON
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = start;

  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }

  if (depth !== 0) return null;

  try {
    return JSON.parse(html.slice(start, end));
  } catch (e) {
    log('error', 'parser', 'JSON解析失败', e.message);
    return null;
  }
}

/**
 * 从layerTree中递归提取所有组件及其配置
 */
function extractComponents(layerTree) {
  const components = [];

  function walk(layers) {
    if (!layers || !Array.isArray(layers)) return;
    for (const layer of layers) {
      if (layer.name && layer.props) {
        components.push({
          name: layer.name,
          label: layer.label || '',
          props: layer.props,
          uuid: layer.uuid || ''
        });
      }
      if (layer.slots && Array.isArray(layer.slots)) {
        for (const slot of layer.slots) {
          if (slot.children) {
            walk(slot.children);
          }
        }
      }
    }
  }

  walk(layerTree);
  return components;
}

/**
 * 解析活动页面，提取任务和抽奖配置
 * @param {string} html - 活动页面HTML
 * @returns {Object} 解析结果
 */
function parseActivityPage(html) {
  const pageData = extractPageData(html);
  if (!pageData) {
    return { success: false, error: '未找到页面数据(__BILIACT_EVAPAGEDATA__)' };
  }

  const components = extractComponents(pageData.layerTree || []);
  log('info', 'parser', `解析到 ${components.length} 个组件`);

  // 提取voucherData（从任意包含它的组件中获取）
  let voucherData = null;
  let activityGroupId = '';
  let activityId = '';
  let lotteryActivityId = '';

  // 提取任务列表
  const tasks = [];
  // 提取抽奖配置
  const lotteryConfigs = [];

  for (const comp of components) {
    const ac = comp.props.activityConfig;
    const ectl = comp.props.eventsControlList || [];
    const reportEntry = ectl.find(e => e.action === 'report');

    // 获取voucherData(需要activityConfig)
    if (ac) {
      if (ac.voucherData && !voucherData) {
        voucherData = ac.voucherData;
        activityGroupId = ac.activityGroupId || ac.voucherData.activity_group_id || '';
        activityId = ac.activityId || '';
      }
    }

    // 提取任务组件 (GameTaskLog)
    if (comp.name === 'GameTaskLog' && ac && ac.taskId) {
      tasks.push({
        taskId: ac.taskId,
        name: comp.label || `任务${ac.taskId}`,
        type: 'task',
        activityId: ac.activityId || activityId,
        autoReportOnce: comp.props.autoReportOnce || false,
        retryOnFailure: comp.props.retryOnFailure || false,
        displayAlert: comp.props.displayAlert || false
      });
    }

    // 提取关注按钮 (GameFollowBtn) - 关注UP主
    if (comp.name === 'GameFollowBtn') {
      const mid = comp.props.officalId || comp.props.mid || comp.props.followMid || '';
      if (mid) {
        tasks.push({
          taskId: `follow_${mid}`,
          name: comp.label || `关注${mid}`,
          type: 'follow',
          followMid: mid,
          reportTarget: reportEntry ? reportEntry.target : '',
          activityGroupId: (ac && ac.activityGroupId) || activityGroupId
        });
      }
    }

    // 提取预约按钮 (GameVersionReserve) - 预约游戏版本
    if (comp.name === 'GameVersionReserve') {
      const gc = comp.props.gameConfig || {};
      const gameBaseId = gc.gameBaseId || (comp.props.gameBaseId ? comp.props.gameBaseId.gameBaseId : '');
      const gameVersionId = gc.gameVersionId || '';
      const sdkType = comp.props.reserveSdkType || 1;
      if (gameVersionId) {
        tasks.push({
          taskId: `reserve_${gameVersionId}`,
          name: comp.label || '预约游戏',
          type: 'reserve',
          gameBaseId: gameBaseId,
          gameVersionId: gameVersionId,
          sdkType: sdkType,
          reportTarget: reportEntry ? reportEntry.target : '',
          activityGroupId: (ac && ac.activityGroupId) || activityGroupId
        });
      }
    }

    // 提取分享按钮 (GameShareBtnH5 / GameShareBtnPc)
    if (comp.name === 'GameShareBtnH5' || comp.name === 'GameShareBtnPc') {
      tasks.push({
        taskId: `share_${comp.uuid || 'btn'}`,
        name: comp.label || '分享',
        type: 'share',
        reportTarget: reportEntry ? reportEntry.target : '',
        activityGroupId: (ac && ac.activityGroupId) || activityGroupId
      });
    }

    // 提取导航按钮 (GameNavigateButton) - 滚动/跳转
    // 注意: 大部分导航按钮只是页面内滚动，没有可上报的任务
    if (comp.name === 'GameNavigateButton' && reportEntry) {
      tasks.push({
        taskId: `nav_${reportEntry.target || comp.uuid || 'btn'}`,
        name: comp.label || '浏览',
        type: 'navigate',
        href: comp.props.href || '',
        reportTarget: reportEntry.target || '',
        activityGroupId: (ac && ac.activityGroupId) || activityGroupId
      });
    }

    // 提取抽奖组件
    if (comp.name === 'GameLottery' && ac) {
      const lotteryActId = ac.activityId || activityId;
      if (!lotteryActivityId) lotteryActivityId = lotteryActId;
      lotteryConfigs.push({
        activityId: lotteryActId,
        activityGroupId: ac.activityGroupId || activityGroupId,
        type: 'draw'
      });
    }

    // 提取抽奖机会组件
    if (comp.name === 'GameLotteryChance' && ac) {
      lotteryConfigs.push({
        activityId: ac.activityId || activityId,
        activityGroupId: ac.activityGroupId || activityGroupId,
        type: 'chance'
      });
    }
  }

  // 去重任务
  const uniqueTasks = [];
  const seenTaskIds = new Set();
  for (const task of tasks) {
    const key = `${task.taskId}_${task.activityId}`;
    if (!seenTaskIds.has(key)) {
      seenTaskIds.add(key);
      uniqueTasks.push(task);
    }
  }

  const result = {
    success: true,
    activityGroupId,
    activityId,
    lotteryActivityId,
    appkey: voucherData ? voucherData.appkey : '',
    appSecret: voucherData ? voucherData.app_secret : '',
    tasks: uniqueTasks,
    lotteryConfigs,
    componentCount: components.length
  };

  log('info', 'parser', `解析完成: ${uniqueTasks.length}个任务, ${lotteryConfigs.length}个抽奖配置`);
  return result;
}

/**
 * 判断活动链接是否为era页面
 */
function isEraPage(link) {
  return link.includes('/blackboard/era/') || link.includes('/blackboard/');
}

/**
 * 判断活动链接是否为外部链接
 */
function isExternalLink(link) {
  return !link.includes('bilibili.com/blackboard/');
}

module.exports = {
  extractPageData,
  extractComponents,
  parseActivityPage,
  isEraPage,
  isExternalLink
};
