const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isYouTubeHost(hostname) {
  const host = asTrimmedString(hostname).toLowerCase().replace(/^www\./, '');
  return host === 'youtube.com'
    || host === 'm.youtube.com'
    || host === 'youtu.be'
    || host === 'youtube-nocookie.com';
}

function sanitizeVideoId(value) {
  const id = asTrimmedString(value);
  return YOUTUBE_VIDEO_ID_PATTERN.test(id) ? id : '';
}

export function extractYouTubeVideoId(rawUrl) {
  const input = asTrimmedString(rawUrl);
  if (!input) {
    return '';
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch (_error) {
    return '';
  }

  if (!isYouTubeHost(parsed.hostname)) {
    return '';
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const pathParts = parsed.pathname.split('/').map((part) => part.trim()).filter(Boolean);

  if (host === 'youtu.be') {
    return sanitizeVideoId(pathParts[0]);
  }

  const watchId = sanitizeVideoId(parsed.searchParams.get('v'));
  if (watchId) {
    return watchId;
  }

  const firstPart = pathParts[0] || '';
  if (firstPart === 'shorts' || firstPart === 'embed' || firstPart === 'live') {
    return sanitizeVideoId(pathParts[1]);
  }

  return '';
}

export function buildYouTubeWatchUrl(videoId) {
  const id = sanitizeVideoId(videoId);
  return id ? `https://www.youtube.com/watch?v=${id}` : '';
}

export function buildYouTubeEmbedUrl(videoId) {
  const id = sanitizeVideoId(videoId);
  return id ? `https://www.youtube-nocookie.com/embed/${id}` : '';
}

export function buildYouTubeThumbnailUrl(videoId) {
  const id = sanitizeVideoId(videoId);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '';
}

export function normalizeVideoSummary(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }

  const videoId = sanitizeVideoId(input.videoId) || extractYouTubeVideoId(input.url);
  if (!videoId) {
    return null;
  }

  const title = asTrimmedString(input.title) || 'Call video summary';
  const description = asTrimmedString(input.description);
  const addedAt = asTrimmedString(input.addedAt) || new Date().toISOString();

  return {
    provider: 'youtube',
    videoId,
    url: buildYouTubeWatchUrl(videoId),
    embedUrl: buildYouTubeEmbedUrl(videoId),
    thumbnailUrl: buildYouTubeThumbnailUrl(videoId),
    title,
    description,
    addedAt
  };
}
