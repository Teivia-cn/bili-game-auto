/**
 * B站API客户端 - 签名机制 + 活动/任务/抽奖接口
 */
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { logOps } = require('./db');

// ============ 常量 ============
const GAME_API_BASE = 'https://le3-api.game.bilibili.com';
const BILI_API_BASE = 'https://api.bilibili.com';
const DEFAULT_APPKEY = 'Ltxpr41KvL0Kg5IDXP2EPf88TK2j0zpW';
const ACTIVITY_API_BASE = GAME_API_BASE + '/activity';

const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.bilibili.com/',
  'Origin': 'https://www.bilibili.com'
};

// ============ HTTP请求封装 ============
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    // 预先计算body buffer，以便设置Content-Length
    let bodyBuf = null;
    if (options.body) {
      const bodyStr = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      bodyBuf = Buffer.from(bodyStr, 'utf-8');
    }

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: { ...COMMON_HEADERS, ...options.headers },
      timeout: options.timeout || 15000
    };

    if (bodyBuf) {
      reqOptions.headers['Content-Length'] = bodyBuf.length;
    }

    const req = lib.request(reqOptions, (res) => {
      // 跟随重定向
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        return resolve(request(res.headers.location, options));
      }

      let data = '';
      res.setEncoding('utf-8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json, headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, data: data, headers: res.headers });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (bodyBuf) {
      req.write(bodyBuf);
    }

    req.end();
  });
}

// 获取HTML页面内容
function fetchHTML(url, cookie = '') {
  const headers = { ...COMMON_HEADERS };
  if (cookie) headers.Cookie = cookie;
  return request(url, { headers }).then(res => {
    if (typeof res.data === 'string') return res.data;
    throw new Error(`Failed to fetch HTML: status ${res.status}`);
  });
}

// ============ 签名机制 ============
/**
 * 生成随机nonce
 */
function generateNonce() {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let random = '';
  for (let i = 0; i < 10; i++) {
    random += chars[Math.round(Math.random() * (chars.length - 1))];
  }
  return Date.now() + random;
}

/**
 * MD5哈希
 */
function md5(str) {
  return crypto.createHash('md5').update(str, 'utf-8').digest('hex');
}

/**
 * 生成API签名
 * @param {Object} params - 请求参数
 * @param {string} secret - 密钥(app_secret或默认密钥)
 * @returns {Object} 带签名的参数
 */
function signParams(params, secret = DEFAULT_APPKEY) {
  const data = { ...params };
  data.nonce = generateNonce();
  data.ts = Date.now();

  // 过滤空值
  const keys = Object.keys(data).sort();
  const parts = [];
  for (const key of keys) {
    if (data[key] !== undefined && data[key] !== null && data[key] !== '') {
      parts.push(`${key}=${data[key]}`);
    }
  }

  const signStr = parts.join('&') + '&secret=' + secret;
  data.sign = md5(signStr);

  return data;
}

// ============ 游戏中心API ============
/**
 * 获取活动列表
 */
async function fetchActivityList(pageNum = 1, pageSize = 50) {
  const url = `${GAME_API_BASE}/pc/game/home/activity_list?page_num=${pageNum}&page_size=${pageSize}`;
  const res = await request(url);
  if (res.data && res.data.code === 0) {
    return res.data.data || [];
  }
  throw new Error(`获取活动列表失败: ${JSON.stringify(res.data)}`);
}

/**
 * 获取活动页面HTML
 */
async function fetchActivityPage(link, cookie = '') {
  return fetchHTML(link, cookie);
}

// ============ 街机活动API(需要签名) ============

/**
 * 获取任务详情
 */
async function getTaskDetail(taskId, activityGroupId, appkey, appSecret, cookie = '') {
  const params = signParams({
    task_id: taskId,
    activity_group_id: activityGroupId,
    appkey: appkey
  }, appSecret);

  const queryString = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const url = `${ACTIVITY_API_BASE}/api/game/arcade/common/task/detail?${queryString}`;
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  const res = await request(url, { headers });
  return res.data;
}

/**
 * 上报任务完成
 */
