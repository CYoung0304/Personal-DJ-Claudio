// Claudio PWA - Main Application
const API = '';
let ws = null;
let audio = null;
let isPlaying = false;
let currentQueue = [];
let queueIndex = 0;
let djSpeaking = false;

// ---- TTS Engine (backend /api/tts) ----
const tts = {
  djAudio: null,
  unlocked: false,

  init() {
    this.djAudio = new Audio();
    this.djAudio.preload = 'auto';

    // iOS Safari requires audio elements to be "unlocked" by a user gesture
    // before they can be played programmatically. Prime djAudio on first tap.
    const unlock = () => {
      if (this.unlocked) return;
      // Tiny silent WAV (44 bytes) - just enough to register a successful play()
      this.djAudio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
      this.djAudio.play().then(() => {
        this.djAudio.pause();
        this.djAudio.currentTime = 0;
        this.unlocked = true;
        console.log('[TTS] djAudio unlocked');
      }).catch((err) => {
        console.warn('[TTS] djAudio unlock failed:', err.message);
      });
    };
    document.addEventListener('touchstart', unlock, { once: true, passive: true });
    document.addEventListener('click', unlock, { once: true });
  },

  async speak(text) {
    if (!text) return;

    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (!res.ok) {
        console.error('[TTS] Server error:', res.status);
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      return new Promise((resolve) => {
        const cleanup = () => { URL.revokeObjectURL(url); resolve(); };
        this.djAudio.src = url;
        this.djAudio.onended = cleanup;
        this.djAudio.onerror = cleanup;
        this.djAudio.play().catch((err) => {
          console.error('[TTS] Play failed:', err.message);
          cleanup();
        });
      });
    } catch (err) {
      console.error('[TTS] Fetch error:', err);
    }
  },

  stop() {
    if (this.djAudio) {
      this.djAudio.pause();
      this.djAudio.currentTime = 0;
    }
  }
};

// ---- Volume Crossfade ----
function fadeVolume(from, to, durationMs = 2000) {
  return new Promise((resolve) => {
    if (!audio) { resolve(); return; }
    const steps = 30;
    const stepTime = durationMs / steps;
    const delta = (to - from) / steps;
    let current = from;
    let step = 0;

    audio.volume = from;
    const interval = setInterval(() => {
      step++;
      current += delta;
      audio.volume = Math.max(0, Math.min(1, current));
      if (step >= steps) {
        clearInterval(interval);
        audio.volume = to;
        resolve();
      }
    }, stepTime);
  });
}

/**
 * DJ speaks, then music fades in
 * 1. Lower music volume
 * 2. DJ speaks (TTS)
 * 3. Gradually raise music volume back to 1.0
 */
async function djSpeak(text) {
  if (!text || djSpeaking) return;
  djSpeaking = true;

  showDJMessage(text);
  showDJSpeaking(true);

  // Remember user's current volume so we can restore it
  const originalVolume = audio.volume;
  const wasPlaying = !audio.paused;

  // Fade music down to 50% of original
  if (wasPlaying) {
    await fadeVolume(originalVolume, originalVolume * 0.2, 1000);
  }

  // DJ speaks
  await tts.speak(text);

  // Fade music back up to original
  if (wasPlaying || !audio.paused) {
    await fadeVolume(audio.volume, originalVolume, 2000);
  }

  showDJSpeaking(false);
  djSpeaking = false;
}

function showDJSpeaking(speaking) {
  const avatar = document.getElementById('dj-avatar');
  if (speaking) {
    avatar.classList.add('speaking');
  } else {
    avatar.classList.remove('speaking');
  }
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
  audio = document.getElementById('audio-player');
  tts.init();
  setupNav();
  setupControls();
  setupChat();
  setupProfile();
  setupSettings();
  connectWebSocket();
  loadInitialState();

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
});

// ---- Navigation ----
function setupNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`view-${view}`).classList.add('active');

      if (view === 'profile') loadProfile();
      if (view === 'settings') loadSettings();
    });
  });
}

