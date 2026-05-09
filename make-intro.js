require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { synthesize } = require('./brain/tts');

const TEXT = '嗨，我是 Claudio，一个有感情的私人DJ主播。现在几点、什么天气、你今天忙不忙、最近在听啥、心情好不好,我都知道。我会替你挑下一首歌，还会开口跟你聊两句，像深夜电台主播那样。想要什么性格？改 Prompt 就行，你写什么样的我，我就是什么样的DJ。调出完全属于你的DJ。';

const OUT = path.join(__dirname, 'dj_intro.mp3');

(async () => {
  const buf = await synthesize(TEXT);
  if (!buf) { console.error('TTS failed'); process.exit(1); }
  fs.writeFileSync(OUT, buf);
  console.log(`Wrote ${OUT} (${buf.length} bytes, ${TEXT.length} chars)`);
})();
