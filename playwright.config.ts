import { createPlaywrightConfig } from './src/playwright/config';

// This repo dogfoods the same config factory every consuming repo uses, so a
// problem in it shows up here first. No Allure: utils' tests are plain Node
// (no browser, no UI flow worth a trend report), so JUnit + HTML are enough.
export default createPlaywrightConfig({
  dir: __dirname,
  name: '@automation/referenced-automation-utils',
  allure: false,
});
