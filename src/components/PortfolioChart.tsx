"use client";

import { useMemo, useState } from "react";
import { Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChangeRangeKey, ChangeSummary } from "@/lib/changes";
import { CHANGE_RANGES } from "@/lib/changes";
import type { SnapshotPoint } from "@/lib/types";
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
          链上
        </span>
        <b>{usd(point.onchain)}</b>
        <span>
          <i className="tip-dot" style={{ background: "var(--ink-2)" }} />
          交易所
        </span>
        <b>{usd(point.cex)}</b>
        <span>
          <i className="tip-dot" style={{ background: "var(--accent)" }} />
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

/** 资产趋势：DeBank 那种细面积图，右侧是 1 小时 / 12 小时 / 24 小时 / 7 天切换。 */
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

  const yDomain = useMemo((): [number, number] => {
    if (!data.length) return [0, 1];
    const values = data.map((point) => point.v);
    const min = Math.min(...values);
    const max = Math.max(...values);
    // 紧贴曲线实际波动区间：只留 8% 呼吸空间，波动一眼可见
    const pad = Math.max((max - min) * 0.12, 0.5);
    return [min - pad, max + pad];
  }, [data]);

  const total = summary?.total ?? null;
  const lastPoint = data.length ? data[data.length - 1] : null;
  void activeIdx;

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
            margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
            onMouseMove={(state) => {
              if (state && state.activeTooltipIndex != null) {
                setActiveIdx(Number(state.activeTooltipIndex));
              }
            }}
            onMouseLeave={() => setActiveIdx(null)}
          >
            <defs>
              <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.22} />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="t"
              tick={{ fontSize: 12, fill: "var(--ink-3)" }}
              axisLine={false}
              tickLine={false}
              minTickGap={48}
            />
            <YAxis
              domain={yDomain}
              tick={{ fontSize: 12, fill: "var(--ink-3)" }}
              axisLine={false}
              tickLine={false}
              width={70}
              tickCount={5}
              tickFormatter={(value) => yDomain[1] - yDomain[0] < 1000
                ? Number(value).toLocaleString("en-US", { maximumFractionDigits: yDomain[1] - yDomain[0] < 10 ? 2 : 0 })
                : formatAxisTick(Number(value))}
            />
            <Tooltip
              content={<ChartTooltip rate={rate} />}
              cursor={{ stroke: "var(--line)", strokeWidth: 1 }}
              isAnimationActive={false}
              allowEscapeViewBox={{ x: false, y: true }}
            />
            <Area
              type="monotone"
              dataKey="v"
              stroke="none"
              fill="url(#trendFill)"
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="v"
              stroke="var(--accent)"
              strokeWidth={2.25}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={false}
              activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2, fill: "var(--accent)" }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
