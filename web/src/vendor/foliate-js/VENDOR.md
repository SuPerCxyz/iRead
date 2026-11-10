# foliate-js vendor

- Upstream: <https://github.com/johnfactotum/foliate-js>
- Pinned commit: `78914aef4466eb960965702401634c2cb348e9b1` (2026-05-01)
- License: MIT, see `LICENSE` (upstream copyright John Factotum)
- Package: copied as browser ES modules; no npm dependency and no package.json in the app.

## Files

| File | Upstream SHA-256 | Local SHA-256 | State |
| --- | --- | --- | --- |
| `view.js` | `e0093af921feb03bb58fb51aeedc321fa108a4158d215f6913ecf7925415c945` | `9a72b67bf63a88ba10c49c3b38214b260f0743d70a9376bc5877a6d0d000619d` | adapted |
| `paginator.js` | `51cec81572d5d182e231fe68ce9c3b5489a0976b36172060516336ba893565ea` | `6e35a48d088a3ab6404dc73732d73a55a1bd09687b817ea5bbd2f9e41c768f14` | adapted |
| `epubcfi.js` | `e1a688ad5c84bf31f33cef467f92c7a6d060a0f17ec37c1d3c048e9c7b1cf645` | `e1a688ad5c84bf31f33cef467f92c7a6d060a0f17ec37c1d3c048e9c7b1cf645` | verbatim |
| `progress.js` | `544f5e90babc0cb31c5caf971a5f06dd6249ec06600cb62f672fa7179811fde1` | `544f5e90babc0cb31c5caf971a5f06dd6249ec06600cb62f672fa7179811fde1` | verbatim |
| `overlayer.js` | `d3d3396e3083277ccbd4f17c407621159b22a407107e43ce75ca3014578094fb` | `d3d3396e3083277ccbd4f17c407621159b22a407107e43ce75ca3014578094fb` | verbatim |
| `text-walker.js` | `4ad740ab6142b5be428700ef4d270253cef6649cf6e047ae7d2698a7aec65e92` | `4ad740ab6142b5be428700ef4d270253cef6649cf6e047ae7d2698a7aec65e92` | verbatim |
| `fixed-layout.js` | `7aee1d15d8e0479b8a6c59a20304b250dafc4c7dc158147a2b2c6bed9e180b4c` | `7aee1d15d8e0479b8a6c59a20304b250dafc4c7dc158147a2b2c6bed9e180b4c` | verbatim |
| `search.js` | `31e846bdc095a645de0e94f7baa2c9e136561a363a2f774d4032e72cfa1fb0ef` | `31e846bdc095a645de0e94f7baa2c9e136561a363a2f774d4032e72cfa1fb0ef` | verbatim |
| `tts.js` | `530d34605b758a5e2260438964a85bb9909bcb49e8848e303fe22cac63859026` | `530d34605b758a5e2260438964a85bb9909bcb49e8848e303fe22cac63859026` | verbatim |
| `LICENSE` | `b621ffc351fe263bc9b09dd0bc1c9332fda9c462a3904c1e4f0b4d3236b9c28c` | `b621ffc351fe263bc9b09dd0bc1c9332fda9c462a3904c1e4f0b4d3236b9c28c` | verbatim |

`*.d.ts` files are local type declarations for the vendored modules, not upstream files.

## Adaptations

`view.js`:
- Removed the upstream file-type detection and ZIP/PDF/FB2/MOBI loaders
  (`makeBook`, `makeZipLoader`, `makeDirectoryLoader`, `ResponseError`), so the
  bundle contains no whole-book ZIP parsing path. The app always passes a
  manifest-backed Book adapter.
- The `View`/`Paginator`/CFI behavior remains upstream.

`paginator.js`:
- Guard `expand()` and the `setStyles()` animation frame against a missing
  iframe/view after `destroy()`; disconnect the inner ResizeObserver in
  `destroy()`. This removes teardown race console errors when a chapter is
  rebuilt. Rendering and sandbox behavior remain upstream.

The engine sets `sandbox="allow-same-origin allow-scripts"` exactly as upstream;
the main defense is the per-chapter CSP plus the HTML sanitizer in
`web/src/features/reader/epub/sanitize.ts`. The iframe origin is never used as
an identity check.
