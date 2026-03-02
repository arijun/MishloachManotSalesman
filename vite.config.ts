import { defineConfig } from 'vite';

// When deploying to GitHub Pages the app lives at /<repo-name>/.
// Set VITE_BASE_PATH in your CI environment (see .github/workflows/deploy.yml).
// For local dev, leave it unset so the base is '/'.
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
});
