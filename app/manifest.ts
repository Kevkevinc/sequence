import type { MetadataRoute } from 'next';

/**
 * What the phone reads when a creator adds Sequence to their home screen.
 *
 * Without this file, "Add to Home Screen" produces a bookmark: it opens in the
 * browser, with an address bar, and cannot send notifications. With it, the
 * phone treats the same site as an installed app.
 *
 * `display: 'standalone'` is the line that removes the browser chrome. It also
 * changes how long a render feels: full screen with no address bar reads as an
 * app doing work, where a browser tab reads as a page that has stalled.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Sequence — UGC AI Editor',
    // Shown under the home-screen icon, where iOS truncates at ~12 characters.
    short_name: 'Sequence',
    description:
      'Turn raw phone footage into TikTok-ready UGC videos. Upload your clips, get back finished edits.',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0a0b10',
    theme_color: '#0a0b10',
    categories: ['productivity', 'photo', 'video'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      {
        // Android launchers crop icons to their own shape; a maskable icon
        // keeps the mark clear of whatever they crop to.
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    shortcuts: [
      {
        name: 'New video',
        short_name: 'New',
        url: '/jobs/new',
        description: 'Start a new edit from fresh footage',
      },
      {
        name: 'Your videos',
        short_name: 'Videos',
        url: '/jobs',
        description: 'Everything you have made',
      },
    ],
  };
}
