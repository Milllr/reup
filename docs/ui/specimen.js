// Mockup helper. The app does the same two things in its Stage and Word components.
// 1. Stage: scale the 1920 by 1080 stage to fit the window.
// 2. Word: size each word so it spans the plate edge to edge, never under 260 or over 540.
const fitStage = () => document.documentElement.style.setProperty('--fit', Math.min(innerWidth / 1920, innerHeight / 1080));
const fitWords = () => {
  for (const word of document.querySelectorAll('.stage .word')) {
    if (!word.offsetParent) continue; // hidden words are sized when they show
    word.style.setProperty('--size', 400);
    word.style.setProperty('--size', Math.max(260, Math.min(540, Math.floor((400 * 1864) / word.offsetWidth))));
  }
};
fitStage();
addEventListener('resize', fitStage);
document.fonts.ready.then(fitWords);
window.fitWords = fitWords;
