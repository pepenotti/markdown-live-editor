import { defineConfig } from 'vitest/config';

// Unit tests only. The integration tests under test/integration run inside VS Code (npm run test:integration).
export default defineConfig({
  test: { include: ['test/unit/**/*.test.ts'] },
});
