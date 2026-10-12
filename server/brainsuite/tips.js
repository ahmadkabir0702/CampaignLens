/**
 * What to do when a Brainsuite KPI comes back amber or red.
 *
 * Brainsuite shows these in its own report as "Possible Improvements" but
 * does not return them through the API. They are the same text for every
 * video, so this copy is enough. Taken from the Brainsuite report export for
 * ACE Social Media Video (Meta & TikTok), 12 Oct 2026.
 */
module.exports = {
  heatmovie: 'Highlight key elements via contrast, size and place them close to the centre. Cluster key elements. Leverage white space to increase contrast. Minimise clutter around important elements.',
  engagingBeginning: 'Make sure the beginning is dynamic, for example movement of objects or people, or animation.',
  scenePace: 'Include additional scene cuts and transitions for a faster scene pace.',
  motionWithinScene: 'Incorporate animated elements, transitions and visual effects to add dynamic energy. Experiment with camera movement and kinetic typography.',
  dropoffCurve: 'Communicate the relevant information early. Brand and product especially need to appear early, so they land even if viewers drop off.',
  brandAttention: 'Make the brand prominent by increasing contrast and placing it as a focal point near the centre. Integrate the brand into the narrative and keep it visible repeatedly.',
  brandAvailableFirstNSeconds: 'Show the brand in the first seconds. Make it a hotspot by increasing contrast to the background, and place it close to a hotspot.',
  brandAttentionLastScene: 'Show the brand in the last scene. Make it a hotspot by increasing contrast to the background, and place it close to a hotspot.',
  productAttentionVideoTime: 'Make the packaged product a focal point often and long enough. Increase contrast, place it close to a hotspot, have people interact with it, or use motion.',
  productAvailableFirstNSeconds: 'Show the packaged product in the first seconds. Increase its contrast to the background, place it near the centre, and have people interact with it.',
  productAttentionLastScene: 'Show the packaged product in the last scene. Increase its contrast to the background, place it near the centre, and have people interact with it.',
  memorability: 'Improve recall with unique and surprising visuals, contrast, an uncluttered design, or expressed emotion.',
  videoSimplicity: 'Reduce clutter. Focus on a few key messages and elements, and make key elements easy to find against the background.',
  aspectRatio: 'Match the aspect ratio the platform expects. It does not have to be pixel perfect.',
  readingTime: 'Shorten on-screen text or show it for longer. Viewers read about four words per second.',
  idealAudioSetting: 'For sound-off placements, add on-screen text so the message works without sound.',
  humanElement: 'Include people in the video to make it more emotionally engaging.',
  humanElementFirstScene: 'Include people in the opening scene to catch attention from the start.',
  arousalVisualStaged: 'Use stimulating, dynamic, energetic visuals.',
  arousalText: 'Use activating, dynamic words associated with action and excitement.',
  engagementPotential: 'Use high contrast and brightness, avoid cluttered or ordinary images, and show people.',
  fitToMessageVisual: 'Use visuals and symbols that are intuitively associated with the key message.',
  fitToMessageText: 'Use words that are intuitively associated with the key message.',
  fitToMessageVoiceOverProvided: 'Use words in the voice-over that are intuitively associated with the key message.',
  fitToBrandValueVisual: 'Use visuals that are intuitively associated with the brand values.',
  fitToBrandValueText: 'Use words that are intuitively associated with the brand values.',
  conceptCallToActionAvailableVoiceOverProvided: 'Include a call to action in the voice-over, in sync with the one on screen.',
};
