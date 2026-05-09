const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

// Provider toggle: edge (free, default) or openai (any OpenAI-compatible TTS endpoint)
const TTS_PROVIDER = (process.env.TTS_PROVIDER || 'edge').toLowerCase();

// OpenAI-compatible TTS settings (POST {TTS_BASE_URL}/v1/audio/speech)
const TTS_MODEL = process.env.TTS_MODEL || 'tts-1';
const TTS_VOICE = process.env.TTS_VOICE || 'alloy';
const TTS_BASE_URL = (process.env.TTS_BASE_URL || '').replace(/\/+$/, '');
const TTS_API_KEY = process.env.TTS_API_KEY || '';

// Edge TTS settings
const TTS_VOICE_EDGE = process.env.TTS_VOICE_EDGE || 'zh-CN-XiaoxiaoNeural';

/**
 * Escape XML/SSML metacharacters. Microsoft Edge TTS treats input as SSML,
 * so unescaped &, <, > break the document and cause silent 0-byte failures.
 */
function escapeSSML(text) {
  return text
    .replace(/&/g, '&amp;')   // must be first — others would re-escape themselves
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Synthesize via Microsoft Edge TTS (free, no API key, neural quality).
 * Uses the same engine that powers Edge's "Read Aloud" feature.
 * Retries once if the WebSocket returns empty (transient failures are common).
 */
async function synthesizeEdge(text) {
  const safeText = escapeSSML(text);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const tts = new MsEdgeTTS();
      await tts.setMetadata(TTS_VOICE_EDGE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(safeText);
      const chunks = [];
      for await (const chunk of audioStream) chunks.push(chunk);
      const buf = Buffer.concat(chunks);

      if (buf.length === 0) {
        console.warn(`[TTS] Edge returned 0 bytes (attempt ${attempt}/2), retrying...`);
        continue;
      }

      console.log(`[TTS] Edge synthesized ${buf.length} bytes for ${text.length} chars (voice=${TTS_VOICE_EDGE})`);
      return buf;
    } catch (err) {
      console.warn(`[TTS] Edge attempt ${attempt}/2 failed: ${err.message}`);
    }
  }
  console.error('[TTS] Edge failed after 2 attempts');
  return null;
}

/**
 * Synthesize via any OpenAI-compatible TTS endpoint (e.g. self-hosted proxy,
 * paid TTS providers that expose POST /v1/audio/speech).
 */
async function synthesizeOpenAI(text) {
  if (!TTS_BASE_URL || !TTS_API_KEY) {
    console.log('[TTS] OpenAI-compatible TTS not configured (set TTS_BASE_URL + TTS_API_KEY)');
    return null;
  }

  const res = await fetch(`${TTS_BASE_URL}/v1/audio/speech`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + TTS_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[TTS] OpenAI-compatible HTTP ${res.status}: ${body.slice(0, 300)}`);
    return null;
  }

  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`[TTS] OpenAI-compatible synthesized ${buf.length} bytes for ${text.length} chars (voice=${TTS_VOICE})`);
  return buf;
}

/**
 * Main entry: dispatches based on TTS_PROVIDER env var.
 * Returns Buffer of MP3 audio, or null if TTS unavailable / empty.
 */
async function synthesize(text) {
  try {
    const buf = TTS_PROVIDER === 'edge'
      ? await synthesizeEdge(text)
      : await synthesizeOpenAI(text);
    // Treat 0-byte result as failure (some TTS APIs silently return empty)
    if (!buf || buf.length === 0) return null;
    return buf;
  } catch (err) {
    console.error('[TTS] Error:', err.message);
    return null;
  }
}

module.exports = { synthesize };
