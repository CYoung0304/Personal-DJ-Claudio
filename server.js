// 启动准备
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const ncm = require('./music/ncm');
const router = require('./brain/router');
const state = require('./brain/state');
const scheduler = require('./brain/scheduler');
const tts = require('./brain/tts');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ----- WebSocket 连接管理 -----
const wss = new WebSocketServer({ server, path: '/stream' });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[WS] Client connected (total: ${clients.size})`);

  // Send current state
  ws.send(JSON.stringify({ type: 'connected', nowPlaying: currentState }));

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected (total: ${clients.size})`);
  });
});
// 把消息同时发给所有连接的浏览器。手机和电脑两边会同步更新。
function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// ----- 状态管理（服务器内存里的变量） -----
let currentState = {
  song: null, // 正在播放的歌（包含 id、name、artist、url 等）
  queue: [],  // 接下来要播放的歌列表
  djSay: '',  // DJ 说的话（文字）
  djVoice: false,  // 这条话要不要语音朗读
  segue: 'smooth',  // 切歌风格
  isPlaying: false,
};
let songsSinceDJ = 0;           // 距离上次 DJ 说话过了几首歌
const DJ_SPEAK_INTERVAL = 2;    // 每 k 首 DJ 说一次
// 修改这个状态的函数
function updateNowPlaying(song, djSay = '', segue = 'smooth', djVoice = false) {
  currentState = {
    song,
    queue: currentState.queue,
    djSay,
    djVoice,
    segue,
    isPlaying: true,
  };
  broadcast({ type: 'now-playing', ...currentState });
}

// ----- API Routes -----

// GET /api/now - Current playing song
app.get('/api/now', (req, res) => {
  res.json(currentState);
});

