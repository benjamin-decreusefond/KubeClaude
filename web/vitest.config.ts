import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Component tests run in jsdom against the real components — the point is to
 * catch a screen that stops rendering or a form that stops submitting, which
 * typechecking cannot see. Anything that talks to the API is mocked at the
 * `api` module, so nothing here needs a server.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
