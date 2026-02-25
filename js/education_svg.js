const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const SUPPORTED_KINDS = new Set(['flowchart', 'timeline', 'decisionTree', 'processMap', 'comparisonGrid']);

let markerSequence = 0;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toFiniteNumber(value, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  let normalized = parsed;
  if (integer) {
    normalized = Math.round(normalized);
  }

  if (normalized < min) {
    return min;
  }

  if (normalized > max) {
    return max;
  }

  return normalized;
}

function toNonEmptyString(value, fallback = '') {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeTheme(value) {
  return String(value || '').trim().toLowerCase() === 'light' ? 'light' : 'dark';
}

function normalizeDirection(value, fallback = 'TB') {
  return String(value || '').trim().toUpperCase() === 'LR' ? 'LR' : fallback;
}

function normalizeConnector(value) {
  return String(value || '').trim().toLowerCase() === 'straight' ? 'straight' : 'elbow';
}

function wrapText(value, maxChars = 22, maxLines = 3) {
  const raw = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) {
    return [''];
  }

  const words = raw.split(' ');
  const lines = [];
  let current = '';

  words.forEach((word) => {
    if (!current) {
      current = word;
      return;
    }

    const next = `${current} ${word}`;
    if (next.length <= maxChars) {
      current = next;
      return;
    }

    lines.push(current);
    current = word;
  });

  if (current) {
    lines.push(current);
  }

  if (lines.length <= maxLines) {
    return lines;
  }

  const clipped = lines.slice(0, maxLines);
  const lastIndex = clipped.length - 1;
  const last = clipped[lastIndex];
  clipped[lastIndex] = last.endsWith('...') ? last : `${last.slice(0, Math.max(0, maxChars - 3))}...`;
  return clipped;
}

function createSvgElement(name, attrs = {}) {
  const element = document.createElementNS(SVG_NS, name);

  Object.entries(attrs).forEach(([key, value]) => {
    if (value === null || typeof value === 'undefined') {
      return;
    }

    if (key === 'xlink:href') {
      element.setAttributeNS(XLINK_NS, key, String(value));
      return;
    }

    element.setAttribute(key, String(value));
  });

  return element;
}

function appendMultilineText(parent, {
  text,
  x,
  y,
  maxChars = 22,
  maxLines = 3,
  lineHeight = 16,
  className,
  anchor = 'middle'
}) {
  const lines = wrapText(text, maxChars, maxLines);
  const textNode = createSvgElement('text', {
    x,
    y,
    class: className || null,
    'text-anchor': anchor,
    'dominant-baseline': 'middle'
  });

  lines.forEach((line, index) => {
    const tspan = createSvgElement('tspan', {
      x,
      dy: index === 0 ? '0' : String(lineHeight)
    });
    tspan.textContent = line;
    textNode.appendChild(tspan);
  });

  if (lines.length > 1) {
    const shift = ((lines.length - 1) * lineHeight) / 2;
    textNode.setAttribute('transform', `translate(0 ${-shift})`);
  }

  parent.appendChild(textNode);
}

