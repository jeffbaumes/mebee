// Dev server only. The shipped site (see .github/workflows) is still the
// raw, unbundled source tree -- deliberately, per the description in
// package.json -- so this config has no build/plugin setup, just enough to
// serve index.html with real no-cache dev headers and HMR. That's what
// actually fixes the stale-shader/stale-module problem http-server's default
// caching kept causing: Vite's dev server never lets the browser cache a
// module response, and it triggers a reload the moment a file changes.
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // PORT when the harness assigns one, so two sessions can serve this tree
    // at once; 5173 when run by hand. strictPort stays off so a hand-run
    // server steps aside rather than failing if 5173 is already taken.
    port: Number(process.env.PORT) || 5173,
    strictPort: false,
  },
  clearScreen: false,
});
