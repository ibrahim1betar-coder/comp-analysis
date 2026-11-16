/* Chart.js wrapper that applies the dashboard's chart conventions:
   thin marks, hairline grid, one axis, tooltips listing every series, fixed categorical colours per competitor. */
import { compact, shortDate } from './format.js';

export const SLOTS = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'],
};
export const SEQUENTIAL = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];

export const isDark = () => document.documentElement.dataset.theme === 'dark';
export const slotColor = (slot) => SLOTS[isDark() ? 'dark' : 'light'][((slot || 1) - 1) % 8];
export const OTHER = () => (isDark() ? '#6b6a65' : '#b3b2ab');

function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return { surface: v('--surface'), grid: v('--grid'), axis: v('--axis'), muted: v('--text-muted'), text: v('--text'), secondary: v('--text-secondary'), tooltipBg: v('--tooltip-bg'), tooltipText: v('--tooltip-text') };
}

const instances = new Map();
export function destroyAll(root) {
  for (const [canvas, chart] of instances) if (!root || root.contains(canvas) || !document.contains(canvas)) { chart.destroy(); instances.delete(canvas); }
}

function baseOptions(t, { stacked = false, horizontal = false, yFormat = compact, legend = true, tooltipTitle } = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    interaction: { mode: 'index', intersect: false },
    indexAxis: horizontal ? 'y' : 'x',
    layout: { padding: { top: 8, right: 12 } },
    plugins: {
      legend: {
        display: legend,
        position: 'bottom',
        align: 'start',
        labels: { color: t.secondary, usePointStyle: true, pointStyle: 'line', boxWidth: 18, boxHeight: 2, padding: 16, font: { size: 12 } },
      },
      tooltip: {
        backgroundColor: t.tooltipBg,
        titleColor: t.tooltipText,
        bodyColor: t.tooltipText,
        padding: 10,
        cornerRadius: 6,
        boxPadding: 4,
        usePointStyle: true,
        callbacks: {
          title: (items) => (tooltipTitle ? tooltipTitle(items) : items[0]?.label),
          label: (item) => {
            const v = horizontal ? item.parsed.x : item.parsed.y;
            return ` ${v === null || v === undefined ? '—' : compact(v)}  ${item.dataset.label || ''}`;
          },
          labelPointStyle: () => ({ pointStyle: 'line', rotation: 0 }),
        },
        itemSort: (a, b) => (horizontal ? b.parsed.x - a.parsed.x : b.parsed.y - a.parsed.y),
      },
    },
    scales: {
      x: {
        stacked,
        grid: { display: horizontal, color: t.grid, drawTicks: false },
        border: { display: !horizontal, color: t.axis },
        ticks: { color: t.muted, maxRotation: 0, autoSkip: true, maxTicksLimit: horizontal ? 6 : 10, font: { size: 11 }, padding: 6, ...(horizontal ? { callback: (v) => yFormat(v) } : {}) },
      },
      y: {
        stacked,
        beginAtZero: true,
        grid: { display: !horizontal, color: t.grid, drawTicks: false },
        border: { display: horizontal, color: t.axis },
        ticks: { color: t.muted, maxTicksLimit: 6, font: { size: 11 }, padding: 6, ...(horizontal ? { autoSkip: false } : { callback: (v) => yFormat(v) }) },
      },
    },
  };
}

function render(canvas, config) {
  const existing = instances.get(canvas);
  if (existing) {
    if (existing.config.type === config.type && existing.data.datasets.length === config.data.datasets.length) {
      existing.data.labels = config.data.labels;
      config.data.datasets.forEach((ds, i) => Object.assign(existing.data.datasets[i], ds));
      existing.options = config.options;
      existing.update();
      return existing;
    }
    existing.destroy();
  }
  const chart = new window.Chart(canvas, config);
  instances.set(canvas, chart);
  return chart;
}