function createRootSvg({ width, height, theme, title = '' }) {
  const safeWidth = Math.max(120, Math.ceil(width));
  const safeHeight = Math.max(120, Math.ceil(height));

  const svg = createSvgElement('svg', {
    xmlns: SVG_NS,
    viewBox: `0 0 ${safeWidth} ${safeHeight}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    class: 'education-svg',
    'data-theme': theme
  });
  svg.style.width = '100%';
  svg.style.height = 'auto';

  if (title) {
    const titleEl = createSvgElement('title');
    titleEl.textContent = title;
    svg.appendChild(titleEl);
  }

  return svg;
}

function addArrowMarker(svg) {
  const markerId = `education-arrow-${++markerSequence}`;
  const defs = createSvgElement('defs');
  const marker = createSvgElement('marker', {
    id: markerId,
    viewBox: '0 0 10 10',
    refX: '9',
    refY: '5',
    markerWidth: '8',
    markerHeight: '8',
    orient: 'auto-start-reverse'
  });

  const arrowShape = createSvgElement('path', {
    d: 'M 0 0 L 10 5 L 0 10 z',
    class: 'edu-arrow-head'
  });

  marker.appendChild(arrowShape);
  defs.appendChild(marker);
  svg.appendChild(defs);
  return markerId;
}

function drawNodeBox(layer, node, {
  x,
  y,
  width,
  height,
  radius = 12
}) {
  const rect = createSvgElement('rect', {
    x,
    y,
    rx: radius,
    ry: radius,
    width,
    height,
    class: 'edu-node'
  });
  layer.appendChild(rect);

  const centerX = x + width / 2;
  const centerY = y + height / 2;
  appendMultilineText(layer, {
    text: node.label,
    x: centerX,
    y: centerY,
    className: 'edu-node-label',
    maxChars: Math.max(10, Math.round(width / 8.5)),
    maxLines: 3,
    lineHeight: 15
  });
}

function normalizeGraphNodes(rawNodes, label) {
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    throw new Error(`${label}.nodes must be a non-empty array.`);
  }

  const idSet = new Set();
  return rawNodes.map((rawNode, index) => {
    if (!isPlainObject(rawNode)) {
      throw new Error(`${label}.nodes[${index}] must be an object.`);
    }

    const baseId = toNonEmptyString(rawNode.id, `node-${index + 1}`);
    let id = baseId;
    let suffix = 2;
    while (idSet.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    idSet.add(id);

    return {
      id,
      label: toNonEmptyString(rawNode.label, id),
      level: Number.isFinite(Number(rawNode.level))
        ? Math.max(0, Math.round(Number(rawNode.level)))
        : null,
      _order: index
    };
  });
}

function normalizeGraphEdges(rawEdges, nodeMap, label) {
  if (!Array.isArray(rawEdges)) {
    return [];
  }

  return rawEdges
    .map((edge, index) => {
      if (!isPlainObject(edge)) {
        return null;
      }

      const from = toNonEmptyString(edge.from);
      const to = toNonEmptyString(edge.to);
      if (!from || !to) {
        return null;
      }

      if (!nodeMap.has(from) || !nodeMap.has(to)) {
        return null;
      }

      return {
        from,
        to,
        label: toNonEmptyString(edge.label),
        _order: index
      };
    })
    .filter(Boolean);
}

function buildOutgoingIndex(edges) {
  const outgoing = new Map();
  edges.forEach((edge) => {
    if (!outgoing.has(edge.from)) {
      outgoing.set(edge.from, []);
    }
    outgoing.get(edge.from).push(edge);
  });
  return outgoing;
}

function computeLayering(nodes, edges) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));

  edges.forEach((edge) => {
    indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
  });

  const orderById = new Map(nodes.map((node) => [node.id, node._order]));
  const queue = nodes
    .filter((node) => (indegree.get(node.id) || 0) === 0)
    .map((node) => node.id)
    .sort((left, right) => (orderById.get(left) || 0) - (orderById.get(right) || 0));

  const layerById = new Map();
  nodes.forEach((node) => {
    if (Number.isInteger(node.level) && node.level >= 0) {
      layerById.set(node.id, node.level);
    }
  });

  const outgoing = buildOutgoingIndex(edges);

  while (queue.length > 0) {
    const currentId = queue.shift();
    const currentLayer = layerById.get(currentId) || 0;
    const nextEdges = outgoing.get(currentId) || [];

    nextEdges.forEach((edge) => {
      const candidateLayer = currentLayer + 1;
      const existing = layerById.get(edge.to);
      if (!Number.isInteger(existing) || candidateLayer > existing) {
        layerById.set(edge.to, candidateLayer);
      }

      indegree.set(edge.to, (indegree.get(edge.to) || 0) - 1);
      if ((indegree.get(edge.to) || 0) === 0) {
        queue.push(edge.to);
      }
    });

    queue.sort((left, right) => (orderById.get(left) || 0) - (orderById.get(right) || 0));
  }

  nodes.forEach((node) => {
    if (!Number.isInteger(layerById.get(node.id))) {
      layerById.set(node.id, Number.isInteger(node.level) && node.level >= 0 ? node.level : 0);
    }
  });

  return layerById;
}

function layoutLayeredGraph(nodes, layerById, {
  direction,
  nodeWidth,
  nodeHeight,
  gapX,
  gapY,
  paddingX,
  paddingY
}) {
  const nodesByLayer = new Map();
  nodes.forEach((node) => {
    const layer = layerById.get(node.id) || 0;
    if (!nodesByLayer.has(layer)) {
      nodesByLayer.set(layer, []);
    }
    nodesByLayer.get(layer).push(node);
  });

  const sortedLayers = [...nodesByLayer.keys()].sort((left, right) => left - right);
  sortedLayers.forEach((layer) => {
    nodesByLayer.get(layer).sort((left, right) => left._order - right._order);
  });

  const largestBand = Math.max(1, ...sortedLayers.map((layer) => nodesByLayer.get(layer).length));
  const maxBandSpanX = (largestBand * nodeWidth) + ((largestBand - 1) * gapX);
  const maxBandSpanY = (largestBand * nodeHeight) + ((largestBand - 1) * gapY);

  const positionById = new Map();

  sortedLayers.forEach((layer, layerIndex) => {
    const band = nodesByLayer.get(layer);

    if (direction === 'LR') {
      const bandHeight = (band.length * nodeHeight) + ((band.length - 1) * gapY);
      const startY = paddingY + (maxBandSpanY - bandHeight) / 2;
      const x = paddingX + layerIndex * (nodeWidth + gapX);

      band.forEach((node, nodeIndex) => {
        const y = startY + nodeIndex * (nodeHeight + gapY);
        positionById.set(node.id, { x, y });
      });
      return;
    }

    const bandWidth = (band.length * nodeWidth) + ((band.length - 1) * gapX);
    const startX = paddingX + (maxBandSpanX - bandWidth) / 2;
    const y = paddingY + layerIndex * (nodeHeight + gapY);

    band.forEach((node, nodeIndex) => {
      const x = startX + nodeIndex * (nodeWidth + gapX);
      positionById.set(node.id, { x, y });
    });
  });

  const width = direction === 'LR'
    ? paddingX * 2 + (sortedLayers.length * nodeWidth) + Math.max(0, sortedLayers.length - 1) * gapX
    : paddingX * 2 + maxBandSpanX;
  const height = direction === 'LR'
    ? paddingY * 2 + maxBandSpanY
    : paddingY * 2 + (sortedLayers.length * nodeHeight) + Math.max(0, sortedLayers.length - 1) * gapY;

  return {
    positionById,
    width,
    height
  };
}

function buildConnectorPath(fromPos, toPos, {
  nodeWidth,
  nodeHeight,
  direction,
  connector
}) {
  let sx;
  let sy;
  let ex;
  let ey;

  if (direction === 'LR') {
    sx = fromPos.x + nodeWidth;
    sy = fromPos.y + nodeHeight / 2;
    ex = toPos.x;
    ey = toPos.y + nodeHeight / 2;
  } else {
    sx = fromPos.x + nodeWidth / 2;
    sy = fromPos.y + nodeHeight;
    ex = toPos.x + nodeWidth / 2;
    ey = toPos.y;
  }

  if (connector === 'straight') {
    return {
      d: `M ${sx} ${sy} L ${ex} ${ey}`,
      labelX: (sx + ex) / 2,
      labelY: (sy + ey) / 2
    };
  }

  if (direction === 'LR') {
    const midX = sx + (ex - sx) / 2;
    return {
      d: `M ${sx} ${sy} L ${midX} ${sy} L ${midX} ${ey} L ${ex} ${ey}`,
      labelX: midX,
      labelY: sy + (ey - sy) / 2
    };
  }

  const midY = sy + (ey - sy) / 2;
  return {
    d: `M ${sx} ${sy} L ${sx} ${midY} L ${ex} ${midY} L ${ex} ${ey}`,
    labelX: sx + (ex - sx) / 2,
    labelY: midY
  };
}

function renderLayeredGraph(spec, kindLabel) {
  const nodes = normalizeGraphNodes(spec.nodes, kindLabel);
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const edges = normalizeGraphEdges(spec.edges, nodeMap, kindLabel);

  const layout = isPlainObject(spec.layout) ? spec.layout : {};
  const direction = normalizeDirection(layout.direction, 'TB');
  const nodeWidth = toFiniteNumber(layout.nodeWidth, 190, { min: 100, max: 420 });
  const nodeHeight = toFiniteNumber(layout.nodeHeight, 78, { min: 48, max: 220 });
  const gapX = toFiniteNumber(layout.gapX, 48, { min: 12, max: 220 });
  const gapY = toFiniteNumber(layout.gapY, 40, { min: 12, max: 220 });
  const paddingX = toFiniteNumber(layout.paddingX, 36, { min: 8, max: 160 });
  const paddingY = toFiniteNumber(layout.paddingY, 36, { min: 8, max: 160 });
  const connector = normalizeConnector(layout.connector);
  const theme = normalizeTheme(spec.theme);

  const layerById = computeLayering(nodes, edges);
  const {
    positionById,
    width,
    height
  } = layoutLayeredGraph(nodes, layerById, {
    direction,
    nodeWidth,
    nodeHeight,
    gapX,
    gapY,
    paddingX,
    paddingY
  });

  const svg = createRootSvg({
    width,
    height,
    theme,
    title: toNonEmptyString(spec.title, toNonEmptyString(spec.topic, 'Education diagram'))
  });

  const edgeLayer = createSvgElement('g', { class: 'edu-edge-layer' });
  const nodeLayer = createSvgElement('g', { class: 'edu-node-layer' });
  svg.appendChild(edgeLayer);
  svg.appendChild(nodeLayer);

  const markerId = addArrowMarker(svg);

  edges.forEach((edge) => {
    const fromPos = positionById.get(edge.from);
    const toPos = positionById.get(edge.to);
    if (!fromPos || !toPos) {
      return;
    }

    const pathData = buildConnectorPath(fromPos, toPos, {
      nodeWidth,
      nodeHeight,
      direction,
      connector
    });

    const edgePath = createSvgElement('path', {
      d: pathData.d,
      class: 'edu-edge',
      'marker-end': `url(#${markerId})`
    });
    edgeLayer.appendChild(edgePath);

    if (edge.label) {
      appendMultilineText(edgeLayer, {
        text: edge.label,
        x: pathData.labelX,
        y: pathData.labelY - 8,
        className: 'edu-edge-label',
        maxChars: 18,
        maxLines: 2,
        lineHeight: 13
      });
    }
  });

  nodes.forEach((node) => {
    const position = positionById.get(node.id);
    if (!position) {
      return;
    }

    drawNodeBox(nodeLayer, node, {
      x: position.x,
      y: position.y,
      width: nodeWidth,
      height: nodeHeight,
      radius: 12
    });
  });

  return svg;
}

