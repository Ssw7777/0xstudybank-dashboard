import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TAG_X_RATIO,
  anchorIndex,
  buildSeriesTags,
  paddedDomain,
  placeSeriesTags,
  valueToY,
} from "../src/components/chart-tags.ts";

/**
 * Shape of the reported chart: exchange balance is flat then jumps, on-chain
 * funds are flat then step down. Latest readings sit on the opposite side of
 * each axis from the curve under the left-center tag.
 */
function divergingSeries() {
  const points = [];
  for (let i = 0; i < 12; i += 1) {
    points.push({
      cex: i < 10 ? 11620 : 12541.8,
      onchain: i < 8 ? 98900 : i === 8 ? 97100 : i === 9 ? 96200 : i === 10 ? 95600 : 95077.1,
    });
  }
  return points;
}

test("anchor x stays on the vertex nearest the left-center ratio", () => {
  const index = anchorIndex(12, TAG_X_RATIO);
  assert.equal(index, Math.round(11 * TAG_X_RATIO));
  assert.equal(TAG_X_RATIO, 0.38);
  assert.ok(Math.abs(index / 11 - TAG_X_RATIO) <= 0.5 / 11);
});

test("each tag y follows its own series at the tag x, not the latest sample", () => {
  const points = divergingSeries();
  const { tags } = buildSeriesTags(points);
  const cex = tags.find((tag) => tag.key === "cex");
  const onchain = tags.find((tag) => tag.key === "onchain");
  assert.ok(cex && onchain);
  assert.equal(cex.yAxisId, "cex");
  assert.equal(onchain.yAxisId, "onchain");
  assert.equal(cex.labelValue, 12541.8);
  assert.equal(onchain.labelValue, 95077.1);
  assert.ok(Math.abs(cex.anchorValue - 11620) < 1);
  assert.ok(onchain.anchorValue > 98000);

  const plotTop = 8;
  const plotHeight = 240;
  const cexDomain = paddedDomain(points.map((point) => point.cex));
  const onchainDomain = paddedDomain(points.map((point) => point.onchain));
  const yCex = valueToY(cex.anchorValue, cexDomain, plotTop, plotHeight);
  const yOnchain = valueToY(onchain.anchorValue, onchainDomain, plotTop, plotHeight);
  const yLatestCex = valueToY(cex.labelValue, cexDomain, plotTop, plotHeight);
  const yLatestOnchain = valueToY(onchain.labelValue, onchainDomain, plotTop, plotHeight);

  assert.ok(yOnchain < yCex - 30, "on-chain curve is above the exchange curve at the tag x");
  assert.ok(yLatestCex < yLatestOnchain - 30, "latest readings are on the opposite sides");
  assert.ok(Math.abs(yCex - yLatestCex) > 30);
  assert.ok(Math.abs(yOnchain - yLatestOnchain) > 30);
});

test("each tag uses its own axis when the series have crossed", () => {
  const points = [
    { cex: 12500, onchain: 94200 },
    { cex: 11200, onchain: 99000 },
  ];
  const { tags } = buildSeriesTags(points, 0);
  const cexDomain = paddedDomain(points.map((point) => point.cex));
  const onchainDomain = paddedDomain(points.map((point) => point.onchain));
  const yCex = valueToY(tags[0].anchorValue, cexDomain, 0, 200);
  const yOnchain = valueToY(tags[1].anchorValue, onchainDomain, 0, 200);
  const cexOnOnchainScale = valueToY(tags[0].anchorValue, onchainDomain, 0, 200);
  const onchainOnCexScale = valueToY(tags[1].anchorValue, cexDomain, 0, 200);
  assert.equal(tags[0].anchorValue, 12500);
  assert.equal(tags[1].anchorValue, 94200);
  assert.ok(yCex < 40, "exchange balance near the top of the left axis stays high");
  assert.ok(yOnchain > 160, "on-chain balance near the bottom of the right axis stays low");
  assert.ok(yCex < yOnchain);
  assert.ok(cexOnOnchainScale > yOnchain - 1, "the right axis would drop the exchange tag to the bottom");
  assert.ok(onchainOnCexScale < yCex + 1, "the left axis would pin the on-chain tag to the top");
});

test("tags sit on their anchors and stay inside the plot", () => {
  const plot = { left: 64, top: 8, width: 480, height: 250 };
  const box = { width: 150, height: 42 };
  const anchorX = plot.left + plot.width * TAG_X_RATIO;
  const placed = placeSeriesTags(
    [
      { key: "cex", name: "交易所余额", color: "blue", anchorX, anchorY: 210, labelValue: 12541.8, anchorValue: 11620 },
      { key: "onchain", name: "链上资金", color: "red", anchorX, anchorY: 36, labelValue: 95077.1, anchorValue: 98900 },
    ],
    plot,
    box,
  );
  const cex = placed.find((tag) => tag.key === "cex");
  const onchain = placed.find((tag) => tag.key === "onchain");
  assert.ok(cex && onchain);
  assert.ok(Math.abs(cex.top + box.height / 2 - 210) < 1);
  assert.ok(Math.abs(onchain.top + box.height / 2 - 36) < 1);
  assert.ok(onchain.top < cex.top);
  for (const tag of placed) {
    assert.ok(tag.left >= plot.left - 0.01);
    assert.ok(tag.left + box.width <= plot.left + plot.width + 0.01);
    assert.ok(tag.top >= plot.top - 0.01);
    assert.ok(tag.top + box.height <= plot.top + plot.height + 0.01);
  }
});

test("overlapping tags separate without swapping vertical order", () => {
  const plot = { left: 0, top: 0, width: 400, height: 220 };
  const box = { width: 160, height: 42 };
  const placed = placeSeriesTags(
    [
      { key: "cex", name: "交易所余额", color: "blue", anchorX: 160, anchorY: 100, labelValue: 1, anchorValue: 1 },
      { key: "onchain", name: "链上资金", color: "red", anchorX: 160, anchorY: 112, labelValue: 2, anchorValue: 2 },
    ],
    plot,
    box,
  );
  const cex = placed.find((tag) => tag.key === "cex");
  const onchain = placed.find((tag) => tag.key === "onchain");
  assert.ok(cex && onchain);
  assert.ok(cex.top + box.height <= onchain.top);
  assert.ok(Math.abs(cex.top + box.height / 2 - 100) < Math.abs(onchain.top + box.height / 2 - 100));
});
