"use client";

import { useMemo, useState } from "react";
import { ComposedChart, Customized, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChangeRangeKey, ChangeSummary } from "@/lib/changes";
import { CHANGE_RANGES } from "@/lib/changes";
import type { SnapshotPoint } from "@/lib/types";
import {
  buildSeriesTags,
  paddedDomain,
  placeSeriesTags,
  sharedTagBox,
  type PlotBox,
} from "./chart-tags";
import { cny, deltaClass, signedPct, signedUsd, usd } from "./format";

function formatPointTime(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface ChartPoint {
  ts: string;
  t: string;
  v: number;
  onchain: number;
  cex: number;
  manual: number;
}

function ChartTooltip({
  active,
  payload,
  rate,
}: {
  active?: boolean;
  payload?: Array<{ payload?: ChartPoint }>;
  rate: number;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload;
  if (!point) return null;
  return (
    <div className="chart-tooltip">
      <div className="time">{formatPointTime(point.ts)}</div>
      <div className="value num">{usd(point.v)}</div>
      <div className="time num">{cny(point.v * rate)}</div>
      <div className="grid">
        <span>
          <i className="tip-dot" style={{ background: "var(--blue)" }} />
          交易所
        </span>
        <b>{usd(point.cex)}</b>
        <span>
          <i className="tip-dot" style={{ background: "var(--accent)" }} />
          链上
        </span>
        <b>{usd(point.onchain)}</b>
        <span>
          <i className="tip-dot" style={{ background: "var(--ink-2)" }} />
          手动
        </span>
        <b>{usd(point.manual)}</b>
      </div>
    </div>
  );
}

/** Y 轴刻度：窄区间也能看出差异（79.0K / 79.1K），不再是清一色的 79K。 */
function formatAxisTick(value: number) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(value / 1000).toFixed(abs < 1_000_000 ? 1 : 0)}K`;
  if (abs >= 1_000) return `${(value / 1000).toFixed(2)}K`;
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

interface LineVertex {
  x?: number;
  y?: number;
  value?: number;
}

interface FormattedSeries {
  item?: { props?: { dataKey?: string } };
  props?: { points?: LineVertex[] };
}

function plotBoxOf(offset?: { top?: number; left?: number; width?: number; height?: number }): PlotBox | null {
  if (!offset) return null;
  const left = offset.left ?? 0;
  const top = offset.top ?? 0;
  const width = offset.width ?? 0;
  const height = offset.height ?? 0;
  if (width < 40 || height < 40) return null;
  return { left, top, width, height };
}

function seriesVertices(items: FormattedSeries[] | undefined, key: string) {
  const series = items?.find((entry) => entry.item?.props?.dataKey === key);
  const points = series?.props?.points;
  if (!points?.length) return null;
  return points;
}

function SeriesTags(props: {
  offset?: { top?: number; left?: number; width?: number; height?: number };
  formattedGraphicalItems?: FormattedSeries[];
}) {
  const plot = plotBoxOf(props.offset);
  const cex = seriesVertices(props.formattedGraphicalItems, "cex");
  const onchain = seriesVertices(props.formattedGraphicalItems, "onchain");
  if (!plot || !cex || !onchain) return null;

  const length = Math.min(cex.length, onchain.length);
  const { index, tags: specs } = buildSeriesTags(
    Array.from({ length }, (_, i) => ({
      cex: cex[i]?.value ?? 0,
      onchain: onchain[i]?.value ?? 0,
    })),
  );
  const anchorX = cex[index]?.x;
  const anchorY = {
    cex: cex[index]?.y,
    onchain: onchain[index]?.y,
  };
  if (anchorX == null || anchorY.cex == null || anchorY.onchain == null) return null;
  // y comes from that series' own drawn vertex, not from the other axis or the latest sample.
  const tags = specs.map((series) => ({
    key: series.key,
    name: series.name,
    color: series.color,
    anchorX,
    anchorY: anchorY[series.key] as number,
    anchorValue: series.anchorValue,
    labelValue: series.labelValue,
  }));
  const box = sharedTagBox(tags.map((tag) => ({ name: tag.name, valueLabel: usd(tag.labelValue) })));
  const placed = placeSeriesTags(tags, plot, box);

  return (
    <g className="series-tags" pointerEvents="none">
      {placed.map((tag) => (
        <g key={tag.key} data-series={tag.key} data-anchor={tag.anchorValue}>
          <rect
            x={tag.left}
            y={tag.top}
            width={box.width}
            height={box.height}
            rx={6}
            fill="rgba(255,255,255,0.94)"
            stroke="var(--line)"
          />
          <text
            x={tag.left + box.width / 2}
            y={tag.top + 17}
            textAnchor="middle"
            fill={tag.color}
            fontSize={12}
            fontWeight={600}
          >
            {tag.name}
          </text>
          <text
            className="num"
            x={tag.left + box.width / 2}
            y={tag.top + 33}
            textAnchor="middle"
            fill={tag.color}
            fontSize={12}
            fontWeight={500}
          >
            {usd(tag.labelValue)}
          </text>
        </g>
      ))}
    </g>
  );
}

/** 资产趋势：交易所余额走左轴，链上资金走右轴，图内标注跟各自的线。 */
export function PortfolioChart({
  snapshots,
  usdCnyRate = 6.66,
  range,
  summary,
  onRangeChange,
}: {
  snapshots: SnapshotPoint[];
  usdCnyRate?: number;
  range: ChangeRangeKey;
  summary?: ChangeSummary | null;
  onRangeChange: (range: ChangeRangeKey) => void;
}) {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const rate = usdCnyRate || 6.66;
  const activeRange = CHANGE_RANGES.find((item) => item.key === range) ?? CHANGE_RANGES[2];

  const data = useMemo<ChartPoint[]>(() => {
    const cutoff = Date.now() - activeRange.ms;
    const inWindow = snapshots.filter((point) => new Date(point.ts).getTime() >= cutoff - 60_000);
    const source = inWindow.length >= 2 ? inWindow : snapshots.slice(-2);
    return source.map((point) => ({
      ts: point.ts,
      t: formatPointTime(point.ts),
      v: point.totalUsd,
      onchain: point.onchain ?? 0,
      cex: point.cex ?? 0,
      manual: point.manual ?? 0,
    }));
  }, [snapshots, activeRange.ms]);

  const cexDomain = useMemo(() => paddedDomain(data.map((point) => point.cex)), [data]);
  const onchainDomain = useMemo(() => paddedDomain(data.map((point) => point.onchain)), [data]);

  const total = summary?.total ?? null;
  const lastPoint = data.length ? data[data.length - 1] : null;
  void activeIdx;

  const tickFor = (domain: [number, number]) => (value: number) =>
    domain[1] - domain[0] < 1000
      ? Number(value).toLocaleString("en-US", { maximumFractionDigits: domain[1] - domain[0] < 10 ? 2 : 0 })
      : formatAxisTick(Number(value));

  return (
    <section className="section" id="trend">
      <div className="section-head">
        <div className="section-title">
          <h2>资产趋势</h2>
          <span className="hint">
            全部资产 · 快照 {summary?.snapshotCount ?? snapshots.length} 条
          </span>
        </div>
        <span className="seg">
          {CHANGE_RANGES.map((item) => (
            <button
              key={item.key}
              type="button"
              className={range === item.key ? "active" : ""}
              onClick={() => {
                onRangeChange(item.key);
                setActiveIdx(null);
              }}
            >
              {item.short}
            </button>
          ))}
        </span>
      </div>

      <div className="chart-head">
        {total ? (
          <div className="chart-delta num">
            <strong className={deltaClass(total.change)}>{signedUsd(total.change)}</strong>
            <span className={deltaClass(total.change)}>{signedPct(total.pct)}</span>
            <span className="muted">
              过去 {activeRange.label}
              {summary && summary.upCount + summary.downCount > 0
                ? ` · ${summary.upCount} 个上涨 · ${summary.downCount} 个下降`
                : ""}
            </span>
          </div>
        ) : (
          <div className="muted">{summary?.reason || `数据不足以计算${activeRange.label}变化`}</div>
        )}
        {lastPoint && (
          <div className="muted num">
            最新快照 {formatPointTime(lastPoint.ts)} · {usd(lastPoint.v)}
          </div>
        )}
      </div>

      {summary && !summary.enoughData && total != null && (
        <div className="notice" style={{ marginBottom: 10 }}>
          {summary.reason}
          {summary.partial ? " · 部分数据使用上次成功记录" : ""}
        </div>
      )}

      {data.length < 2 ? (
        <div className="notice" style={{ marginBottom: 10 }}>
          暂无足够快照绘制趋势（当前 {snapshots.length} 条）。每分钟 CEX 刷新会写入总资产快照，稍候再看。
        </div>
      ) : null}
      <div className="chart-canvas" aria-label="资产趋势图">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            onMouseMove={(state) => {
              if (state && state.activeTooltipIndex != null) {
                setActiveIdx(Number(state.activeTooltipIndex));
              }
            }}
            onMouseLeave={() => setActiveIdx(null)}
          >
            <XAxis
              dataKey="t"
              tick={{ fontSize: 12, fill: "var(--ink-3)" }}
              axisLine={false}
              tickLine={false}
              minTickGap={48}
            />
            <YAxis
              yAxisId="cex"
              domain={cexDomain}
              allowDataOverflow
              tick={{ fontSize: 12, fill: "var(--blue)" }}
              axisLine={false}
              tickLine={false}
              width={64}
              tickCount={5}
              tickFormatter={tickFor(cexDomain)}
            />
            <YAxis
              yAxisId="onchain"
              orientation="right"
              domain={onchainDomain}
              allowDataOverflow
              tick={{ fontSize: 12, fill: "var(--accent)" }}
              axisLine={false}
              tickLine={false}
              width={58}
              tickCount={5}
              tickFormatter={tickFor(onchainDomain)}
            />
            <Tooltip
              content={<ChartTooltip rate={rate} />}
              cursor={{ stroke: "var(--line)", strokeWidth: 1 }}
              isAnimationActive={false}
              allowEscapeViewBox={{ x: false, y: true }}
            />
            <Line
              yAxisId="onchain"
              type="monotone"
              dataKey="onchain"
              stroke="var(--accent)"
              strokeWidth={2.25}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={false}
              activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2, fill: "var(--accent)" }}
              isAnimationActive={false}
            />
            <Line
              yAxisId="cex"
              type="monotone"
              dataKey="cex"
              stroke="var(--blue)"
              strokeWidth={2.25}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={false}
              activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2, fill: "var(--blue)" }}
              isAnimationActive={false}
            />
            <Customized component={SeriesTags} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
