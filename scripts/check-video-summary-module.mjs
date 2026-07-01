import {
  buildYouTubeEmbedUrl,
  buildYouTubeThumbnailUrl,
  buildYouTubeWatchUrl,
  extractYouTubeVideoId
} from '../js/video_summary.js';
import {
  exportPublishedSession,
  importPublishedSession,
  importSession
} from '../js/state.js';
import { buildOverviewPreviewDescriptor } from '../js/render.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const expectedId = 'dQw4w9WgXcQ';
[
  `https://www.youtube.com/watch?v=${expectedId}`,
  `https://youtu.be/${expectedId}`,
  `https://www.youtube.com/shorts/${expectedId}`,
  `https://www.youtube.com/embed/${expectedId}`,
  `https://www.youtube-nocookie.com/embed/${expectedId}`
].forEach((url) => {
  assert(extractYouTubeVideoId(url) === expectedId, `Could not extract YouTube id from ${url}`);
});

[
  'https://vimeo.com/123456789',
  'https://www.youtube.com/watch?v=short',
  'not a url',
  ''
].forEach((url) => {
  assert(extractYouTubeVideoId(url) === '', `Invalid URL should be rejected: ${url}`);
});

assert(buildYouTubeWatchUrl(expectedId) === `https://www.youtube.com/watch?v=${expectedId}`, 'Watch URL mismatch.');
assert(buildYouTubeEmbedUrl(expectedId) === `https://www.youtube-nocookie.com/embed/${expectedId}`, 'Embed URL mismatch.');
assert(buildYouTubeThumbnailUrl(expectedId) === `https://i.ytimg.com/vi/${expectedId}/hqdefault.jpg`, 'Thumbnail URL mismatch.');

const session = importSession({
  version: 1,
  sessionId: 'session-video-summary-check',
  clientName: 'Client',
  order: ['module-video'],
  activeModuleId: 'module-video',
  modules: [{
    id: 'module-video',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    title: 'Call video summary',
    notes: '',
    generated: {
      videoSummary: {
        provider: 'youtube',
        url: `https://youtu.be/${expectedId}`,
        title: 'Client call recap',
        description: 'Short summary for the client.',
        addedAt: '2026-01-01T00:00:00.000Z'
      },
      charts: [{ title: 'Should be stripped', labels: ['A'], datasets: [] }],
      outputs: { columns: ['A'], rows: [['B']] }
    }
  }]
});

const videoModule = session.modules[0];
assert(videoModule.generated.videoSummary?.videoId === expectedId, 'Video summary must normalize video id.');
assert(videoModule.generated.videoSummary?.thumbnailUrl.endsWith('/hqdefault.jpg'), 'Video summary must normalize thumbnail URL.');
assert(videoModule.generated.charts.length === 0, 'Video summary modules must not retain chart data.');
assert(videoModule.generated.outputs.rows.length === 0, 'Video summary modules must not retain output rows.');

const descriptor = buildOverviewPreviewDescriptor(videoModule);
assert(descriptor.moduleKind.token === 'video-summary', 'Overview module kind must be video-summary.');
assert(descriptor.previewKind === 'video-summary', 'Overview preview kind must be video-summary.');
assert(descriptor.videoSummary.thumbnailUrl.includes(expectedId), 'Overview descriptor must include thumbnail URL.');
assert(descriptor.metaItems.includes('YouTube'), 'Overview meta must include YouTube.');

const published = importPublishedSession(exportPublishedSession(session));
assert(published.modules[0].generated.videoSummary?.videoId === expectedId, 'Published session must preserve video summary.');

const publishedJson = JSON.parse(exportPublishedSession(session));
const assetIds = [...new Set(publishedJson.modules
  .flatMap((module) => Array.isArray(module?.media?.images) ? module.media.images : [])
  .map((image) => String(image?.assetId || '').trim())
  .filter(Boolean))];
assert(assetIds.length === 0, 'YouTube thumbnails must not be treated as private module asset refs.');

console.log('Video summary module checks passed.');