function normalizeTimelineEvents(spec) {
  const source = Array.isArray(spec.events) ? spec.events : (Array.isArray(spec.nodes) ? spec.nodes : []);
  if (source.length === 0) {
    throw new Error('timeline requires events[] or nodes[].');
  }

  return source.map((event, index) => {
    if (!isPlainObject(event)) {
      throw new Error(`timeline.events[${index}] must be an object.`);
    }

    const label = toNonEmptyString(event.label, `Event ${index + 1}`);
    const lane = toNonEmptyString(event.lane, 'timeline');
    const when = toNonEmptyString(event.when || event.date);
    const orderValue = Number(event.order);
    const parsedDate = Date.parse(when);

    let order = index;
    if (Number.isFinite(orderValue)) {
      order = orderValue;
    } else if (Number.isFinite(parsedDate)) {
      order = parsedDate;
    }

    return {
      id: toNonEmptyString(event.id, `event-${index + 1}`),
      label,
      lane,
      when,
      order,
      _order: index
    };
  }).sort((left, right) => {
    if (left.order !== right.order) {
      return left.order - right.order;
    }

    return left._order - right._order;
  });
}

function normalizeLanes(rawLanes, events) {
  const lanes = [];
  const seen = new Set();

  if (Array.isArray(rawLanes)) {
    rawLanes.forEach((lane, index) => {
      let id = '';
      let title = '';

      if (typeof lane === 'string') {
        id = toNonEmptyString(lane, `lane-${index + 1}`);
        title = id;
      } else if (isPlainObject(lane)) {
        id = toNonEmptyString(lane.id, `lane-${index + 1}`);
        title = toNonEmptyString(lane.title, id);
      }

      if (!id || seen.has(id)) {
        return;
      }

      seen.add(id);
      lanes.push({ id, title });
    });
  }

  events.forEach((event) => {
    if (!seen.has(event.lane)) {
      seen.add(event.lane);
      lanes.push({
        id: event.lane,
        title: event.lane
      });
    }
  });

  if (lanes.length === 0) {
    lanes.push({ id: 'timeline', title: 'Timeline' });
  }

  return lanes;
}

function renderTimeline(spec) {
  const events = normalizeTimelineEvents(spec);
  const lanes = normalizeLanes(spec.lanes, events);
  const laneIndexById = new Map(lanes.map((lane, index) => [lane.id, index]));

  const layout = isPlainObject(spec.layout) ? spec.layout : {};
  const laneGap = toFiniteNumber(layout.laneGap, 140, { min: 90, max: 320 });
  const eventGap = toFiniteNumber(layout.eventGap, 220, { min: 120, max: 420 });
  const cardWidth = toFiniteNumber(layout.nodeWidth, 180, { min: 110, max: 280 });
  const cardHeight = toFiniteNumber(layout.nodeHeight, 90, { min: 60, max: 220 });
  const marginLeft = toFiniteNumber(layout.marginLeft, 132, { min: 90, max: 280 });
  const marginTop = toFiniteNumber(layout.marginTop, 42, { min: 16, max: 140 });
  const marginRight = toFiniteNumber(layout.marginRight, 48, { min: 16, max: 180 });
  const marginBottom = toFiniteNumber(layout.marginBottom, 36, { min: 16, max: 180 });
  const theme = normalizeTheme(spec.theme);

  const eventSpan = Math.max(cardWidth, (events.length - 1) * eventGap + cardWidth);
  const width = marginLeft + eventSpan + marginRight;
  const height = marginTop + lanes.length * laneGap + cardHeight + marginBottom;

  const svg = createRootSvg({
    width,
    height,
    theme,
    title: toNonEmptyString(spec.title, 'Timeline diagram')
  });

  const laneLayer = createSvgElement('g', { class: 'edu-timeline-lanes' });
  const eventLayer = createSvgElement('g', { class: 'edu-timeline-events' });
  svg.appendChild(laneLayer);
  svg.appendChild(eventLayer);

  lanes.forEach((lane, index) => {
    const lineY = marginTop + index * laneGap + 24;

    const laneLabel = createSvgElement('text', {
      x: marginLeft - 12,
      y: lineY,
      class: 'edu-lane-label',
      'text-anchor': 'end',
      'dominant-baseline': 'middle'
    });
    laneLabel.textContent = lane.title;
    laneLayer.appendChild(laneLabel);

    laneLayer.appendChild(createSvgElement('line', {
      x1: marginLeft,
      y1: lineY,
      x2: marginLeft + eventSpan - cardWidth / 2,
      y2: lineY,
      class: 'edu-timeline-axis'
    }));
  });

  events.forEach((event, index) => {
    const laneIndex = laneIndexById.has(event.lane) ? laneIndexById.get(event.lane) : 0;
    const lineY = marginTop + laneIndex * laneGap + 24;
    const x = marginLeft + index * eventGap;

    eventLayer.appendChild(createSvgElement('circle', {
      cx: x,
      cy: lineY,
      r: 8,
      class: 'edu-timeline-dot'
    }));

    const cardX = Math.min(width - cardWidth - 8, Math.max(8, x - cardWidth / 2));
    const cardY = lineY + 20;

    eventLayer.appendChild(createSvgElement('line', {
      x1: x,
      y1: lineY + 8,
      x2: x,
      y2: cardY,
      class: 'edu-timeline-stem'
    }));

    eventLayer.appendChild(createSvgElement('rect', {
      x: cardX,
      y: cardY,
      rx: 10,
      ry: 10,
      width: cardWidth,
      height: cardHeight,
      class: 'edu-node'
    }));

    if (event.when) {
      const whenLabel = createSvgElement('text', {
        x,
        y: lineY - 12,
        class: 'edu-timeline-when',
        'text-anchor': 'middle',
        'dominant-baseline': 'middle'
      });
      whenLabel.textContent = event.when;
      eventLayer.appendChild(whenLabel);
    }

    appendMultilineText(eventLayer, {
      text: event.label,
      x: cardX + cardWidth / 2,
      y: cardY + cardHeight / 2,
      className: 'edu-node-label',
      maxChars: Math.max(12, Math.round(cardWidth / 8.2)),
      maxLines: 4,
      lineHeight: 14
    });
  });

  return svg;
}