// ---- Audio Controls ----
function setupControls() {
  const btnPlay = document.getElementById('btn-play');
  const btnNext = document.getElementById('btn-next');
  const btnPrev = document.getElementById('btn-prev');
  const progressBar = document.getElementById('progress-bar');

  btnPlay.addEventListener('click', togglePlay);
  btnNext.addEventListener('click', () => skipSong());
  btnPrev.addEventListener('click', () => {
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
    } else if (queueIndex > 0) {
      queueIndex--;
      playSong(currentQueue[queueIndex]);
    }
  });

  progressBar.addEventListener('click', (e) => {
    if (audio.duration) {
      const rect = progressBar.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      audio.currentTime = pct * audio.duration;
    }
  });

  audio.addEventListener('timeupdate', updateProgress);
  audio.addEventListener('ended', () => advanceToNext());
  audio.addEventListener('error', (e) => {
    console.error('Audio error:', e);
    showDJMessage('This song is unavailable, skipping...');
    setTimeout(() => advanceToNext(), 1500);
  });
}

function togglePlay() {
  if (!audio.src && currentQueue.length > 0) {
    playSong(currentQueue[queueIndex]);
    return;
  }
  if (audio.paused) {
    audio.play();
    setPlayState(true);
  } else {
    audio.pause();
    setPlayState(false);
  }
}

function setPlayState(playing) {
  isPlaying = playing;
  document.getElementById('icon-play').style.display = playing ? 'none' : 'block';
  document.getElementById('icon-pause').style.display = playing ? 'block' : 'none';
}

