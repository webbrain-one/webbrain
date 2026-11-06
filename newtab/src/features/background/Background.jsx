import BackgroundImage from './components/BackgroundImage';
import BackgroundVideo from './components/BackgroundVideo';

import { useBackgroundState } from './hooks/useBackgroundState';
import { useBackgroundLoader } from './hooks/useBackgroundLoader';
import { useBackgroundRenderer, useBackgroundFilters, useBackgroundOverlayFilters } from './hooks/useBackgroundRenderer';
import { useBackgroundEvents } from './hooks/useBackgroundEvents';
import { setShownBackground } from './api/chatBackdrop';

import { useEffect } from 'react';

import './scss/index.scss';

/**
 * Background component - Manages and displays backgrounds
 * Supports: API images, custom images, colors, gradients, videos, and photo packs
 */
export default function Background() {
  const { backgroundData, updateBackground, resetBackground } = useBackgroundState();
  const { refreshBackground } = useBackgroundLoader(updateBackground, resetBackground);
  const filterStyle = useBackgroundFilters(backgroundData);
  const overlayFilterStyle = useBackgroundOverlayFilters(backgroundData);

  // Unknown remote type: a picture that won't load is retried as a video (once per address).
  useBackgroundRenderer(backgroundData, (failedUrl) => {
    if (failedUrl === backgroundData.url && !backgroundData.video) updateBackground({ video: true });
  });
  useBackgroundEvents(backgroundData, refreshBackground);
  // Remembered for the full-page chat Ask opens in this tab, which keeps the same background.
  useEffect(() => setShownBackground(backgroundData), [backgroundData]);

  return (
    <>
      {backgroundData.video ? (
        <BackgroundVideo url={backgroundData.url} filterStyle={filterStyle} />
      ) : (
        <BackgroundImage
          photoInfo={backgroundData.photoInfo}
          currentAPI={backgroundData.currentAPI}
          url={backgroundData.url}
        />
      )}
      <div id="backgroundFilterOverlay" style={overlayFilterStyle} />
    </>
  );
}
