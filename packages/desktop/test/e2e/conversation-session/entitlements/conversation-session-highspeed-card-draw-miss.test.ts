import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  countHighspeedStatusTags,
  prepareHighspeedDrawWorkspace,
  sendHighspeedTurnAndWaitCompleted,
  startHighspeedComposerProbe,
  takeHighspeedComposerProbe,
} from "#e2e/helpers/highspeed-card";

describe("Highspeed retirement E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("PCS08: 没有已有卡时，两轮正常发送且均不进入加速", async function () {
    this.timeout(240000);

    await prepareHighspeedDrawWorkspace();

    // 探针覆盖两轮全程：中途闪现一次 Highspeed 也会记到。
    await startHighspeedComposerProbe();
    await sendHighspeedTurnAndWaitCompleted(
      "E2E_HIGHSPEED_DRAW_MISS_TURN_1: reply with the fixed first-turn token.",
      "hs-draw-miss-turn-1-done",
    );
    await sendHighspeedTurnAndWaitCompleted(
      "E2E_HIGHSPEED_DRAW_MISS_TURN_2: reply with the fixed second-turn token.",
      "hs-draw-miss-turn-2-done",
    );

    expect(await takeHighspeedComposerProbe()).toBe(false);
    expect(await countHighspeedStatusTags()).toBe(0);
  });
});
