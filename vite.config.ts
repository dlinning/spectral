import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'wasm/spectral_dsp.wasm'],
      manifest: {
        name: 'Spectral — Acoustic Analyzer, Spectrograph & Tuner',
        short_name: 'Spectral',
        description:
          'High-precision WebAssembly Spectrum Analyzer with fractional-octave smoothing, 60s Spectrograph, and Chromatic Musical Tuner.',
        theme_color: '#090d16',
        background_color: '#090d16',
        display: 'standalone',
        orientation: 'any',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,wasm}'],
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    globals: true,
  },
} as any);
