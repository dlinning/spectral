import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import type { InlineConfig } from 'vitest/node';

declare module 'vite' {
  interface UserConfig {
    test?: InlineConfig;
  }
}

export default defineConfig({
  base: './',
  server: {
    host: true,
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'logo/icon.svg',
        'logo/icon-128.png',
        'logo/icon-256.png',
        'logo/icon-512.png',
        'wasm/spectral_dsp.wasm',
      ],
      manifest: {
        name: 'Spectral — Spectrum Analyzer, Spectrogram & Tuner',
        short_name: 'Spectral',
        description: 'Spectrum Analyzer, Spectrogram, and Chromatic Musical Tuner.',
        theme_color: '#090d16',
        background_color: '#090d16',
        display: 'standalone',
        orientation: 'any',
        icons: [
          {
            src: 'logo/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
          {
            src: 'logo/icon-128.png',
            sizes: '128x128',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'logo/icon-256.png',
            sizes: '256x256',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'logo/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,wasm}'],
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