async function reportTask(taskId, activityGroupId, activityId, appkey, appSecret, cookie) {
  // 浏览器实际只发送 task_id, activity_group_id, appkey 三个参数参与签名
  const params = signParams({
    task_id: taskId,
    activity_group_id: activityGroupId,
    appkey: appkey
  }, appSecret);

  const url = `${ACTIVITY_API_BASE}/api/game/arcade/common/task/report`;
  const res = await request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookie
    },
    body: params
  });
  return res.data;
}

/**
 * 获取抽奖机会
 */
async function getLotteryChance(activityId, activityGroupId, appkey, appSecret, cookie = '') {
  const params = signParams({
    activity_id: activityId,
    activity_group_id: activityGroupId,
    appkey: appkey
  }, appSecret);

  const queryString = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const url = `${ACTIVITY_API_BASE}/api/game/arcade/common/lottery/chance?${queryString}`;
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  const res = await request(url, { headers });
  return res.data;
}

/**
 * 执行抽奖
 */
async function drawLottery(activityId, activityGroupId, appkey, appSecret, cookie) {
  // 浏览器发送 activity_id, activity_group_id, appkey, buvid, platform
  const buvid = extractBuvidFromCookie(cookie);
  const params = signParams({
    activity_id: activityId,
    activity_group_id: activityGroupId,
    appkey: appkey,
    buvid: buvid,
    platform: 'web'
  }, appSecret);

  const url = `${ACTIVITY_API_BASE}/api/game/arcade/common/lottery/draw`;
  const res = await request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookie
    },
    body: params
  });
  return res.data;
}

/**
 * 关注B站用户
 * @param {string} mid - 要关注的用户UID
 * @param {string} cookie - B站cookie
 */
async function followUser(mid, cookie) {
  const csrf = extractCsrfFromCookie(cookie);
  const body = `fid=${mid}&act=1&re_src=78&csrf=${csrf}`;

  const url = `${BILI_API_BASE}/x/relation/modify`;
  const res = await request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookie
    },
    body: body
  });
  return res.data;
}

/**
 * 预约游戏版本
 * @param {string} gameVersionId - 游戏版本ID
 * @param {number} sdkType - SDK类型(默认1)
 * @param {string} cookie - B站cookie
 */
async function reserveGameVersion(gameVersionId, sdkType, cookie) {
  const csrf = extractCsrfFromCookie(cookie);
  const body = `game_version_id=${gameVersionId}&sdk_type=${sdkType || 1}&csrf_token=${csrf}`;

  const url = `https://le1-api.game.bilibili.com/mobile/game/center/h5/act/version/reserve`;
  const res = await request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookie
    },
    body: body
  });
  return res.data;
}

/**
 * 获取用户信息(验证cookie)
 */
async function getUserInfo(cookie) {
  const url = `${BILI_API_BASE}/x/web-interface/nav`;
  const res = await request(url, {
    headers: { 'Cookie': cookie }
  });
  if (res.data && res.data.code === 0) {
    return {
      uid: res.data.data.mid,
      uname: res.data.data.uname,
      face: res.data.data.face,
      isLogin: true
    };
  }
  return { isLogin: false };
}

/**
 * 获取游戏中心用户信息
 */
async function getGameUserInfo(cookie) {
  const url = `${GAME_API_BASE}/pc/game/user/myinfo`;
  const res = await request(url, {
    headers: { 'Cookie': cookie }
  });
  if (res.data && res.data.code === 0) {
    return res.data.data;
  }
  return null;
}

// ============ 工具函数 ============
function extractCsrfFromCookie(cookie) {
  const match = cookie.match(/bili_jct=([^;]+)/);
  return match ? match[1] : '';
}

function extractBuvidFromCookie(cookie) {
  const match = cookie.match(/buvid3=([^;]+)/);
  return match ? match[1] : '';
}

function log(level, module, message, detail) {
  console.log(`[${level.toUpperCase()}] [${module}] ${message}`);
  try {
    logOps.add(level, module, message, detail);
  } catch (e) {
    // 忽略日志写入错误
  }
}

module.exports = {
  request,
  fetchHTML,
  fetchActivityList,
  fetchActivityPage,
  getTaskDetail,
  reportTask,
  getLotteryChance,
  drawLottery,
  getUserInfo,
  getGameUserInfo,
  followUser,
  reserveGameVersion,
  signParams,
  generateNonce,
  md5,
  log,
  GAME_API_BASE,
  ACTIVITY_API_BASE,
  BILI_API_BASE,
  DEFAULT_APPKEY
};
