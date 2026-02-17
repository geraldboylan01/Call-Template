const COLOR_PALETTE = ['#2ea3ff', '#67d7ff', '#7bffbf', '#ffd166', '#ff8fa3', '#b28dff'];
const chartRegistry = new Map();

function nextChartKey() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return `chart-${window.crypto.randomUUID()}`;
  }

  return `chart-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function hexToRgba(hex, alpha) {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) {
    return `rgba(46, 163, 255, ${alpha})`;
  }

  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function sanitizeFileToken(input, fallback) {
  const raw = String(input || fallback || '').trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9-_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function chartToCsv(chartData) {
  const datasets = Array.isArray(chartData.datasets) ? chartData.datasets : [];
  const labels = Array.isArray(chartData.labels) ? chartData.labels : [];

  const header = ['Label', ...datasets.map((dataset) => dataset.label || '')];
  const lines = [header.map(csvEscape).join(',')];

  labels.forEach((label, index) => {
    const row = [label, ...datasets.map((dataset) => clampNumber(dataset.data?.[index] ?? ''))];
    lines.push(row.map(csvEscape).join(','));
  });

  return `${lines.join('\n')}\n`;
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function buildFilename(clientName, moduleTitle, chartTitle) {
  const dateToken = new Date().toISOString().slice(0, 10);
  const clientToken = sanitizeFileToken(clientName, 'Client');
  const moduleToken = sanitizeFileToken(moduleTitle, 'Module');
  const chartToken = sanitizeFileToken(chartTitle, 'Chart');
  return `${clientToken}_${moduleToken}_${chartToken}_${dateToken}.csv`;
}

function buildDatasetStyle(dataset, index, type) {
  const paletteColor = COLOR_PALETTE[index % COLOR_PALETTE.length];
  const color = typeof dataset?.borderColor === 'string' && dataset.borderColor.trim()
    ? dataset.borderColor
    : paletteColor;
  const backgroundColor = typeof dataset?.backgroundColor === 'string' && dataset.backgroundColor.trim()
    ? dataset.backgroundColor
    : hexToRgba(color, type === 'bar' ? 0.52 : 0.24);
  const points = Array.isArray(dataset?.data) ? dataset.data.map((value) => clampNumber(value)) : [];

  if (type === 'bar') {
    return {
      label: dataset.label || `Series ${index + 1}`,
      data: points,
      backgroundColor,
      borderColor: color,
      borderWidth: 1,
      borderRadius: 6,
      maxBarThickness: 46
    };
  }

  return {
    label: dataset.label || `Series ${index + 1}`,
    data: points,
    borderColor: color,
    backgroundColor,
    borderWidth: 2,
    pointBackgroundColor: typeof dataset?.pointBackgroundColor === 'string' && dataset.pointBackgroundColor.trim()
      ? dataset.pointBackgroundColor
      : color,
    pointBorderColor: typeof dataset?.pointBorderColor === 'string' && dataset.pointBorderColor.trim()
      ? dataset.pointBorderColor
      : color,
    pointRadius: 2,
    pointHoverRadius: 4,
    tension: 0.28,
    fill: false
  };
}

function buildChartConfig(chartData) {
  const chartType = chartData.type === 'bar' ? 'bar' : 'line';
  const labels = Array.isArray(chartData.labels) ? chartData.labels.map((value) => String(value)) : [];
  const datasets = Array.isArray(chartData.datasets)
    ? chartData.datasets.map((dataset, index) => buildDatasetStyle(dataset, index, chartType))
    : [];

  return {
    type: chartType,
    data: {
      labels,
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 340,
        easing: 'easeOutCubic'
      },
      plugins: {
        legend: {
          labels: {
            color: '#eaf4ff',
            boxWidth: 14,
            boxHeight: 8,
            useBorderRadius: true,
            borderRadius: 4,
            font: {
              size: 12,
              weight: '600'
            }
          }
        },
        tooltip: {
          backgroundColor: 'rgba(6, 16, 32, 0.95)',
          borderColor: 'rgba(46, 163, 255, 0.5)',
          borderWidth: 1,
          titleColor: '#ffffff',
          bodyColor: '#d9ebff'
        }
      },
      scales: {
        x: {
          ticks: {
            color: '#d3e8ff',
            maxRotation: 0
          },
          grid: {
            color: 'rgba(140, 175, 220, 0.16)',
            drawBorder: false
          }
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: '#d3e8ff'
          },
          grid: {
            color: 'rgba(140, 175, 220, 0.16)',
            drawBorder: false
          }
        }
      }
    }
  };
}

function destroyChartByKey(chartKey) {
  const existing = chartRegistry.get(chartKey);
  if (!existing) {
    return;
  }

  existing.chart.destroy();
  chartRegistry.delete(chartKey);
}

export function cleanupDetachedCharts() {
  for (const [chartKey, entry] of chartRegistry.entries()) {
    if (!entry.canvas || !entry.canvas.isConnected) {
      entry.chart.destroy();
      chartRegistry.delete(chartKey);
    }
  }
}

export function destroyAllCharts() {
  for (const [chartKey, entry] of chartRegistry.entries()) {
    entry.chart.destroy();
    chartRegistry.delete(chartKey);
  }
}

export function renderChartsForPane(paneElement, module, { clientName, moduleTitle } = {}) {
  cleanupDetachedCharts();

  if (!paneElement || !module?.generated?.charts || typeof window.Chart === 'undefined') {
    return;
  }

  const blocks = [...paneElement.querySelectorAll('[data-chart-index]')];

  blocks.forEach((block) => {
    const chartIndex = Number(block.dataset.chartIndex);
    if (!Number.isFinite(chartIndex)) {
      return;
    }

    const chartData = module.generated.charts[chartIndex];
    if (!chartData) {
      return;
    }

    const canvas = block.querySelector('canvas');
    if (!canvas) {
      return;
    }

    const existingKey = canvas.dataset.chartKey;
    if (existingKey) {
      destroyChartByKey(existingKey);
    }

    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    const chartConfig = buildChartConfig(chartData);
    const chart = new window.Chart(context, chartConfig);

    const chartKey = nextChartKey();
    canvas.dataset.chartKey = chartKey;
    chartRegistry.set(chartKey, { chart, canvas });

    const downloadButton = block.querySelector('[data-chart-download]');
    if (downloadButton) {
      downloadButton.onclick = () => {
        const csv = chartToCsv(chartData);
        const filename = buildFilename(clientName, moduleTitle, chartData.title || `Chart-${chartIndex + 1}`);
        downloadTextFile(filename, csv);
      };
    }
  });

  cleanupDetachedCharts();
}
