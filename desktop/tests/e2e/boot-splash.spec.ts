import { expect, test } from "@playwright/test";
import { installMockBridge } from "../helpers/bridge";

// Cold-boot splash hold: the loading gate is held as an overlay above the
// already mounted app for a minimum visible duration, then fades out. Locally
// the hold is 0 and the gate has no bee, so this spec only covers the hold
// machinery, which a spec can still opt into via __BUZZ_E2E__.bootSplashHoldMs.

test("boot splash overlay holds, then dismisses", async ({ page }) => {
  await installMockBridge(page);
  // Registered after installMockBridge so it runs after the bridge's init
  // script and can extend the config it assigns.
  await page.addInitScript(() => {
    const testWindow = window as Window & {
      __BUZZ_E2E__?: { bootSplashHoldMs?: number };
    };
    testWindow.__BUZZ_E2E__ = {
      ...(testWindow.__BUZZ_E2E__ ?? {}),
      bootSplashHoldMs: 1_500,
    };
  });
  await page.goto("/");

  const overlay = page.getByTestId("boot-splash-overlay");
  await expect(overlay).toBeVisible();

  // The app mounts and loads beneath the overlay — boot is not delayed.
  await expect(page.getByTestId("home-inbox-list")).toBeVisible();

  // After the hold elapses the overlay fades out and unmounts.
  await expect(overlay).toHaveCount(0, { timeout: 6_000 });
  await expect(page.getByTestId("home-inbox-list")).toBeVisible();
});

test("boot splash overlay is skipped when the hold is zero (e2e default)", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");

  await expect(page.getByTestId("home-inbox-list")).toBeVisible();
  await expect(page.getByTestId("boot-splash-overlay")).toHaveCount(0);
});
