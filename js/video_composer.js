import { readVideoSceneManifest } from './video_scene.js';

const ui = {
  app: document.getElementById('videoComposerApp'),
  emptyState: document.getElementById('videoEmptyState'),
  sceneShell: document.getElementById('videoSceneShell'),
  composerTitle: document.getElementById('videoComposerTitle'),
  stageFrame: document.getElementById('videoStageFrame'),
  stage: document.getElementById('videoStage'),
  storyKind: document.getElementById('videoStoryKind'),
  storyTitle: document.getElementById('videoStoryTitle'),
  storySummary: document.getElementById('videoStorySummary'),
  storyMetrics: document.getElementById('videoStoryMetrics'),
  storyVisual: document.getElementById('videoStoryVisual'),
  storyTakeaway: document.getElementById('videoStoryTakeaway'),
  reviewSource: document.getElementById('videoReviewSource'),
  reviewMetrics: document.getElementById('videoReviewMetrics'),
  calculationNotice: document.getElementById('videoCalculationNotice'),
  reviewCompleteButton: document.getElementById('videoReviewCompleteBtn'),
  startCaptureButton: document.getElementById('videoStartCaptureBtn'),
  restartButton: document.getElementById('videoRestartBtn'),
  reviewStatus: document.getElementById('videoReviewStatus'),
  mirrorButton: document.getElementById('videoMirrorBtn'),
  fullscreenButton: document.getElementById('videoFullscreenBtn')
};

const CHART_COLORS = ['#77c2e8', '#75c28d', '#ddb665'];
let manifest = null;
let reviewComplete = false;
let presenterPosition = 'right';
let sequenceTimers = [];

function asText(value, fallback = '') {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text || fallback;
}

function setText(element, value) {
  if (element) {
    element.textContent = String(value || '');
  }
}

function getSceneManifest() {
  const localManifest = readVideoSceneManifest();
  if (localManifest) {
    return localManifest;
  }

  try {
    if (window.opener && !window.opener.closed) {
      return readVideoSceneManifest(window.opener.sessionStorage);
    }
  } catch (_error) {
    // The capture page is still useful when opened without an opener; show its empty state below.
  }

  return null;
}

function createElement(tagName, className = '') {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  return element;
}

function createSvgElement(tagName, attributes = {}) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tagName);
  Object.entries(attributes).forEach(([name, value]) => {
    element.setAttribute(name, String(value));
  });
  return element;
}

function renderMetricCards(metrics) {
  if (!ui.storyMetrics) {
    return;
  }
  ui.storyMetrics.replaceChildren();

  (Array.isArray(metrics) ? metrics : []).forEach((metric) => {
    const card = createElement('article', 'video-metric');
    const label = createElement('span', 'video-metric-label');
    label.textContent = asText(metric?.label, 'Key metric');
    const value = createElement('strong', 'video-metric-value');
    value.textContent = asText(metric?.value, '—');
    card.append(label, value);
    ui.storyMetrics.appendChild(card);
  });
}

function getChartBounds(chart) {
  const values = (Array.isArray(chart?.datasets) ? chart.datasets : [])
    .flatMap((dataset) => Array.isArray(dataset?.data) ? dataset.data : [])
    .filter((value) => Number.isFinite(value));
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(0, ...values);
  const span = maximum - minimum;
  return {
    minimum,
    maximum,
    span: span || 1
  };
}