/** Multi-series line chart over time buckets. series: [{ name, data, color }] */
export function lineChart(canvas, { keys, bucket, series, legend }) {
  const t = tokens();
  const labels = keys.map((k) => shortDate(k, bucket));
  return render(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: series.map((s) => ({
        label: s.name,
        data: s.data,
        borderColor: s.color,
        backgroundColor: s.fill ? s.color + '1a' : 'transparent',
        fill: Boolean(s.fill),
        borderWidth: 2,
        tension: 0.25,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBorderWidth: 2,
        pointHoverBorderColor: t.surface,
        pointHoverBackgroundColor: s.color,
        borderCapStyle: 'round',
        borderJoinStyle: 'round',
        spanGaps: true,
      })),
    },
    options: baseOptions(t, { legend: legend ?? series.length > 1, tooltipTitle: (items) => (bucket === 'week' ? `Week of ${items[0]?.label}` : items[0]?.label) }),
  });
}

/** Single-hue bar chart (one series). */
export function barChart(canvas, { labels, data, color, horizontal = false, label = '', yFormat }) {
  const t = tokens();
  const opts = baseOptions(t, { horizontal, legend: false, yFormat });
  return render(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label,
        data,
        backgroundColor: color || slotColor(1),
        hoverBackgroundColor: color || slotColor(1),
        borderRadius: 4,
        borderSkipped: horizontal ? 'left' : 'bottom',
        maxBarThickness: 24,
        categoryPercentage: 0.7,
        barPercentage: 0.9,
      }],
    },
    options: opts,
  });
}

/** Stacked bars with a legend (e.g. platform × time). series: [{ name, data, color }] */
export function stackedBarChart(canvas, { keys, bucket, series }) {
  const t = tokens();
  return render(canvas, {
    type: 'bar',
    data: {
      labels: keys.map((k) => shortDate(k, bucket)),
      datasets: series.map((s) => ({
        label: s.name,
        data: s.data,
        backgroundColor: s.color,
        hoverBackgroundColor: s.color,
        borderColor: t.surface,
        borderWidth: { top: 2, bottom: 0, left: 0, right: 0 },
        borderSkipped: false,
        maxBarThickness: 24,
        categoryPercentage: 0.7,
        barPercentage: 1,
      })),
    },
    options: (() => {
      const o = baseOptions(t, { stacked: true });
      o.plugins.legend.labels = { ...o.plugins.legend.labels, pointStyle: 'rect', boxWidth: 10, boxHeight: 10 };
      o.plugins.tooltip.callbacks.labelPointStyle = () => ({ pointStyle: 'rect', rotation: 0 });
      return o;
    })(),
  });
}

/** Inline SVG sparkline (12-ish points), accent colour for the current period. */
export function sparkline(values, { width = 120, height = 32, color } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'sparkline');
  svg.setAttribute('aria-hidden', 'true');
  const vals = values.filter((v) => v !== null && v !== undefined);
  if (vals.length < 2) return svg;
  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const step = (width - 4) / (values.length - 1);
  const y = (v) => height - 3 - ((v - min) / (max - min || 1)) * (height - 6);
  const pts = values.map((v, i) => `${(2 + i * step).toFixed(1)},${y(v ?? 0).toFixed(1)}`);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', `M${pts.join(' L')}`);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', color || slotColor(1));
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  area.setAttribute('d', `M${pts[0]} L${pts.join(' L')} L${(2 + (values.length - 1) * step).toFixed(1)},${height} L2,${height} Z`);
  area.setAttribute('fill', color || slotColor(1));
  area.setAttribute('opacity', '0.1');
  svg.prepend(area);
  const last = pts[pts.length - 1].split(',');
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('cx', last[0]);
  dot.setAttribute('cy', last[1]);
  dot.setAttribute('r', '3');
  dot.setAttribute('fill', color || slotColor(1));
  dot.setAttribute('stroke', 'var(--surface)');
  dot.setAttribute('stroke-width', '2');
  svg.append(dot);
  return svg;
}

/** Sequential colour for a heat cell: value in [0, max]. */
const heatIndex = (value, max) => {
  const idx = Math.min(SEQUENTIAL.length - 1, Math.floor((value / max) * (SEQUENTIAL.length - 1)));
  return isDark() ? Math.max(3, idx) : idx;
};
export function heat(value, max) {
  if (!value || !max) return 'transparent';
  return SEQUENTIAL[heatIndex(value, max)];
}
/** Ink for a heat cell: near-black on the light steps, white on the dark steps, in both themes. */
export const heatInk = (value, max) => (!value || !max ? 'var(--text)' : heatIndex(value, max) >= 7 ? '#ffffff' : '#0b0b0b');
