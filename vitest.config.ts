import { defineConfig } from 'vitest/config';

// Only the factory's own tests. The claude-code worker clones the target repo
// under telemetry/workspaces, and that repo's test files must not run here.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
