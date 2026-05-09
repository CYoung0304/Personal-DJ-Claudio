const { spawn } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');

let anthropicClient = null;

function getAnthropicClient() {
  if (!anthropicClient && process.env.ANTHROPIC_API_KEY) {
    const config = { apiKey: process.env.ANTHROPIC_API_KEY };
    if (process.env.ANTHROPIC_BASE_URL) {
      config.baseURL = process.env.ANTHROPIC_BASE_URL;
    }
    anthropicClient = new Anthropic.default(config);
  }
  return anthropicClient;
}

/**
 * Call Claude via CLI subprocess (primary method)
 * Uses `claude -p --output json` for Max subscription users
 */
function callCLI(prompt, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', prompt];
    const child = spawn('claude', args, {
      timeout: timeoutMs,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        // CLI --output json wraps in { result: "..." }
        const text = result.result || result.content || stdout;
        resolve(text);
      } catch {
        // If not valid JSON wrapper, return raw
        resolve(stdout.trim());
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Claude CLI not found: ${err.message}`));
    });
  });
}

/**
 * Call Claude via Anthropic API SDK (fallback)
 */
async function callAPI(systemPrompt, userPrompt) {
  const client = getAnthropicClient();
  if (!client) {
    throw new Error('No ANTHROPIC_API_KEY set and Claude CLI unavailable');
  }

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return message.content[0]?.text || '';
}

/**
 * Call DeepSeek's official API directly. OpenAI-compatible /v1/chat/completions.
 * Get a key at https://platform.deepseek.com/. Falls back to ANTHROPIC_* vars
 * for users routing through a proxy that exposes both endpoints.
 */
async function callDeepSeek(systemPrompt, userPrompt) {
  const baseUrl = (
    process.env.DEEPSEEK_BASE_URL ||
    process.env.ANTHROPIC_BASE_URL ||
    'https://api.deepseek.com'
  ).replace(/\/+$/, '');
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY;
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

  if (!apiKey) throw new Error('No API key configured for DeepSeek (set DEEPSEEK_API_KEY)');

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`DeepSeek HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

/**
 * Main entry: dispatches based on AI_PROVIDER env var.
 *   AI_PROVIDER=deepseek → use DeepSeek (free, open-source)
 *   anything else (or unset) → use Claude (default, original behavior)
 * Returns parsed DJ response: { say, play[], reason, segue }
 */
async function think(systemPrompt, userPrompt) {
  const provider = (process.env.AI_PROVIDER || 'claude').toLowerCase();
  let rawText;

  if (provider === 'deepseek') {
    console.log(`[AI] Using DeepSeek (${process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro'})`);
    rawText = await callDeepSeek(systemPrompt, userPrompt);
    console.log('[AI] DeepSeek succeeded');
  } else {
    // Default: Claude (original logic, unchanged)
    try {
      console.log('[Claude] Trying API...');
      rawText = await callAPI(systemPrompt, userPrompt);
      console.log('[Claude] API succeeded');
    } catch (apiErr) {
      console.log(`[Claude] API failed: ${apiErr.message}, trying CLI...`);
      try {
        const cliPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;
        rawText = await callCLI(cliPrompt);
        console.log('[Claude] CLI succeeded');
      } catch (cliErr) {
        console.error('[Claude] Both methods failed');
        throw new Error(`Claude unavailable: API(${apiErr.message}), CLI(${cliErr.message})`);
      }
    }
  }

  return parseResponse(rawText);
}

/**
 * Parse Claude's response into structured DJ output
 */
function parseResponse(text) {
  // Strip markdown code fences if present (```json ... ``` or ``` ... ```)
  let cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*$/g, '').trim();

  // Try to extract JSON from the response
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      say: cleaned.slice(0, 200),
      play: [],
      reason: 'Failed to parse structured response',
      segue: 'smooth',
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      say: parsed.say || '',
      play: Array.isArray(parsed.play) ? parsed.play : [],
      reason: parsed.reason || '',
      segue: parsed.segue || 'smooth',
    };
  } catch {
    // JSON parse failed (likely unescaped quotes inside say)
    // Try to extract just the say field with a tolerant regex
    const sayMatch = jsonMatch[0].match(/"say"\s*:\s*"([\s\S]*?)"\s*[,}]/);
    return {
      say: sayMatch ? sayMatch[1] : cleaned.slice(0, 200),
      play: [],
      reason: 'JSON parse error - using fallback extraction',
      segue: 'smooth',
    };
  }
}

module.exports = { think, callCLI, callAPI, callDeepSeek, parseResponse };