function renderChartVisual(chart) {
  const shell = createElement('section', 'video-chart-shell');
  const heading = createElement('p', 'video-chart-heading');
  heading.textContent = asText(chart?.title, 'Key trend');
  shell.appendChild(heading);

  const svg = createSvgElement('svg', {
    class: 'video-chart-svg',
    viewBox: '0 0 680 270',
    role: 'img',
    'aria-label': asText(chart?.title, 'Animated chart')
  });
  const plot = { left: 42, top: 16, width: 612, height: 194 };
  const { minimum, span } = getChartBounds(chart);
  const labels = Array.isArray(chart?.labels) ? chart.labels : [];
  const datasets = Array.isArray(chart?.datasets) ? chart.datasets : [];
  const yFor = (value) => plot.top + (plot.height - ((value - minimum) / span) * plot.height);
  const zeroY = yFor(0);

  [0, 0.5, 1].forEach((ratio) => {
    const y = plot.top + plot.height * ratio;
    svg.appendChild(createSvgElement('line', {
      class: 'video-chart-grid',
      x1: plot.left,
      x2: plot.left + plot.width,
      y1: y,
      y2: y
    }));
  });

  svg.appendChild(createSvgElement('line', {
    class: 'video-chart-grid',
    x1: plot.left,
    x2: plot.left + plot.width,
    y1: zeroY,
    y2: zeroY
  }));

  const pointStep = labels.length > 1 ? plot.width / (labels.length - 1) : 0;
  const barDatasetCount = datasets.filter((dataset) => dataset.type === 'bar').length || 1;
  let renderedBarIndex = 0;

  datasets.forEach((dataset, datasetIndex) => {
    const color = asText(dataset?.color, CHART_COLORS[datasetIndex % CHART_COLORS.length]);
    const values = Array.isArray(dataset?.data) ? dataset.data : [];
    const isBar = dataset?.type === 'bar' || chart?.type === 'bar';

    if (isBar) {
      const groupWidth = labels.length > 0 ? Math.min(54, (plot.width / labels.length) * 0.72) : 32;
      const barWidth = groupWidth / barDatasetCount;
      values.forEach((value, valueIndex) => {
        const center = labels.length > 1
          ? plot.left + valueIndex * pointStep
          : plot.left + plot.width / 2;
        const x = center - groupWidth / 2 + renderedBarIndex * barWidth;
        const valueY = yFor(value);
        const y = Math.min(valueY, zeroY);
        const height = Math.max(2, Math.abs(zeroY - valueY));
        const bar = createSvgElement('rect', {
          class: 'video-chart-bar',
          x,
          y,
          width: Math.max(3, barWidth - 2),
          height,
          rx: 2,
          fill: color,
          opacity: 0.88
        });
        bar.style.animationDelay = `${120 + valueIndex * 70 + datasetIndex * 120}ms`;
        svg.appendChild(bar);
      });
      renderedBarIndex += 1;
      return;
    }

    const points = values.map((value, valueIndex) => {
      const x = labels.length > 1
        ? plot.left + valueIndex * pointStep
        : plot.left + plot.width / 2;
      return `${x.toFixed(2)},${yFor(value).toFixed(2)}`;
    });
    const line = createSvgElement('polyline', {
      class: 'video-chart-line',
      points: points.join(' '),
      stroke: color
    });
    svg.appendChild(line);
    try {
      const length = line.getTotalLength();
      line.style.strokeDasharray = String(length);
      line.style.strokeDashoffset = String(length);
    } catch (_error) {
      // SVG path measurement is visual enhancement only.
    }
  });

  const labelIndexes = labels.length <= 5
    ? labels.map((_, index) => index)
    : [...new Set([0, Math.floor((labels.length - 1) / 2), labels.length - 1])];
  labelIndexes.forEach((index) => {
    const text = createSvgElement('text', {
      class: 'video-chart-label',
      x: labels.length > 1 ? plot.left + index * pointStep : plot.left + plot.width / 2,
      y: 240,
      'text-anchor': 'middle'
    });
    text.textContent = String(labels[index] || '');
    svg.appendChild(text);
  });

  shell.appendChild(svg);

  const legend = createElement('div', 'video-chart-legend');
  datasets.forEach((dataset, index) => {
    const item = createElement('span', 'video-chart-legend-item');
    const swatch = createElement('span', 'video-chart-legend-swatch');
    swatch.style.background = asText(dataset?.color, CHART_COLORS[index % CHART_COLORS.length]);
    const label = createElement('span');
    label.textContent = asText(dataset?.label, `Series ${index + 1}`);
    item.append(swatch, label);
    legend.appendChild(item);
  });
  shell.appendChild(legend);
  return shell;
}

function renderFlowVisual(nodes) {
  const shell = createElement('section', 'video-flow-shell');
  const list = createElement('div', 'video-flow-list');
  list.style.setProperty('--video-flow-count', String(Math.max(1, nodes.length)));

  nodes.forEach((node, index) => {
    const item = createElement('article', 'video-flow-node');
    const kicker = createElement('span', 'video-flow-kicker');
    kicker.textContent = asText(node?.kicker, `Step ${index + 1}`);
    const title = createElement('strong', 'video-flow-title');
    title.textContent = asText(node?.title, `Step ${index + 1}`);
    item.append(kicker, title);
    if (asText(node?.detail)) {
      const detail = createElement('span', 'video-flow-detail');
      detail.textContent = asText(node.detail);
      item.appendChild(detail);
    }
    list.appendChild(item);
  });
  shell.appendChild(list);
  return shell;
}

function renderVisual(story) {
  if (!ui.storyVisual) {
    return;
  }
  ui.storyVisual.replaceChildren();
  if (Array.isArray(story?.charts) && story.charts.length > 0) {
    ui.storyVisual.appendChild(renderChartVisual(story.charts[0]));
    return;
  }
  if (Array.isArray(story?.flowNodes) && story.flowNodes.length > 0) {
    ui.storyVisual.appendChild(renderFlowVisual(story.flowNodes));
  }
}

