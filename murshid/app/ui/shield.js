'use strict';

// A transparent layer laid over the whole window while the side panel is being
// resized, so the pointer keeps reporting to Murshid even over web content.

let frame = 0;
let lastX = null;
window.addEventListener('pointermove', (event) => {
  lastX = event.clientX;
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    window.murshidUI.invoke('panelResize', lastX);
  });
});
const end = () => window.murshidUI.invoke('panelResizeEnd');
window.addEventListener('pointerup', end);
window.addEventListener('blur', end);
