/**
 * Schedules a single tone on an audio context, with a short fade in and out to avoid clicks
 * @param {AudioContext} audioContext - The audio context to schedule the tone on
 * @param {number} frequency - The tone's frequency, in Hz
 * @param {number} startTime - When to start the tone, in audio context time
 * @param {number} duration - How long the tone should play, in seconds
 */
function playTone(audioContext, frequency, startTime, duration) {
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();

  oscillator.frequency.value = frequency;
  oscillator.connect(gain);
  gain.connect(audioContext.destination);

  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(0.2, startTime + 0.02);
  gain.gain.linearRampToValueAtTime(0, startTime + duration);

  oscillator.start(startTime);
  oscillator.stop(startTime + duration);
}

/**
 * Plays a short two-tone chime to alert the user a meeting is starting soon
 */
function playNotificationChime() {
  const audioContext = new AudioContext();
  const now = audioContext.currentTime;

  playTone(audioContext, 880, now, 0.15);
  playTone(audioContext, 1320, now + 0.15, 0.2);

  setTimeout(() => audioContext.close(), 500);
}

/**
 * Handles a message addressed to this offscreen document
 * @param {Object} message - The message sent from the background worker
 */
function handleOffscreenMessage(message) {
  if (message.target === "offscreen" && message.type === "PLAY_SOUND") {
    playNotificationChime();
  }
}

chrome.runtime.onMessage.addListener(handleOffscreenMessage);
