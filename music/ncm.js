const ncm = require('NeteaseCloudMusicApi');

// In-memory cache of playlist songs
const playlistCache = new Map();

// 搜索歌曲
async function searchSong(keyword, limit = 10) {
  const res = await ncm.search({ keywords: keyword, limit });
  if (res.body?.result?.songs) {
    return res.body.result.songs.map(s => ({
      id: s.id,
      name: s.name,
      artist: s.artists?.map(a => a.name).join(' / ') || 'Unknown',
      album: s.album?.name || '',
      duration: s.duration,
    }));
  }
  return [];
}

// 获取播放 URL
async function getSongUrl(id) {
  const cookie = process.env.NCM_COOKIE || '';
  const res = await ncm.song_url({ id, br: 320000, cookie });
  if (res.body?.data?.[0]?.url) {
    return res.body.data[0].url;
  }
  // Try v1 as fallback
  const res2 = await ncm.song_url_v1({ id, level: 'standard', cookie });
  return res2.body?.data?.[0]?.url || null;
}

// 获取歌曲详情
async function getSongDetail(ids) {
  const idsStr = Array.isArray(ids) ? ids.join(',') : String(ids);
  const res = await ncm.song_detail({ ids: idsStr });
  if (res.body?.songs) {
    return res.body.songs.map(s => ({
      id: s.id,
      name: s.name,
      artist: s.ar?.map(a => a.name).join(' / ') || 'Unknown',
      album: s.al?.name || '',
      albumCover: s.al?.picUrl || '',
      duration: s.dt,
    }));
  }
  return [];
}

async function getLyric(id) {
  const res = await ncm.lyric({ id });
  return {
    lrc: res.body?.lrc?.lyric || '',
    tlyric: res.body?.tlyric?.lyric || '',
  };
}

// 拿歌单的元信息（名字、描述、歌曲ID列表）
async function getPlaylistDetail(playlistId) {
  const cookie = process.env.NCM_COOKIE || '';
  const res = await ncm.playlist_detail({ id: playlistId, cookie });
  if (!res.body?.playlist) return null;

  const playlist = res.body.playlist;
  return {
    id: playlist.id,
    name: playlist.name,
    description: playlist.description,
    trackCount: playlist.trackCount,
    trackIds: playlist.trackIds?.map(t => t.id) || [],
  };
}

// 拿歌单里所有歌的完整信息
async function getPlaylistTracks(playlistId) {
  const cookie = process.env.NCM_COOKIE || '';
  const res = await ncm.playlist_track_all({ id: playlistId, cookie });
  if (res.body?.songs) {
    return res.body.songs.map(s => ({
      id: s.id,
      name: s.name,
      artist: s.ar?.map(a => a.name).join(' / ') || 'Unknown',
      album: s.al?.name || '',
      albumCover: s.al?.picUrl || '',
      duration: s.dt,
    }));
  }
  return [];
}

// 批量加载歌单到缓存
async function loadPlaylists(playlistConfigs) {
  const results = [];
  for (const config of playlistConfigs) {
    if (!config.id || config.id === 0) continue;
    try {
      const tracks = await getPlaylistTracks(config.id);
      playlistCache.set(config.id, {
        ...config,
        tracks,
        loadedAt: Date.now(),
      });
      results.push({ id: config.id, name: config.name, trackCount: tracks.length });
      console.log(`[NCM] Loaded playlist "${config.name}" with ${tracks.length} tracks`);
    } catch (err) {
      console.error(`[NCM] Failed to load playlist ${config.id}:`, err.message);
    }
  }
  return results;
}

function getAllCachedSongs() {
  const songs = [];
  for (const [, playlist] of playlistCache) {
    songs.push(...playlist.tracks);
  }
  // Deduplicate by id
  const seen = new Set();
  return songs.filter(s => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

function getPlaylistCache() {
  return playlistCache;
}

module.exports = {
  searchSong,
  getSongUrl,
  getSongDetail,
  getLyric,
  getPlaylistDetail,
  getPlaylistTracks,
  loadPlaylists,
  getAllCachedSongs,
  getPlaylistCache,
};
