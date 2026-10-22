/**
 * In-plot tags for the dual-axis asset trend.
 *
 * Left axis = 交易所余额 (cex), right axis = 链上资金 (onchain). The tag x stays
 * near TAG_X_RATIO so the callout sits in the open left-center of the plot.
 * Its y must be that same series at that x, mapped through that series' own
 * scale. Using the latest sample instead pins the tag to the end of the axis:
 * after the lines diverge, the latest exchange balance is high on the left
 * scale while the curve under the tag is still low, and the latest on-chain
 * balance is low on the right scale while that curve is still high — the tags
 * look swapped and do not follow the lines.
 */

export const TAG_X_RATIO = 0.38;

export const SERIES_TAGS = [
  { key: "cex" as const, name: "交易所余额", color: "var(--blue)", yAxisId: "cex" as const },
  { key: "onchain" as const, name: "链上资金", color: "var(--accent)", yAxisId: "onchain" as const },
];

export interface PlotBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TagBox {
  width: number;
  height: number;
}

export interface SeriesTagSpec {
  key: "cex" | "onchain";
  name: string;
  color: string;
  yAxisId: "cex" | "onchain";
  /** Series value at the tag x. This is what the vertical position must use. */
  anchorValue: number;
  /** Latest reading, shown on the tag. */
  labelValue: number;
}

/** Nearest vertex to the left-center ratio, so the tag sits on the line itself. */
export function anchorIndex(length: number, ratio = TAG_X_RATIO): number {
  if (length <= 1) return 0;
  const pos = (length - 1) * Math.min(1, Math.max(0, ratio));
  return Math.min(length - 1, Math.max(0, Math.round(pos)));
}

export function paddedDomain(values: number[]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  const pad = Math.max((max - min) * 0.12, 0.5);
  return [min - pad, max + pad];
}

/** Pixel y inside a plot, 0 at the top of the series domain. */
export function valueToY(value: number, domain: [number, number], plotTop: number, plotHeight: number) {
  const [min, max] = domain;
  const span = max - min;
  const t = span === 0 ? 0.5 : (value - min) / span;
  const clamped = Math.min(1, Math.max(0, t));
  return plotTop + plotHeight * (1 - clamped);
}

export function buildSeriesTags(
  data: Array<{ cex: number; onchain: number }>,
  ratio = TAG_X_RATIO,
): { index: number; tags: SeriesTagSpec[] } {
  const index = anchorIndex(data.length, ratio);
  const anchor = data[index];
  const latest = data[data.length - 1] ?? anchor;
  const tags = SERIES_TAGS.map((series) => ({
    ...series,
    anchorValue: anchor?.[series.key] ?? 0,
    labelValue: latest?.[series.key] ?? 0,
  }));
  return { index, tags };
}

function textWidth(text: string) {
  let width = 0;
  for (const ch of text) width += ch.charCodeAt(0) > 255 ? 12.5 : 7.15;
  return width;
}

export function tagBoxSize(name: string, valueLabel: string): TagBox {
  return {
    width: Math.ceil(Math.max(textWidth(name), textWidth(valueLabel)) + 22),
    height: 42,
  };
}

export function sharedTagBox(labels: Array<{ name: string; valueLabel: string }>): TagBox {
  const boxes = labels.map((label) => tagBoxSize(label.name, label.valueLabel));
  return {
    width: Math.max(120, ...boxes.map((box) => box.width)),
    height: 42,
  };
}

export interface SeriesAnchor {
  key: "cex" | "onchain";
  name: string;
  color: string;
  anchorX: number;
  anchorY: number;
  labelValue: number;
  anchorValue: number;
}

export interface PlacedTag extends SeriesAnchor {
  left: number;
  top: number;
}

function clamp(value: number, min: number, max: number) {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Center each tag on its own anchor. Tags stay inside the plot, and when the
 * series meet they separate vertically without crossing (the higher anchor
 * stays above).
 */
export function placeSeriesTags(tags: SeriesAnchor[], plot: PlotBox, box: TagBox): PlacedTag[] {
  const minLeft = plot.left;
  const maxLeft = Math.max(plot.left, plot.left + plot.width - box.width);
  const minTop = plot.top;
  const maxTop = Math.max(plot.top, plot.top + plot.height - box.height);
  const placed: PlacedTag[] = tags.map((tag) => ({
    ...tag,
    left: clamp(tag.anchorX - box.width / 2, minLeft, maxLeft),
    top: clamp(tag.anchorY - box.height / 2, minTop, maxTop),
  }));

  if (placed.length >= 2) {
    const gap = 6;
    const ordered = [...placed].sort((a, b) => a.anchorY - b.anchorY || a.anchorX - b.anchorX);
    for (let i = 1; i < ordered.length; i += 1) {
      const prev = ordered[i - 1];
      const current = ordered[i];
      const horizontallyStacked = prev.left < current.left + box.width && current.left < prev.left + box.width;
      if (!horizontallyStacked) continue;
      if (prev.top + box.height + gap <= current.top) continue;
      const overlap = prev.top + box.height + gap - current.top;
      prev.top = clamp(prev.top - overlap / 2, minTop, maxTop);
      current.top = clamp(current.top + overlap / 2, minTop, maxTop);
      if (prev.top + box.height + gap > current.top) {
        current.top = clamp(prev.top + box.height + gap, minTop, maxTop);
      }
      if (prev.top + box.height + gap > current.top) {
        prev.top = clamp(current.top - box.height - gap, minTop, maxTop);
      }
    }
  }

  return placed;
}