function normalizeProcessSteps(spec) {
  const source = Array.isArray(spec.steps) ? spec.steps : (Array.isArray(spec.nodes) ? spec.nodes : []);
  if (source.length === 0) {
    throw new Error('processMap requires steps[] or nodes[].');
  }

  return source.map((step, index) => {
    if (!isPlainObject(step)) {
      throw new Error(`processMap.steps[${index}] must be an object.`);
    }

    return {
      id: toNonEmptyString(step.id, `step-${index + 1}`),
      label: toNonEmptyString(step.label, `Step ${index + 1}`),
      lane: toNonEmptyString(step.lane, 'process'),
      order: Number.isFinite(Number(step.order)) ? Number(step.order) : index,
      _order: index
    };
  });
}

function renderProcessMap(spec) {
  const steps = normalizeProcessSteps(spec);
  const lanes = normalizeLanes(spec.lanes, steps);
  const laneIndexById = new Map(lanes.map((lane, index) => [lane.id, index]));

  const stepsByLane = new Map(lanes.map((lane) => [lane.id, []]));
  steps.forEach((step) => {
    const laneId = laneIndexById.has(step.lane) ? step.lane : lanes[0].id;
    stepsByLane.get(laneId).push({ ...step, lane: laneId });
  });
  stepsByLane.forEach((laneSteps) => {
    laneSteps.sort((left, right) => {
      if (left.order !== right.order) {
        return left.order - right.order;
      }
      return left._order - right._order;
    });
  });

  const layout = isPlainObject(spec.layout) ? spec.layout : {};
  const nodeWidth = toFiniteNumber(layout.nodeWidth, 170, { min: 100, max: 320 });
  const nodeHeight = toFiniteNumber(layout.nodeHeight, 70, { min: 48, max: 220 });
  const laneWidth = toFiniteNumber(layout.laneWidth, nodeWidth + 48, { min: nodeWidth + 12, max: 500 });
  const gapX = toFiniteNumber(layout.gapX, 42, { min: 12, max: 220 });
  const gapY = toFiniteNumber(layout.gapY, 30, { min: 10, max: 220 });
  const paddingX = toFiniteNumber(layout.paddingX, 28, { min: 8, max: 220 });
  const paddingY = toFiniteNumber(layout.paddingY, 24, { min: 8, max: 220 });
  const headerHeight = toFiniteNumber(layout.headerHeight, 52, { min: 28, max: 220 });
  const connector = normalizeConnector(layout.connector);
  const theme = normalizeTheme(spec.theme);

  const maxRows = Math.max(1, ...lanes.map((lane) => (stepsByLane.get(lane.id) || []).length));
  const width = paddingX * 2 + lanes.length * laneWidth + Math.max(0, lanes.length - 1) * gapX;
  const height = paddingY * 2 + headerHeight + maxRows * nodeHeight + Math.max(0, maxRows - 1) * gapY + 24;

  const svg = createRootSvg({
    width,
    height,
    theme,
    title: toNonEmptyString(spec.title, 'Process map diagram')
  });

  const laneLayer = createSvgElement('g', { class: 'edu-process-lanes' });
  const edgeLayer = createSvgElement('g', { class: 'edu-edge-layer' });
  const nodeLayer = createSvgElement('g', { class: 'edu-node-layer' });

  svg.appendChild(laneLayer);
  svg.appendChild(edgeLayer);
  svg.appendChild(nodeLayer);

  const markerId = addArrowMarker(svg);
  const positionById = new Map();

  lanes.forEach((lane, laneIndex) => {
    const laneX = paddingX + laneIndex * (laneWidth + gapX);

    laneLayer.appendChild(createSvgElement('rect', {
      x: laneX,
      y: paddingY,
      width: laneWidth,
      height: height - paddingY * 2,
      rx: 12,
      ry: 12,
      class: 'edu-lane'
    }));

    const laneTitle = createSvgElement('text', {
      x: laneX + laneWidth / 2,
      y: paddingY + 26,
      class: 'edu-lane-title',
      'text-anchor': 'middle',
      'dominant-baseline': 'middle'
    });
    laneTitle.textContent = lane.title;
    laneLayer.appendChild(laneTitle);

    const laneSteps = stepsByLane.get(lane.id) || [];
    laneSteps.forEach((step, rowIndex) => {
      const x = laneX + (laneWidth - nodeWidth) / 2;
      const y = paddingY + headerHeight + rowIndex * (nodeHeight + gapY);
      positionById.set(step.id, { x, y, laneIndex });
      drawNodeBox(nodeLayer, step, {
        x,
        y,
        width: nodeWidth,
        height: nodeHeight,
        radius: 10
      });
    });
  });

  const nodeById = new Map(steps.map((step) => [step.id, step]));
  let edges = normalizeGraphEdges(spec.edges, nodeById, 'processMap');

  if (edges.length === 0) {
    lanes.forEach((lane) => {
      const laneSteps = stepsByLane.get(lane.id) || [];
      for (let index = 0; index < laneSteps.length - 1; index += 1) {
        edges.push({
          from: laneSteps[index].id,
          to: laneSteps[index + 1].id,
          label: ''
        });
      }
    });
  }

  edges.forEach((edge) => {
    const fromPos = positionById.get(edge.from);
    const toPos = positionById.get(edge.to);
    if (!fromPos || !toPos) {
      return;
    }

    const fromCenterX = fromPos.x + nodeWidth / 2;
    const fromCenterY = fromPos.y + nodeHeight / 2;
    const toCenterX = toPos.x + nodeWidth / 2;
    const toCenterY = toPos.y + nodeHeight / 2;

    const horizontalDominant = Math.abs(toCenterX - fromCenterX) >= Math.abs(toCenterY - fromCenterY);

    let sx = fromCenterX;
    let sy = fromCenterY;
    let ex = toCenterX;
    let ey = toCenterY;

    if (horizontalDominant) {
      sx = toCenterX >= fromCenterX ? fromPos.x + nodeWidth : fromPos.x;
      sy = fromCenterY;
      ex = toCenterX >= fromCenterX ? toPos.x : toPos.x + nodeWidth;
      ey = toCenterY;
    } else {
      sx = fromCenterX;
      sy = toCenterY >= fromCenterY ? fromPos.y + nodeHeight : fromPos.y;
      ex = toCenterX;
      ey = toCenterY >= fromCenterY ? toPos.y : toPos.y + nodeHeight;
    }

    let d = `M ${sx} ${sy} L ${ex} ${ey}`;
    let labelX = (sx + ex) / 2;
    let labelY = (sy + ey) / 2;

    if (connector !== 'straight') {
      if (horizontalDominant) {
        const midX = sx + (ex - sx) / 2;
        d = `M ${sx} ${sy} L ${midX} ${sy} L ${midX} ${ey} L ${ex} ${ey}`;
        labelX = midX;
        labelY = (sy + ey) / 2;
      } else {
        const midY = sy + (ey - sy) / 2;
        d = `M ${sx} ${sy} L ${sx} ${midY} L ${ex} ${midY} L ${ex} ${ey}`;
        labelX = (sx + ex) / 2;
        labelY = midY;
      }
    }

    const path = createSvgElement('path', {
      d,
      class: 'edu-edge',
      'marker-end': `url(#${markerId})`
    });
    edgeLayer.appendChild(path);

    if (edge.label) {
      appendMultilineText(edgeLayer, {
        text: edge.label,
        x: labelX,
        y: labelY - 8,
        className: 'edu-edge-label',
        maxChars: 18,
        maxLines: 2,
        lineHeight: 13
      });
    }
  });

  return svg;
}

