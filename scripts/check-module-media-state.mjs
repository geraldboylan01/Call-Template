import {
  exportPublishedSession,
  importPublishedSession,
  importSession
} from '../js/state.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const baseModule = {
  id: 'module-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  title: 'Example',
  notes: 'Advisor note',
  generated: {
    summaryHtml: '<p>Summary</p>'
  }
};

const legacy = importSession({
  version: 1,
  sessionId: 'session-legacy-state-check',
  clientName: 'Client',
  order: ['module-1'],
  activeModuleId: 'module-1',
  modules: [baseModule]
});
assert(legacy.modules[0].media.images.length === 0, 'Legacy modules must receive an empty media list.');
assert(legacy.modules[0].ui.hiddenCardIds.length === 0, 'Legacy modules must receive an empty hidden-card list.');
assert(legacy.modules[0].ui.cardOrder.length === 0, 'Legacy modules must receive an empty generated-card order.');

const withMedia = importSession({
  version: 1,
  sessionId: 'session-module-media-state-check',
  clientName: 'Client',
  order: ['module-1'],
  activeModuleId: 'module-1',
  modules: [{
    ...baseModule,
    media: {
      images: [
        {
          id: 'image-1',
          assetId: 'asset-12345678',
          contentType: 'image/png',
          width: 1200,
          height: 800,
          alt: 'Planning diagram'
        },
        {
          id: 'image-unsupported',
          assetId: 'asset-unsupported',
          contentType: 'image/svg+xml'
        }
      ]
    },
    ui: {
      hiddenCardIds: ['summary', 'summary', 'charts'],
      cardOrder: ['summary', 'image:image-1', 'summary', '', 'outputs']
    }
  }]
});

assert(withMedia.modules[0].media.images.length === 1, 'Unsupported module media must be ignored.');
assert(withMedia.modules[0].media.images[0].alt === 'Planning diagram', 'Image alt text must be preserved.');
assert(withMedia.modules[0].ui.hiddenCardIds.join(',') === 'summary,charts', 'Hidden cards must be de-duplicated.');
assert(withMedia.modules[0].ui.cardOrder.join(',') === 'summary,image:image-1,outputs', 'Generated-card order must be normalized and de-duplicated.');

const published = importPublishedSession(exportPublishedSession(withMedia));
assert(published.modules[0].media.images[0].assetId === 'asset-12345678', 'Published snapshots must retain media references.');
assert(published.modules[0].ui.hiddenCardIds.includes('summary'), 'Published snapshots must retain hidden-card presentation state.');
assert(published.modules[0].ui.cardOrder.includes('image:image-1'), 'Published snapshots must retain generated-card order.');

console.log('Module media state checks passed.');
