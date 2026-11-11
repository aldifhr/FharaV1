// Dashboard F7: the width helpers behind useResizablePanel (task thread + Inspector shell).
import test from "node:test";
import assert from "node:assert/strict";

import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_WIDE_WIDTH,
  clampPanelWidth,
  isWidePanel,
  toggledPanelWidth,
} from "../../lib/useResizablePanel.ts";

test("widths stay inside the panel limits", () => {
  assert.equal(clampPanelWidth(100), PANEL_MIN_WIDTH);
  assert.equal(clampPanelWidth(5000), PANEL_MAX_WIDTH);
  assert.equal(clampPanelWidth(500), 500);
  assert.equal(clampPanelWidth(100, 200, 300), 200);
});

test("the wide toggle flips between the default and wide presets", () => {
  assert.equal(isWidePanel(PANEL_DEFAULT_WIDTH), false);
  assert.equal(isWidePanel(PANEL_WIDE_WIDTH), true);
  assert.equal(isWidePanel(PANEL_WIDE_WIDTH - 20), true);
  assert.equal(toggledPanelWidth(PANEL_DEFAULT_WIDTH), PANEL_WIDE_WIDTH);
  assert.equal(toggledPanelWidth(PANEL_MAX_WIDTH), PANEL_DEFAULT_WIDTH);
});
