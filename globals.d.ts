// Ambient global type augmentations for browser vendor-prefixed APIs.

interface Window {
  /** Safari / legacy vendor-prefixed AudioContext constructor. */
  webkitAudioContext: typeof AudioContext;
}