function normalizeComparisonToken(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function pushUniqueAxisItem(items, seenTokens, rawId, rawTitle = rawId) {
  const id = toNonEmptyString(rawId);
  const title = toNonEmptyString(rawTitle, id);
  if (!id) {
    return;
  }

  const idToken = normalizeComparisonToken(id);
  const titleToken = normalizeComparisonToken(title);
  if (!idToken || seenTokens.has(idToken) || (titleToken && seenTokens.has(titleToken))) {
    return;
  }

  seenTokens.add(idToken);
  if (titleToken) {
    seenTokens.add(titleToken);
  }
  items.push({ id, title });
}

function normalizeExplicitComparisonColumns(spec) {
  if (!Array.isArray(spec.columns)) {
    return [];
  }

  const columns = [];
  const seenTokens = new Set();

  spec.columns.forEach((column, index) => {
    if (typeof column === 'string') {
      const name = toNonEmptyString(column);
      if (!name) {
        return;
      }
      pushUniqueAxisItem(columns, seenTokens, name, name);
      return;
    }

    if (isPlainObject(column)) {
      const id = toNonEmptyString(column.id, `column-${index + 1}`);
      const title = toNonEmptyString(column.title, id);
      pushUniqueAxisItem(columns, seenTokens, id, title);
    }
  });

  return columns;
}

function normalizeExplicitComparisonRows(spec) {
  const source = Array.isArray(spec.groups)
    ? spec.groups
    : (Array.isArray(spec.rows) ? spec.rows : []);

  const rows = [];
  const seenTokens = new Set();

  source.forEach((group, index) => {
    if (typeof group === 'string') {
      const name = toNonEmptyString(group);
      if (!name) {
        return;
      }
      pushUniqueAxisItem(rows, seenTokens, name, name);
      return;
    }

    if (isPlainObject(group)) {
      const id = toNonEmptyString(group.id, `group-${index + 1}`);
      const title = toNonEmptyString(group.title, id);
      pushUniqueAxisItem(rows, seenTokens, id, title);
    }
  });

  return rows;
}

function normalizeComparisonColumns(spec, cells, { preferred = [] } = {}) {
  const columns = normalizeExplicitComparisonColumns(spec);
  const seenTokens = new Set();

  columns.forEach((column) => {
    const idToken = normalizeComparisonToken(column.id);
    const titleToken = normalizeComparisonToken(column.title);
    if (idToken) {
      seenTokens.add(idToken);
    }
    if (titleToken) {
      seenTokens.add(titleToken);
    }
  });

  preferred.forEach((column, index) => {
    if (typeof column === 'string') {
      pushUniqueAxisItem(columns, seenTokens, column, column);
      return;
    }

    if (isPlainObject(column)) {
      const id = toNonEmptyString(column.id, `column-pref-${index + 1}`);
      const title = toNonEmptyString(column.title || column.label, id);
      pushUniqueAxisItem(columns, seenTokens, id, title);
    }
  });

  cells.forEach((cell) => {
    pushUniqueAxisItem(columns, seenTokens, cell.column, cell.column);
  });

  return columns;
}

function normalizeComparisonGroups(spec, cells, { preferred = [] } = {}) {
  const groups = normalizeExplicitComparisonRows(spec);
  const seenTokens = new Set();

  groups.forEach((group) => {
    const idToken = normalizeComparisonToken(group.id);
    const titleToken = normalizeComparisonToken(group.title);
    if (idToken) {
      seenTokens.add(idToken);
    }
    if (titleToken) {
      seenTokens.add(titleToken);
    }
  });

  preferred.forEach((group, index) => {
    if (typeof group === 'string') {
      pushUniqueAxisItem(groups, seenTokens, group, group);
      return;
    }

    if (isPlainObject(group)) {
      const id = toNonEmptyString(group.id, `row-pref-${index + 1}`);
      const title = toNonEmptyString(group.title || group.label, id);
      pushUniqueAxisItem(groups, seenTokens, id, title);
    }
  });

  cells.forEach((cell) => {
    pushUniqueAxisItem(groups, seenTokens, cell.row, cell.row);
  });

  return groups;
}

function normalizeComparisonCellsFromCollection(source, {
  allowRowAlias = true,
  labelPrefix = 'Cell'
} = {}) {
  if (!Array.isArray(source)) {
    return [];
  }

  return source
    .map((cell, index) => {
      if (!isPlainObject(cell)) {
        return null;
      }

      const row = allowRowAlias
        ? toNonEmptyString(cell.row || cell.group)
        : toNonEmptyString(cell.row);
      const column = toNonEmptyString(cell.column || cell.col);
      if (!row || !column) {
        return null;
      }

      const label = toNonEmptyString(cell.label, `${labelPrefix} ${index + 1}`);
      const body = toNonEmptyString(cell.body || cell.description || cell.note);

      return {
        row,
        column,
        label,
        body,
        _order: index
      };
    })
    .filter(Boolean);
}

function buildAxisTokenMap(axisItems) {
  const tokenMap = new Map();
  axisItems.forEach((axisItem) => {
    const idToken = normalizeComparisonToken(axisItem?.id);
    const titleToken = normalizeComparisonToken(axisItem?.title);
    if (idToken && !tokenMap.has(idToken)) {
      tokenMap.set(idToken, axisItem.id);
    }
    if (titleToken && !tokenMap.has(titleToken)) {
      tokenMap.set(titleToken, axisItem.id);
    }
  });
  return tokenMap;
}

function remapComparisonCellsToAxis(cells, { groups, columns }) {
  const rowMap = buildAxisTokenMap(groups);
  const columnMap = buildAxisTokenMap(columns);

  return cells.map((cell) => {
    const rowToken = normalizeComparisonToken(cell.row);
    const columnToken = normalizeComparisonToken(cell.column);
    return {
      ...cell,
      row: rowMap.get(rowToken) || cell.row,
      column: columnMap.get(columnToken) || cell.column
    };
  });
}

function dedupeComparisonCells(cells) {
  const byKey = new Map();
  cells.forEach((cell) => {
    const rowToken = normalizeComparisonToken(cell.row);
    const columnToken = normalizeComparisonToken(cell.column);
    if (!rowToken || !columnToken) {
      return;
    }

    const key = `${rowToken}::${columnToken}`;
    if (!byKey.has(key)) {
      byKey.set(key, cell);
      return;
    }

    const previous = byKey.get(key);
    if (!previous.body && cell.body) {
      byKey.set(key, cell);
    }
  });

  return [...byKey.values()].sort((left, right) => (left._order || 0) - (right._order || 0));
}

function normalizeComparisonGraphNodes(spec) {
  const rawNodes = Array.isArray(spec.nodes) ? spec.nodes : [];
  if (rawNodes.length === 0) {
    throw new Error('comparisonGrid graph mode requires nodes[].');
  }

  const idSet = new Set();
  const nodes = rawNodes
    .map((rawNode, index) => {
      if (!isPlainObject(rawNode)) {
        return null;
      }

      const baseId = toNonEmptyString(rawNode.id, `node-${index + 1}`);
      let id = baseId;
      let suffix = 2;
      while (idSet.has(id)) {
        id = `${baseId}-${suffix}`;
        suffix += 1;
      }
      idSet.add(id);

      return {
        id,
        label: toNonEmptyString(rawNode.label, id),
        row: toNonEmptyString(rawNode.row),
        group: toNonEmptyString(rawNode.group),
        column: toNonEmptyString(rawNode.column || rawNode.col),
        note: toNonEmptyString(rawNode.note || rawNode.body || rawNode.description),
        _order: index
      };
    })
    .filter(Boolean);

  return {
    nodes,
    nodeById: new Map(nodes.map((node) => [node.id, node]))
  };
}

function normalizeComparisonGraphEdges(rawEdges, nodeById) {
  if (!Array.isArray(rawEdges)) {
    return [];
  }

  return rawEdges
    .map((edge, index) => {
      if (!isPlainObject(edge)) {
        return null;
      }

      const from = toNonEmptyString(edge.from);
      const to = toNonEmptyString(edge.to);
      if (!from || !to || !nodeById.has(from) || !nodeById.has(to)) {
        return null;
      }

      return {
        from,
        to,
        _order: index
      };
    })
    .filter(Boolean);
}

function resolveGraphCellColumnLabel(cellNode, columnHeaders) {
  const rawValue = toNonEmptyString(cellNode.column || cellNode.group);
  if (!rawValue) {
    return '';
  }

  const rawToken = normalizeComparisonToken(rawValue);
  for (const header of columnHeaders) {
    if (normalizeComparisonToken(header.id) === rawToken || normalizeComparisonToken(header.label) === rawToken) {
      return header.label;
    }
  }

  return rawValue;
}

function normalizeComparisonCellsFromGraph(spec) {
  const { nodes, nodeById } = normalizeComparisonGraphNodes(spec);
  const edges = normalizeComparisonGraphEdges(spec.edges, nodeById);

  const hasLegacyCellNodes = normalizeComparisonCellsFromCollection(nodes, {
    allowRowAlias: true,
    labelPrefix: 'Cell'
  }).length > 0;

  const rowHeaderIds = new Set();
  nodes.forEach((node) => {
    if (node.id.toLowerCase().startsWith('row-')) {
      rowHeaderIds.add(node.id);
    }
  });

  edges.forEach((edge) => {
    const sourceNode = nodeById.get(edge.from);
    if (!sourceNode) {
      return;
    }
    if (!sourceNode.group && !sourceNode.column) {
      rowHeaderIds.add(sourceNode.id);
    }
  });

  const rowHeaders = nodes
    .filter((node) => rowHeaderIds.has(node.id))
    .sort((left, right) => left._order - right._order)
    .map((node) => ({
      id: node.id,
      label: node.label
    }));

  if (rowHeaders.length === 0) {
    if (edges.length === 0 && hasLegacyCellNodes) {
      return {
        mode: 'legacy-nodes',
        rowHeaders: [],
        columnHeaders: [],
        cells: normalizeComparisonCellsFromCollection(nodes, {
          allowRowAlias: true,
          labelPrefix: 'Cell'
        })
      };
    }
    throw new Error('comparisonGrid graph mode needs at least one row header node (for example ids starting with "row-").');
  }

  const rowEdgeTargets = new Set();
  edges.forEach((edge) => {
    if (rowHeaderIds.has(edge.from)) {
      rowEdgeTargets.add(edge.to);
    }
  });

  const columnHeaders = nodes
    .filter((node) => {
      const isCellNode = Boolean(node.group || node.column);
      if (isCellNode) {
        return false;
      }

      if (node.id.toLowerCase().startsWith('col-')) {
        return true;
      }

      if (rowHeaderIds.has(node.id)) {
        return false;
      }

      if (rowEdgeTargets.has(node.id)) {
        return false;
      }

      return Boolean(node.label);
    })
    .sort((left, right) => left._order - right._order)
    .map((node) => ({
      id: node.id,
      label: node.label
    }));

  const cellNodes = nodes.filter((node) => Boolean(node.group || node.column));
  const cellNodeById = new Map(cellNodes.map((node) => [node.id, node]));

  const inferredColumnLabels = new Set();
  columnHeaders.forEach((header) => {
    const label = toNonEmptyString(header.label);
    if (label) {
      inferredColumnLabels.add(label);
    }
  });
  cellNodes.forEach((node) => {
    const label = resolveGraphCellColumnLabel(node, columnHeaders);
    if (label) {
      inferredColumnLabels.add(label);
    }
  });

  if (columnHeaders.length === 0 && inferredColumnLabels.size === 0) {
    throw new Error('comparisonGrid graph mode needs at least one column header or cell group/column label.');
  }

  const rowHeaderById = new Map(rowHeaders.map((rowHeader) => [rowHeader.id, rowHeader]));
  const edgeCells = edges
    .map((edge) => {
      const rowHeader = rowHeaderById.get(edge.from);
      const cellNode = cellNodeById.get(edge.to);
      if (!rowHeader || !cellNode) {
        return null;
      }

      const columnLabel = resolveGraphCellColumnLabel(cellNode, columnHeaders);
      if (!columnLabel) {
        return null;
      }

      return {
        row: rowHeader.label,
        column: columnLabel,
        label: toNonEmptyString(cellNode.label, `Cell ${edge._order + 1}`),
        body: toNonEmptyString(cellNode.note),
        _order: edge._order
      };
    })
    .filter(Boolean);

  if (edges.length > 0 && edgeCells.length === 0) {
    throw new Error('comparisonGrid graph mode could not map any row-to-cell edges.');
  }

  let cells = edgeCells;
  if (edges.length === 0) {
    cells = cellNodes
      .map((cellNode, index) => {
        const columnLabel = resolveGraphCellColumnLabel(cellNode, columnHeaders);
        if (!columnLabel) {
          return null;
        }

        const rowHeader = rowHeaders[index % rowHeaders.length];
        return {
          row: rowHeader.label,
          column: columnLabel,
          label: toNonEmptyString(cellNode.label, `Cell ${index + 1}`),
          body: toNonEmptyString(cellNode.note),
          _order: index
        };
      })
      .filter(Boolean);
  }

  if (cells.length === 0) {
    throw new Error('comparisonGrid graph mode did not produce any cells to render.');
  }

  return {
    mode: 'graph',
    rowHeaders,
    columnHeaders,
    cells
  };
}

function normalizeComparisonGridData(spec) {
  const hasCellsArray = Array.isArray(spec.cells) && spec.cells.length > 0;
  if (hasCellsArray) {
    const cells = normalizeComparisonCellsFromCollection(spec.cells, {
      allowRowAlias: true,
      labelPrefix: 'Cell'
    });
    if (cells.length === 0) {
      throw new Error('comparisonGrid cells[] entries must include row/group, column, and label.');
    }

    const columns = normalizeComparisonColumns(spec, cells);
    const groups = normalizeComparisonGroups(spec, cells);
    if (columns.length === 0 || groups.length === 0) {
      throw new Error('comparisonGrid requires at least one row group and one column.');
    }

    const remapped = dedupeComparisonCells(remapComparisonCellsToAxis(cells, { groups, columns }));
    return {
      mode: 'cells',
      columns,
      groups,
      cells: remapped
    };
  }

  if (Array.isArray(spec.nodes) && spec.nodes.length > 0) {
    const graphData = normalizeComparisonCellsFromGraph(spec);
    const preferredColumns = graphData.columnHeaders.map((header) => ({
      id: header.label,
      title: header.label
    }));
    const preferredRows = graphData.rowHeaders.map((rowHeader) => ({
      id: rowHeader.label,
      title: rowHeader.label
    }));

    const columns = normalizeComparisonColumns(spec, graphData.cells, { preferred: preferredColumns });
    const groups = normalizeComparisonGroups(spec, graphData.cells, { preferred: preferredRows });
    if (columns.length === 0 || groups.length === 0) {
      throw new Error('comparisonGrid requires at least one row group and one column.');
    }

    const remapped = dedupeComparisonCells(remapComparisonCellsToAxis(graphData.cells, { groups, columns }));
    if (remapped.length === 0) {
      throw new Error('comparisonGrid did not produce any cells after normalization.');
    }

    return {
      mode: graphData.mode,
      columns,
      groups,
      cells: remapped
    };
  }

  throw new Error('comparisonGrid requires cells[] or nodes[] with mappable row/column data.');
}

function renderComparisonGrid(spec) {
  const normalized = normalizeComparisonGridData(spec);
  const {
    cells,
    columns,
    groups
  } = normalized;

  const cellByKey = new Map();
  cells.forEach((cell) => {
    const rowToken = normalizeComparisonToken(cell.row);
    const columnToken = normalizeComparisonToken(cell.column);
    if (!rowToken || !columnToken) {
      return;
    }
    cellByKey.set(`${rowToken}::${columnToken}`, cell);
  });

  const layout = isPlainObject(spec.layout) ? spec.layout : {};
  const paddingX = toFiniteNumber(layout.paddingX, 20, { min: 6, max: 220 });
  const paddingY = toFiniteNumber(layout.paddingY, 20, { min: 6, max: 220 });
  const gapX = toFiniteNumber(layout.gapX, 8, { min: 0, max: 120 });
  const gapY = toFiniteNumber(layout.gapY, 8, { min: 0, max: 120 });
  const cellWidth = toFiniteNumber(
    layout.cellWidth,
    toFiniteNumber(layout.nodeWidth, 200, { min: 110, max: 460 }),
    { min: 110, max: 460 }
  );
  const cellHeight = toFiniteNumber(
    layout.cellHeight,
    toFiniteNumber(layout.nodeHeight, 110, { min: 68, max: 360 }),
    { min: 68, max: 360 }
  );
  const rowHeaderWidth = toFiniteNumber(layout.rowHeaderWidth, Math.max(140, cellWidth * 0.85), { min: 100, max: 500 });
  const headerHeight = toFiniteNumber(layout.headerHeight, Math.max(44, Math.round(cellHeight * 0.42)), { min: 24, max: 240 });
  const theme = normalizeTheme(spec.theme);

  const width = paddingX * 2 + rowHeaderWidth + (columns.length * cellWidth) + Math.max(0, columns.length - 1) * gapX;
  const height = paddingY * 2 + headerHeight + (groups.length * cellHeight) + Math.max(0, groups.length - 1) * gapY;

  const svg = createRootSvg({
    width,
    height,
    theme,
    title: toNonEmptyString(spec.title, 'Comparison grid diagram')
  });

  const gridLayer = createSvgElement('g', { class: 'edu-grid' });
  svg.appendChild(gridLayer);

  gridLayer.appendChild(createSvgElement('rect', {
    x: paddingX,
    y: paddingY,
    width: rowHeaderWidth,
    height: headerHeight,
    class: 'edu-grid-header'
  }));

  columns.forEach((column, columnIndex) => {
    const x = paddingX + rowHeaderWidth + columnIndex * (cellWidth + gapX);

    gridLayer.appendChild(createSvgElement('rect', {
      x,
      y: paddingY,
      width: cellWidth,
      height: headerHeight,
      class: 'edu-grid-header'
    }));

    appendMultilineText(gridLayer, {
      text: column.title,
      x: x + cellWidth / 2,
      y: paddingY + headerHeight / 2,
      className: 'edu-grid-header-label',
      maxChars: Math.max(8, Math.round(cellWidth / 9)),
      maxLines: 2,
      lineHeight: 14
    });
  });

  groups.forEach((group, groupIndex) => {
    const y = paddingY + headerHeight + groupIndex * (cellHeight + gapY);

    gridLayer.appendChild(createSvgElement('rect', {
      x: paddingX,
      y,
      width: rowHeaderWidth,
      height: cellHeight,
      class: 'edu-grid-row-header'
    }));

    appendMultilineText(gridLayer, {
      text: group.title,
      x: paddingX + rowHeaderWidth / 2,
      y: y + cellHeight / 2,
      className: 'edu-grid-row-label',
      maxChars: Math.max(8, Math.round(rowHeaderWidth / 9)),
      maxLines: 3,
      lineHeight: 14
    });

    columns.forEach((column, columnIndex) => {
      const cellX = paddingX + rowHeaderWidth + columnIndex * (cellWidth + gapX);
      const key = `${normalizeComparisonToken(group.id)}::${normalizeComparisonToken(column.id)}`;
      const cell = cellByKey.get(key);

      gridLayer.appendChild(createSvgElement('rect', {
        x: cellX,
        y,
        width: cellWidth,
        height: cellHeight,
        class: 'edu-grid-cell'
      }));

      if (!cell) {
        const empty = createSvgElement('text', {
          x: cellX + cellWidth / 2,
          y: y + cellHeight / 2,
          class: 'edu-grid-empty',
          'text-anchor': 'middle',
          'dominant-baseline': 'middle'
        });
        empty.textContent = '-';
        gridLayer.appendChild(empty);
        return;
      }

      const titleY = y + 22;
      appendMultilineText(gridLayer, {
        text: cell.label,
        x: cellX + cellWidth / 2,
        y: titleY,
        className: 'edu-grid-cell-title',
        maxChars: Math.max(8, Math.round(cellWidth / 9)),
        maxLines: 2,
        lineHeight: 14
      });

      if (cell.body) {
        appendMultilineText(gridLayer, {
          text: cell.body,
          x: cellX + cellWidth / 2,
          y: y + cellHeight / 2 + 14,
          className: 'edu-grid-cell-body',
          maxChars: Math.max(8, Math.round(cellWidth / 9)),
          maxLines: 4,
          lineHeight: 13
        });
      }
    });
  });

  return svg;
}

export function debugNormalizeComparisonGrid(svgSpec) {
  if (!isPlainObject(svgSpec) || toNonEmptyString(svgSpec.kind) !== 'comparisonGrid') {
    throw new Error('debugNormalizeComparisonGrid expects svgSpec.kind = "comparisonGrid".');
  }

  const normalized = normalizeComparisonGridData(svgSpec);
  return {
    mode: normalized.mode,
    columns: normalized.columns.map((column) => ({ ...column })),
    groups: normalized.groups.map((group) => ({ ...group })),
    cells: normalized.cells.map((cell) => ({
      row: cell.row,
      column: cell.column,
      label: cell.label,
      body: cell.body
    }))
  };
}

export function renderSvgDiagram(svgSpec) {
  if (!isPlainObject(svgSpec)) {
    throw new Error('svgSpec must be an object.');
  }

  const kind = toNonEmptyString(svgSpec.kind);
  if (!SUPPORTED_KINDS.has(kind)) {
    throw new Error(`svgSpec.kind must be one of: ${[...SUPPORTED_KINDS].join(', ')}.`);
  }

  switch (kind) {
    case 'flowchart':
      return renderLayeredGraph(svgSpec, 'flowchart');
    case 'decisionTree':
      return renderLayeredGraph(svgSpec, 'decisionTree');
    case 'timeline':
      return renderTimeline(svgSpec);
    case 'processMap':
      return renderProcessMap(svgSpec);
    case 'comparisonGrid':
      return renderComparisonGrid(svgSpec);
    default:
      throw new Error(`Unsupported svgSpec.kind: ${kind}`);
  }
}

export function serializeSvg(svgElement) {
  if (!(svgElement instanceof SVGElement)) {
    throw new Error('Expected an SVGElement.');
  }

  const clone = svgElement.cloneNode(true);
  if (!clone.getAttribute('xmlns')) {
    clone.setAttribute('xmlns', SVG_NS);
  }

  return new XMLSerializer().serializeToString(clone);
}
