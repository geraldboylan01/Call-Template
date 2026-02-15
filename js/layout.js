const DEFAULT_OPTIONS = {
  outerPadding: 36,
  gap: 18,
  maxCols: 6,
  cardAspectRatio: 1.48,
  minCardWidth: 170
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getCandidateCols(moduleCount, maxCols) {
  if (moduleCount <= 0) {
    return [1];
  }

  const limitedMax = Math.min(maxCols, moduleCount);
  const ideal = Math.ceil(Math.sqrt(moduleCount));
  const candidates = new Set();

  for (let delta = -2; delta <= 2; delta += 1) {
    candidates.add(clamp(ideal + delta, 1, limitedMax));
  }

  // Add broad fallback candidates for small and dense sets.
  candidates.add(1);
  candidates.add(limitedMax);

  return [...candidates].sort((a, b) => a - b);
}

function scoreLayout(layout) {
  const balancePenalty = Math.abs(layout.cols - layout.rows) * 0.06;
  const tinyPenalty = layout.cardWidth < 170 ? 0.12 : 0;
  return layout.cardArea * layout.scale * layout.scale * (1 - balancePenalty - tinyPenalty);
}

export function computeBestOverviewLayout(moduleCount, viewportWidth, viewportHeight, options = {}) {
  const settings = { ...DEFAULT_OPTIONS, ...options };
  const safeCount = Math.max(0, moduleCount);

  if (safeCount === 0) {
    return {
      count: 0,
      cols: 1,
      rows: 1,
      gap: settings.gap,
      outerPadding: settings.outerPadding,
      cardWidth: 0,
      cardHeight: 0,
      gridWidth: 0,
      gridHeight: 0,
      scale: 1
    };
  }

  const maxCols = Math.max(1, Math.min(settings.maxCols, safeCount));
  const availWidth = Math.max(1, viewportWidth - settings.outerPadding * 2);
  const availHeight = Math.max(1, viewportHeight - settings.outerPadding * 2);

  let best = null;

  for (const cols of getCandidateCols(safeCount, maxCols)) {
    const rows = Math.ceil(safeCount / cols);
    const rawCellWidth = (availWidth - (cols - 1) * settings.gap) / cols;
    const rawCellHeight = (availHeight - (rows - 1) * settings.gap) / rows;

    if (rawCellWidth <= 0 || rawCellHeight <= 0) {
      continue;
    }

    const cardWidth = Math.max(
      1,
      Math.min(rawCellWidth, rawCellHeight * settings.cardAspectRatio)
    );
    const cardHeight = Math.max(1, cardWidth / settings.cardAspectRatio);

    const gridWidth = cols * cardWidth + (cols - 1) * settings.gap;
    const gridHeight = rows * cardHeight + (rows - 1) * settings.gap;

    const scale = Math.min(1, availWidth / gridWidth, availHeight / gridHeight);

    const layout = {
      count: safeCount,
      cols,
      rows,
      gap: settings.gap,
      outerPadding: settings.outerPadding,
      cardWidth,
      cardHeight,
      gridWidth,
      gridHeight,
      cardArea: cardWidth * cardHeight,
      scale,
      minCardWidth: settings.minCardWidth
    };

    if (!best || scoreLayout(layout) > scoreLayout(best)) {
      best = layout;
    }
  }

  return best;
}

export function computeGridPosition(index, count, cols) {
  const safeCols = Math.max(1, cols);
  const row = Math.floor(index / safeCols);
  const col = index % safeCols;
  const rows = Math.ceil(count / safeCols);

  let columnStart = col + 1;

  const itemsInLastRow = count % safeCols || safeCols;
  const isLastRow = row === rows - 1;

  if (isLastRow && itemsInLastRow < safeCols) {
    const startOffset = Math.floor((safeCols - itemsInLastRow) / 2);
    columnStart = startOffset + col + 1;
  }

  return {
    rowStart: row + 1,
    columnStart
  };
}

export function applyOverviewLayout(zoomWrapElement, gridElement, layout, viewportWidth, viewportHeight) {
  if (!layout || !zoomWrapElement || !gridElement) {
    return;
  }

  const availableWidth = Math.max(1, viewportWidth - layout.outerPadding * 2);
  const availableHeight = Math.max(1, viewportHeight - layout.outerPadding * 2);
  const scale = Math.min(1, availableWidth / layout.gridWidth, availableHeight / layout.gridHeight);

  const offsetX = (availableWidth - layout.gridWidth * scale) / 2;
  const offsetY = (availableHeight - layout.gridHeight * scale) / 2;

  gridElement.style.setProperty('--overview-cols', String(layout.cols));
  gridElement.style.setProperty('--overview-gap', `${layout.gap}px`);
  gridElement.style.setProperty('--overview-card-width', `${layout.cardWidth}px`);
  gridElement.style.setProperty('--overview-card-height', `${layout.cardHeight}px`);
  gridElement.style.width = `${layout.gridWidth}px`;
  gridElement.style.height = `${layout.gridHeight}px`;

  zoomWrapElement.style.transformOrigin = 'top left';
  zoomWrapElement.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
}
