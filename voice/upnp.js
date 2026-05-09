// UPnP speaker stub
// Future: push audio to home speakers via UPnP/DLNA

async function discover() {
  return [];
}

async function pushToSpeaker(speakerId, audioUrl) {
  console.log(`[UPnP] (stub) Would push ${audioUrl} to speaker ${speakerId}`);
  return false;
}

module.exports = { discover, pushToSpeaker };
