import { fileURLToPath, URL } from "node:url"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { VitePWA } from "vite-plugin-pwa"

const src = fileURLToPath(new URL("./src", import.meta.url))
const buildId = process.env.IREAD_BUILD_ID ?? "dev"
const devApiTarget =
  process.env.IREAD_DEV_API || "http://127.0.0.1:8082"

export default defineConfig({
  define: {
    __IREAD_BUILD_ID__: JSON.stringify(buildId),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt",
      injectRegister: false,
      manifestFilename: "manifest.webmanifest",
      includeManifestIcons: false,
      manifest: {
        id: "/",
        name: "iRead",
        short_name: "iRead",
        description: "本机优先的个人阅读库。",
        lang: "zh-CN",
        start_url: "/",
        scope: "/",
        display: "standalone",
        // 固定 neutral token：dark oklch(0.145 0 0) -> #0a0a0a，
        // light oklch(1 0 0) -> #ffffff。
        theme_color: "#0a0a0a",
        background_color: "#ffffff",
        icons: [
          {
            src: "/pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "/maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      injectManifest: {
        globPatterns: [
          "**/*.{js,css,html,ico,png,svg}",
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: [
      {
        find: "@/registry/new-york-v4/ui",
        replacement: fileURLToPath(new URL("./src/components/ui", import.meta.url)),
      },
      {
        find: "@/registry/new-york-v4/hooks",
        replacement: fileURLToPath(new URL("./src/hooks", import.meta.url)),
      },
      {
        find: "@/registry/new-york-v4/lib",
        replacement: fileURLToPath(new URL("./src/lib", import.meta.url)),
      },
      { find: "@", replacement: src },
    ],
  },
  server: {
    proxy: {
      "/api": devApiTarget,
      "/healthz": devApiTarget,
    },
  },
})
