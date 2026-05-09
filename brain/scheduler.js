const claude = require('./claude');
const context = require('./context');
const state = require('./state');
const ncm = require('../music/ncm');

let schedulerTimer = null;
let onSongNeeded = null; // callback when scheduler decides new songs are needed

/**
 * Initialize scheduler
 * @param {Function} callback - called with DJ response when new songs should play
 */
function init(callback) {
  onSongNeeded = callback;
  console.log('[Scheduler] Initialized');
}

/**
 * Start the hourly context check
 */
function start() {
  // Run context check every hour
  schedulerTimer = setInterval(async () => {
    console.log('[Scheduler] Hourly context check');
    try {
      await contextCheck();
    } catch (err) {
      console.error('[Scheduler] Context check failed:', err.message);
    }
  }, 60 * 60 * 1000); // 1 hour

  console.log('[Scheduler] Started (hourly context checks)');
}

/**
 * Generate today's music plan via Claude
 */
async function generateDailyPlan() {
  console.log('[Scheduler] Generating daily plan...');

  const availableSongs = ncm.getAllCachedSongs();
  const songSample = availableSongs.slice(0, 30)
    .map(s => `${s.name} - ${s.artist}`)
    .join('\n');

  const prompt = `根据用户的作息规律，为今天制定一个音乐计划。

可用歌曲示例:
${songSample}

请以 JSON 数组格式输出，每个时段一个条目:
[
  {"time_slot": "07:00-09:00 早晨", "mood": "轻快清醒", "genre_hint": "indie pop, light folk"},
  ...
]

只输出 JSON 数组，不要其他内容。`;

  const { systemPrompt, userMessage } = await context.assemble(prompt);
  const raw = await claude.think(systemPrompt, userMessage);

  // Parse the plan - it might be in say or raw text
  let plan = [];
  try {
    if (Array.isArray(raw.play)) {
      // Claude returned in standard format, but we need to look for plan array
    }
    // Try to parse from the say field or raw
    const text = typeof raw === 'string' ? raw : (raw.say || JSON.stringify(raw));
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      plan = JSON.parse(match[0]);
    }
  } catch (err) {
    console.error('[Scheduler] Failed to parse daily plan:', err.message);
    // Use default plan
    plan = getDefaultPlan();
  }

  if (plan.length > 0) {
    state.saveDailyPlan(plan);
    console.log(`[Scheduler] Daily plan saved with ${plan.length} slots`);
  }

  return plan;
}

function getDefaultPlan() {
  return [
    { time_slot: '07:00-09:00', mood: '轻快', genre_hint: 'indie pop, light folk' },
    { time_slot: '09:00-10:00', mood: '过渡', genre_hint: 'mid-tempo, melodic' },
    { time_slot: '10:00-12:00', mood: '专注', genre_hint: 'lo-fi, ambient, instrumental' },
    { time_slot: '12:00-14:00', mood: '放松', genre_hint: 'bossa nova, jazz, light pop' },
    { time_slot: '14:00-18:00', mood: '稳定', genre_hint: 'chillhop, trip-hop, electronic' },
    { time_slot: '18:00-22:00', mood: '享受', genre_hint: 'indie, folk, jazz, classical' },
    { time_slot: '22:00-07:00', mood: '安静', genre_hint: 'ambient, piano, minimal' },
  ];
}

/**
 * Hourly context check - determine if we should change the music
 */
async function contextCheck() {
  if (!onSongNeeded) return;

  const { getTimeContext } = context;
  const timeCtx = getTimeContext();
  console.log(`[Scheduler] Context: ${timeCtx}`);

  // Trigger a new selection based on current context
  const availableSongs = ncm.getAllCachedSongs();
  if (availableSongs.length === 0) return;

  const router = require('./router');
  const result = await router.route('', { availableSongs });
  if (result.type === 'dj' && result.play.length > 0) {
    onSongNeeded(result);
  }
}

function stop() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  console.log('[Scheduler] Stopped');
}

module.exports = { init, start, stop, generateDailyPlan, contextCheck, getDefaultPlan };