// GET /api/taste - User taste profile
app.get('/api/taste', (req, res) => {
  try {
    const taste = fs.readFileSync(path.join(__dirname, 'user/taste.md'), 'utf-8');
    const routines = fs.readFileSync(path.join(__dirname, 'user/routines.md'), 'utf-8');
    const moodRules = fs.readFileSync(path.join(__dirname, 'user/mood-rules.md'), 'utf-8');
    res.json({ taste, routines, moodRules });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/taste - Update taste profile
app.put('/api/taste', (req, res) => {
  try {
    const { taste, routines, moodRules } = req.body;
    if (taste) fs.writeFileSync(path.join(__dirname, 'user/taste.md'), taste);
    if (routines) fs.writeFileSync(path.join(__dirname, 'user/routines.md'), routines);
    if (moodRules) fs.writeFileSync(path.join(__dirname, 'user/mood-rules.md'), moodRules);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/plan/today - Today's music plan
app.get('/api/plan/today', (req, res) => {
  const plan = state.getDailyPlan();
  res.json({ plan });
});

// 你跟 DJ 说话，决定 DJ 接下来怎么做：播歌？说话？还是两者都有？
// POST /api/chat - Send message to DJ
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body; // 你说的话
    const availableSongs = ncm.getAllCachedSongs(); // 当前缓存的所有歌曲

    // ↑ 路由器决定：是简单命令？搜索？还是交给 Claude？
    const result = await router.route(message, { availableSongs, broadcast });

    if (result.type === 'command') {
      handleCommand(result.command);
      res.json({ type: 'command', command: result.command });
      return;
    }

    if (result.type === 'search') {
      res.json({ type: 'search', results: result.results });
      return;
    }

    // DJ response
    if (result.play && result.play.length > 0) {
      currentState.queue = result.play;
      const firstSong = result.play[0];
      // DJ speaks on first interaction, or when explicitly chatting
      const shouldSpeak = !!message;
      songsSinceDJ = 0;
      updateNowPlaying(firstSong, result.say, result.segue, shouldSpeak);
      // ↑ djVoice=true，因为是你主动聊天，DJ 要开口说话

      // Log the play// 记录播放历史
      state.logPlay(firstSong, message || 'auto', result.reason);
    }

    res.json({
      type: 'dj',
      say: result.say,
      play: result.play,
      reason: result.reason,
      segue: result.segue,
    });
  } catch (err) {
    console.error('[API] Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/skip - Skip to next song
app.post('/api/skip', (req, res) => {
  if (currentState.queue.length > 1) {
    currentState.queue.shift();
    const next = currentState.queue[0];
    songsSinceDJ++;
    updateNowPlaying(next, '', currentState.segue, false);
    state.logPlay(next, 'skip', 'user skipped');
    res.json({ song: next });
  } else {
    res.json({ song: null, message: 'Queue empty' });
  }
});

// 歌播完了自动切下一首
// POST /api/next - Auto advance to next song (called by frontend when song ends)
app.post('/api/next', async (req, res) => {
  if (currentState.queue.length > 1) {
    currentState.queue.shift(); // 把刚播完的歌从队列头部移除
    const next = currentState.queue[0]; // 下一首
    songsSinceDJ++;

    // Every N songs, DJ gives a short commentary
    if (songsSinceDJ >= DJ_SPEAK_INTERVAL) {
      songsSinceDJ = 0;
      // 让 Claude 生成一段介绍这首歌的话
      const availableSongs = ncm.getAllCachedSongs();
      try {
        const commentary = await router.route(
          `介绍一下接下来要播放的歌曲："${next.name}" by ${next.artist}。顺便可以聊聊现在的时间段适合听什么，或者问问听众的心情。保持简短自然，像电台DJ一样。`,
          { availableSongs, broadcast }
        );
        updateNowPlaying(next, commentary.say || '', currentState.segue, true);
      } catch {
        updateNowPlaying(next, '', currentState.segue, false);
      }
    } else {
      updateNowPlaying(next, '', currentState.segue, false);
      // ↑ djVoice=false，静默切歌
    }

    state.logPlay(next, 'auto-next', '');
    res.json({ song: next, djVoice: songsSinceDJ === 0 });
  } else {
    res.json({ song: null, message: 'Queue empty' });
  }
});

// GET /api/queue - Get current queue
app.get('/api/queue', (req, res) => {
  res.json({ queue: currentState.queue });
});

// GET /api/history - Recent play history
app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const history = state.getRecentPlays(limit);
  res.json({ history });
});

// GET /api/playlists - List loaded playlists
app.get('/api/playlists', (req, res) => {
  const cache = ncm.getPlaylistCache();
  const playlists = [];
  for (const [id, data] of cache) {
    playlists.push({ id, name: data.name, trackCount: data.tracks.length });
  }
  res.json({ playlists });
});

// GET /api/playlist/:id - Get playlist tracks
app.get('/api/playlist/:id', async (req, res) => {
  try {
    const tracks = await ncm.getPlaylistTracks(parseInt(req.params.id));
    res.json({ tracks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/song-url - Get playable URL for a song
app.post('/api/song-url', async (req, res) => {
  try {
    const { id } = req.body;
    const url = await ncm.getSongUrl(id);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tts - Synthesize text to speech, returns MP3 audio
app.post('/api/tts', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });

    const audio = await tts.synthesize(text);
    if (!audio || audio.length === 0) return res.status(503).json({ error: 'TTS unavailable' });

    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', audio.length);
    res.send(audio);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- Command Handlers -----
function handleCommand(cmd) {
  switch (cmd) {
    case 'skip':
      if (currentState.queue.length > 1) {
        currentState.queue.shift();
        updateNowPlaying(currentState.queue[0]);
      }
      break;
    case 'pause':
      currentState.isPlaying = false;
      broadcast({ type: 'command', command: 'pause' });
      break;
    case 'resume':
      currentState.isPlaying = true;
      broadcast({ type: 'command', command: 'resume' });
      break;
    default:
      broadcast({ type: 'command', command: cmd });
  }
}

// ----- 启动 -----
async function startup() {
  console.log('[Claudio] Starting up...');

  // Log which AI model is active
  const provider = (process.env.AI_PROVIDER || 'claude').toLowerCase();
  if (provider === 'deepseek') {
    const model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
    console.log(`[Claudio] AI: DeepSeek (${model}) — free, open-source`);
  } else {
    console.log('[Claudio] AI: Claude (claude-sonnet-4-6, fallback to CLI)');
  }

  // Log which TTS is active
  const ttsProvider = (process.env.TTS_PROVIDER || 'edge').toLowerCase();
  if (ttsProvider === 'edge') {
    const voice = process.env.TTS_VOICE_EDGE || 'zh-CN-XiaoxiaoNeural';
    console.log(`[Claudio] TTS: Edge (${voice}) — free`);
  } else {
    const voice = process.env.TTS_VOICE || 'alloy';
    console.log(`[Claudio] TTS: OpenAI-compatible (${voice})`);
  }

  // Load playlists
  try {
    const playlistConfig = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'user/playlists.json'), 'utf-8')
    );
    await ncm.loadPlaylists(playlistConfig);
    // ↑ 把网易云歌单里的歌全部拉取、缓存进内存
  } catch (err) {
    console.log('[Claudio] No playlists loaded:', err.message);
  }

  // Initialize scheduler
  scheduler.init((djResult) => {
    if (djResult.play && djResult.play.length > 0) {
      currentState.queue = djResult.play;
      updateNowPlaying(djResult.play[0], djResult.say, djResult.segue);
    }
  });

  // Start server
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Claudio] DJ is live at http://localhost:${PORT}`);
    console.log(`[Claudio] WebSocket at ws://localhost:${PORT}/stream`);
  });
}

startup().catch(err => {
  console.error('[Claudio] Startup failed:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Claudio] Shutting down...');
  scheduler.stop();
  state.close();
  server.close();
  process.exit(0);
});