function updateProgress() {
  if (!audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  document.getElementById('progress-fill').style.width = `${pct}%`;
  document.getElementById('time-current').textContent = formatTime(audio.currentTime);
  document.getElementById('time-total').textContent = formatTime(audio.duration);
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ---- Song Playback ----
async function playSong(song, fadeInMs = 0) {
  if (!song) return;

  let url = song.url;
  if (!url) {
    try {
      const res = await fetch(`${API}/api/song-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: song.id }),
      });
      const data = await res.json();
      url = data.url;
      song.url = url;
    } catch (err) {
      console.error('Failed to get song URL:', err);
      return;
    }
  }

  if (!url) {
    showDJMessage(`"${song.name}" is not available, trying next...`);
    setTimeout(() => advanceToNext(), 500);
    return;
  }

  audio.src = url;
  if (fadeInMs > 0) {
    audio.volume = 0;
    audio.play();
    setPlayState(true);
    fadeVolume(0, 1.0, fadeInMs);  // fire-and-forget; don't block UI updates
  } else {
    audio.volume = 1.0;
    audio.play();
    setPlayState(true);
  }

  // Update UI
  document.getElementById('song-title').textContent = song.name || 'Unknown';
  document.getElementById('song-artist').textContent = song.artist || '';

  const albumImg = document.getElementById('album-img');
  const albumPlaceholder = document.getElementById('album-placeholder');
  if (song.albumCover) {
    albumImg.src = song.albumCover;
    albumImg.style.display = 'block';
    albumPlaceholder.style.display = 'none';
  } else {
    albumImg.style.display = 'none';
    albumPlaceholder.style.display = 'flex';
  }

  updateQueueUI();
}

// User manually skips
async function skipSong() {
  if (queueIndex < currentQueue.length - 1) {
    queueIndex++;
    playSong(currentQueue[queueIndex]);
    // Notify server
    fetch(`${API}/api/skip`, { method: 'POST' }).catch(() => {});
  } else {
    showDJMessage('Queue finished, asking DJ for more...');
    sendChat('continue playing');
  }
}

// Song ended naturally — ask server (which may trigger DJ commentary)
async function advanceToNext() {
  if (queueIndex < currentQueue.length - 1) {
    queueIndex++;
    const nextSong = currentQueue[queueIndex];

    try {
      const res = await fetch(`${API}/api/next`, { method: 'POST' });
      const data = await res.json();

      if (data.song && data.djVoice && data.song.name) {
        // DJ commentary expected. Don't start the song here —
        // the WebSocket 'now-playing' handler will await djSpeak() then playSong().
        updateQueueUI();
        return;
      }
    } catch {}

    // No DJ commentary — play immediately
    playSong(nextSong);
    updateQueueUI();
  } else {
    showDJMessage('Queue finished, asking DJ for more...');
    sendChat('continue playing');
  }
}

function updateQueueUI() {
  const list = document.getElementById('queue-list');
  list.innerHTML = '';
  for (let i = queueIndex + 1; i < currentQueue.length; i++) {
    const song = currentQueue[i];
    const li = document.createElement('li');
    li.innerHTML = `
      <span>${song.name}</span>
      <span class="queue-artist">${song.artist || ''}</span>
    `;
    li.addEventListener('click', () => {
      queueIndex = i;
      playSong(song);
    });
    list.appendChild(li);
  }
}

// ---- Chat ----
function setupChat() {
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');

  sendBtn.addEventListener('click', () => sendChat(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat(input.value);
  });
}

async function sendChat(message) {
  if (!message || !message.trim()) return;

  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');
  input.value = '';
  sendBtn.disabled = true;
  showDJMessage('<span class="loading"></span> DJ is thinking...');

  try {
    const res = await fetch(`${API}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();

    if (data.error) {
      showDJMessage(`Error: ${data.error}`);
      return;
    }

    if (data.type === 'dj') {
      // DJ response is delivered via WebSocket 'now-playing' message,
      // which awaits djSpeak() then playSong(). Don't trigger them here
      // to avoid racing with the WS path.
    } else if (data.type === 'command') {
      showDJMessage(`Got it: ${data.command}`);
    } else if (data.type === 'search') {
      showDJMessage(`Found ${data.results.length} results`);
    }
  } catch (err) {
    showDJMessage(`Connection error: ${err.message}`);
  } finally {
    sendBtn.disabled = false;
  }
}

function showDJMessage(text) {
  document.getElementById('dj-say').innerHTML = text;
}

// ---- WebSocket ----
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}/stream`;

  ws = new WebSocket(wsUrl);

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWSMessage(data);
    } catch {}
  };

  ws.onclose = () => {
    console.log('[WS] Disconnected, reconnecting in 3s...');
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = () => {};
}

async function handleWSMessage(data) {
  switch (data.type) {
    case 'now-playing': {
      const djSpoke = !!(data.djSay && data.djVoice);
      if (djSpoke) {
        // DJ speaks FIRST, song waits until DJ is done (real radio style)
        await djSpeak(data.djSay);
      } else if (data.djSay) {
        showDJMessage(data.djSay);
      }

      if (data.song && data.song.url) {
        if (!audio.src || !audio.src.includes(data.song.id)) {
          currentQueue = data.queue || [data.song];
          queueIndex = 0;
          // Fade in over 3s if DJ just spoke (real radio crossfade); otherwise full volume
          playSong(data.song, djSpoke ? 3000 : 0);
        }
      }
      break;
    }

    case 'command':
      if (data.command === 'pause') { audio.pause(); setPlayState(false); }
      if (data.command === 'resume') { audio.play(); setPlayState(true); }
      break;

    case 'status':
      showDJMessage(data.message || data.status);
      break;

    case 'connected':
      if (data.nowPlaying?.song) {
        document.getElementById('song-title').textContent = data.nowPlaying.song.name || '';
        document.getElementById('song-artist').textContent = data.nowPlaying.song.artist || '';
        if (data.nowPlaying.djSay) showDJMessage(data.nowPlaying.djSay);
      }
      break;
  }
}

// ---- Load Initial State ----
async function loadInitialState() {
  try {
    const res = await fetch(`${API}/api/now`);
    const data = await res.json();
    if (data.song) {
      document.getElementById('song-title').textContent = data.song.name || 'Waiting for DJ...';
      document.getElementById('song-artist').textContent = data.song.artist || '';
      if (data.djSay) showDJMessage(data.djSay);
      if (data.queue) { currentQueue = data.queue; queueIndex = 0; updateQueueUI(); }
    }
  } catch {}
}

// ---- Profile ----
function setupProfile() {
  document.getElementById('save-profile').addEventListener('click', saveProfile);
}

async function loadProfile() {
  try {
    const res = await fetch(`${API}/api/taste`);
    const data = await res.json();
    document.getElementById('taste-editor').value = data.taste || '';
    document.getElementById('routines-editor').value = data.routines || '';
    document.getElementById('mood-rules-editor').value = data.moodRules || '';
  } catch {}
}

async function saveProfile() {
  const btn = document.getElementById('save-profile');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  try {
    await fetch(`${API}/api/taste`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taste: document.getElementById('taste-editor').value,
        routines: document.getElementById('routines-editor').value,
        moodRules: document.getElementById('mood-rules-editor').value,
      }),
    });
    btn.textContent = 'Saved!';
    setTimeout(() => { btn.textContent = 'Save Profile'; btn.disabled = false; }, 1500);
  } catch {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Save Profile'; btn.disabled = false; }, 1500);
  }
}

// ---- Settings ----
function setupSettings() {
  document.getElementById('generate-plan').addEventListener('click', async () => {
    const btn = document.getElementById('generate-plan');
    btn.disabled = true;
    btn.textContent = 'Generating...';
    try {
      await sendChat('generate today plan');
      await loadTodayPlan();
    } catch {}
    btn.textContent = 'Regenerate Plan';
    btn.disabled = false;
  });
}

async function loadSettings() {
  loadTodayPlan();
  loadHistory();
  loadPlaylistList();
  checkApiStatus();
}

async function loadTodayPlan() {
  try {
    const res = await fetch(`${API}/api/plan/today`);
    const data = await res.json();
    const container = document.getElementById('today-plan');
    if (data.plan && data.plan.length > 0) {
      container.innerHTML = data.plan.map(p => `
        <div class="plan-slot">
          <span class="plan-time">${p.time_slot}</span>
          <span class="plan-mood">${p.mood} / ${p.genre_hint}</span>
        </div>
      `).join('');
    } else {
      container.innerHTML = '<p style="color: var(--text-dim); font-size: 13px;">No plan yet. Click "Regenerate Plan" to create one.</p>';
    }
  } catch {}
}

async function loadHistory() {
  try {
    const res = await fetch(`${API}/api/history`);
    const data = await res.json();
    const list = document.getElementById('history-list');
    list.innerHTML = (data.history || []).map(h => `
      <li>
        <div>${h.song_name} - ${h.artist}</div>
        <div class="history-time">${h.played_at}</div>
      </li>
    `).join('');
  } catch {}
}

async function loadPlaylistList() {
  try {
    const res = await fetch(`${API}/api/playlists`);
    const data = await res.json();
    const container = document.getElementById('playlist-list');
    container.innerHTML = (data.playlists || []).map(p => `
      <div class="status-item">
        <span>${p.name}</span>
        <span style="color: var(--text-dim)">${p.trackCount} tracks</span>
      </div>
    `).join('') || '<p style="color: var(--text-dim); font-size: 13px;">No playlists loaded</p>';
  } catch {}
}

async function checkApiStatus() {
  document.getElementById('status-server').className = 'status-dot';
  try {
    await fetch(`${API}/api/now`);
    document.getElementById('status-server').className = 'status-dot';
    document.getElementById('status-ncm').className = 'status-dot';
    document.getElementById('status-claude').className = 'status-dot';
  } catch {
    document.getElementById('status-server').className = 'status-dot error';
  }
}
