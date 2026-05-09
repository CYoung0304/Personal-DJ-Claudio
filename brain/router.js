const ncm = require('../music/ncm');
const claude = require('./claude');
const context = require('./context');
const state = require('./state');

// Simple command patterns
const SIMPLE_COMMANDS = {
  skip: /^(skip|跳过|下一首|next)$/i,
  pause: /^(pause|暂停|停)$/i,
  resume: /^(play|播放|继续|resume)$/i,
  volume_up: /^(大声|louder|volume up)$/i,
  volume_down: /^(小声|softer|volume down|quiet)$/i,
};

/**
 * Route user input to the appropriate handler
 * Returns: { type, data }
 */

// 三条分支
async function route(input, { availableSongs = [], broadcast } = {}) {
  // 分支 0：没有输入（调度器的自动触发）
  if (!input || !input.trim()) {
    // No input = auto-select based on context
    return await handleAutoSelect(availableSongs, broadcast);
  }

  const trimmed = input.trim();

  // Check simple commands first
  // 分支 1：简单命令
  for (const [cmd, pattern] of Object.entries(SIMPLE_COMMANDS)) {
    if (pattern.test(trimmed)) {
      return { type: 'command', command: cmd };
    }
  }

  // Check if it's a direct search request
  // 分支 2：搜索请求
  const searchMatch = trimmed.match(/^(?:搜索|search|找|播放|play)\s+(.+)$/i);
  if (searchMatch) {
    return await handleSearch(searchMatch[1]);
  }

  // Everything else goes to Claude for smart handling
  // 分支 3：其他所有情况 → Claude
  return await handleClaude(trimmed, availableSongs, broadcast);
}

async function handleAutoSelect(availableSongs, broadcast) {
  return await handleClaude('', availableSongs, broadcast);
}

async function handleSearch(keyword) {
  const results = await ncm.searchSong(keyword, 5);
  return {
    type: 'search',
    results,
  };
}

async function handleClaude(input, availableSongs, broadcast) {
  // Save user message
  // 第一步：记录用户消息
  if (input) {
    state.saveMessage('user', input);
  }

  // Assemble context
  // 第二步：组装上下文
  const { systemPrompt, userMessage } = await context.assemble(input, { availableSongs });

  // Broadcast thinking status
  // 第三步：广播"正在思考"状态
  if (broadcast) {
    broadcast({ type: 'status', status: 'thinking', message: 'DJ 正在思考...' });
  }

  // Call Claude
  // 第四步：调用 Claude
  const djResponse = await claude.think(systemPrompt, userMessage);

  // Save assistant message
  state.saveMessage('assistant', JSON.stringify(djResponse));

  // Resolve song URLs for the play list
  // 第五步：解析歌曲 URL
  const resolvedSongs = [];
  for (const song of djResponse.play) {
    try {
      const url = await ncm.getSongUrl(song.id);
      if (url) {
        // Get full song details if we don't have album cover
        let albumCover = song.albumCover || '';
        if (!albumCover) {
          const details = await ncm.getSongDetail(song.id);
          if (details[0]) albumCover = details[0].albumCover;
        }
        // 组装完整歌曲对象，歌曲 URL 和封面图都必须有才能播放
        resolvedSongs.push({ ...song, url, albumCover });
      } else {
        console.log(`[Router] No URL for song ${song.id} "${song.name}", skipping`);
      }
    } catch (err) {
      console.error(`[Router] Failed to resolve song ${song.id}:`, err.message);
    }
  }

  return {
    type: 'dj',
    say: djResponse.say,
    play: resolvedSongs,
    reason: djResponse.reason,
    segue: djResponse.segue,
  };
}

module.exports = { route };
