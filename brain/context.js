const fs = require('fs');
const path = require('path');
const state = require('./state');
const weather = require('../voice/weather');
const feishu = require('../voice/feishu');

const ROOT = path.resolve(__dirname, '..');

function readFile(filePath) {
  try {
    return fs.readFileSync(path.join(ROOT, filePath), 'utf-8');
  } catch {
    return '';
  }
}

// 判断时段，生成时间上下文字符串
function getTimeContext() {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const day = dayNames[now.getDay()];

  let period;
  if (hour >= 7 && hour < 9) period = '早晨 (morning)';
  else if (hour >= 9 && hour < 10) period = '通勤 (commute)';
  else if (hour >= 10 && hour < 12) period = '上午工作 (morning work)';
  else if (hour >= 12 && hour < 14) period = '午餐 (lunch)';
  else if (hour >= 14 && hour < 18) period = '下午工作 (afternoon work)';
  else if (hour >= 18 && hour < 22) period = '晚间 (evening)';
  else period = '深夜 (late night)';

  return `当前时间: ${now.toLocaleString('zh-CN')} (${day})\n时段: ${period}\n时:分 = ${hour}:${String(minute).padStart(2, '0')}`;
}

/**
 * Assemble the 6-fragment context window for Claude
 */

// 组装 6 块上下文
async function assemble(userInput, extraContext = {}) {
  const fragments = [];

  // Fragment 1: System prompt (DJ persona)
  const persona = readFile('prompts/dj-persona.md');
  fragments.push(`[系统人格]\n${persona}`);

  // Fragment 2: User taste profiles
  const taste = readFile('user/taste.md');
  const routines = readFile('user/routines.md');
  const moodRules = readFile('user/mood-rules.md');
  fragments.push(`[用户品味]\n${taste}\n\n[作息规律]\n${routines}\n\n[情境规则]\n${moodRules}`);

  // Fragment 3: Environment injection
  const timeCtx = getTimeContext();
  const weatherInfo = await weather.getWeather();
  const calendar = await feishu.getCalendar();
  fragments.push(`[环境信息]\n${timeCtx}\n天气: ${weatherInfo}\n日程: ${calendar}`);

  // Fragment 4: Retrieved memory (recent plays)
  const recentPlays = state.getRecentPlays(20);
  const playHistory = recentPlays.length > 0
    ? recentPlays.map(p => `- ${p.song_name} by ${p.artist} (${new Date(p.played_at).toLocaleTimeString('zh-CN')})`).join('\n')
    : '暂无播放记录';
  fragments.push(`[最近播放历史]\n${playHistory}`);

  // Fragment 5: User input + available songs
  let songContext = '';
  if (extraContext.availableSongs) {
    const sample = extraContext.availableSongs.slice(0, 50);
    songContext = '\n\n[可选歌曲（来自用户歌单）]\n' +
      sample.map(s => `- id:${s.id} "${s.name}" by ${s.artist}`).join('\n');
  }
  fragments.push(`[用户输入]\n${userInput || '请根据当前时间和情境自动选歌'}${songContext}`);

  // Fragment 6: Execution trace
  const dailyPlan = state.getDailyPlan();
  const planInfo = dailyPlan.length > 0
    ? dailyPlan.map(p => `- ${p.time_slot}: ${p.mood} / ${p.genre_hint}`).join('\n')
    : '今日尚无计划';
  fragments.push(`[执行轨迹]\n今日计划:\n${planInfo}`);

  // Combine: system prompt is fragment 1, rest is user message
  const systemPrompt = fragments[0];
  const userMessage = fragments.slice(1).join('\n\n---\n\n');

  return { systemPrompt, userMessage };
}

module.exports = { assemble, getTimeContext };