function renderReview(manifestValue) {
  if (!ui.reviewSource || !ui.reviewMetrics) {
    return;
  }

  ui.reviewSource.replaceChildren();
  [
    ['Client', manifestValue.source.clientName],
    ['Module', manifestValue.source.moduleKindLabel],
    ['Scenario', manifestValue.source.activeScenario?.title || 'Current module'],
    ['Module ID', manifestValue.source.moduleId],
    ['Session ID', manifestValue.source.sessionId]
  ].forEach(([label, value]) => {
    const term = createElement('dt');
    term.textContent = label;
    const detail = createElement('dd');
    detail.textContent = asText(value, 'Not available');
    ui.reviewSource.append(term, detail);
  });

  ui.reviewMetrics.replaceChildren();
  const metrics = Array.isArray(manifestValue.review?.visibleMetrics)
    ? manifestValue.review.visibleMetrics
    : [];
  if (metrics.length === 0) {
    const item = createElement('li');
    item.textContent = 'No metric cards will be shown in this scene.';
    ui.reviewMetrics.appendChild(item);
  } else {
    metrics.forEach((metric) => {
      const item = createElement('li');
      const label = createElement('span');
      label.textContent = asText(metric?.label, 'Metric');
      const value = createElement('strong');
      value.textContent = asText(metric?.value, '—');
      item.append(label, value);
      ui.reviewMetrics.appendChild(item);
    });
  }

  if (ui.calculationNotice) {
    const hasFallback = manifestValue.source.calculationStatus === 'source-fallback';
    ui.calculationNotice.classList.toggle('is-hidden', !hasFallback);
    ui.calculationNotice.textContent = hasFallback
      ? `The source module values are shown because this calculation could not be recomputed: ${asText(manifestValue.source.calculationError, 'Unknown reason')}`
      : '';
  }
}

function renderManifest(manifestValue) {
  setText(ui.composerTitle, manifestValue.story.title || 'Video scene');
  setText(ui.storyKind, manifestValue.source.moduleKindLabel || 'Planning conversation');
  setText(ui.storyTitle, manifestValue.story.title || 'Planning conversation');
  setText(ui.storySummary, manifestValue.story.summary || 'Use this scene to establish the central decision before discussing the detail.');
  setText(ui.storyTakeaway, manifestValue.story.summary || 'Return to the client conversation with the decision in view.');
  renderMetricCards(manifestValue.story.metrics);
  renderVisual(manifestValue.story);
  renderReview(manifestValue);
}

function clearSequenceTimers() {
  sequenceTimers.forEach((timerId) => window.clearTimeout(timerId));
  sequenceTimers = [];
}

function playSequence() {
  if (!manifest || !ui.stage) {
    return;
  }
  clearSequenceTimers();
  const beats = Array.isArray(manifest.story?.beats) ? manifest.story.beats : [];
  let delay = 0;
  ui.stage.dataset.beat = 'hook';

  beats.forEach((beat, index) => {
    const beatId = asText(beat?.id, index === 0 ? 'hook' : 'takeaway');
    const timerId = window.setTimeout(() => {
      ui.stage.dataset.beat = beatId;
    }, delay);
    sequenceTimers.push(timerId);
    delay += Math.max(900, Number(beat?.durationMs) || 3200);
  });
}

function setCaptureMode(enabled) {
  document.body.classList.toggle('is-capture-mode', enabled);
  ui.stage?.classList.toggle('is-capture-ready', enabled);
  if (enabled) {
    playSequence();
  }
}

function bindEvents() {
  ui.reviewCompleteButton?.addEventListener('click', () => {
    reviewComplete = true;
    ui.reviewCompleteButton.disabled = true;
    ui.reviewCompleteButton.textContent = 'Review completed';
    if (ui.startCaptureButton) {
      ui.startCaptureButton.disabled = false;
    }
    setText(ui.reviewStatus, 'Review completed. You can now start the capture sequence.');
  });

  ui.startCaptureButton?.addEventListener('click', () => {
    if (!reviewComplete) {
      setText(ui.reviewStatus, 'Review the visible values and mark the review complete first.');
      return;
    }
    setCaptureMode(true);
  });

  ui.restartButton?.addEventListener('click', () => {
    playSequence();
    setText(ui.reviewStatus, 'Sequence restarted.');
  });

  ui.mirrorButton?.addEventListener('click', () => {
    presenterPosition = presenterPosition === 'right' ? 'left' : 'right';
    if (ui.stage) {
      ui.stage.dataset.presenterPosition = presenterPosition;
    }
    ui.mirrorButton.textContent = presenterPosition === 'right' ? 'Presenter left' : 'Presenter right';
  });

  ui.fullscreenButton?.addEventListener('click', async () => {
    if (!ui.stageFrame) {
      return;
    }
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await ui.stageFrame.requestFullscreen();
      }
    } catch (_error) {
      setText(ui.reviewStatus, 'Full-screen preview is unavailable in this browser.');
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.classList.contains('is-capture-mode')) {
      event.preventDefault();
      setCaptureMode(false);
      setText(ui.reviewStatus, 'Capture mode closed. The scene remains ready to restart.');
    }
  });

  window.addEventListener('beforeunload', clearSequenceTimers);
}

function init() {
  manifest = getSceneManifest();
  if (!manifest) {
    ui.emptyState?.classList.remove('is-hidden');
    return;
  }

  ui.sceneShell?.classList.remove('is-hidden');
  renderManifest(manifest);
  bindEvents();
}

init();
