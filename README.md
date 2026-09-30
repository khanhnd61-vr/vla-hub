# VLA Hub

A static site for exploring measured latency and memory of Vision-Language-Action
models across two inference engines, [vla.cpp](https://github.com/VinRobotics/vla.cpp)
and [vla.simd](https://github.com/cair-vinuni/vla.simd). There is no build step: open
`index.html`, or serve the folder with any static server.

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

## Files

| Path | What it holds |
|---|---|
| `index.html`, `assets/` | The page, its styles and its script |
| `data/meta.js` | Hand-written: engine descriptions and links, model summaries and Hugging Face checkpoints, device notes |
| `data/bench.js` | Generated: every measurement, parsed from the engines' benchmark reports |
| `tools/build_data.py` | The generator for `data/bench.js` |

## Updating the numbers

Every number comes from the Markdown reports in each engine's `docs/benchmark/`
(plus `docs/backend/metal.md` for the Apple M5 Max). After a new benchmark round,
regenerate the data from local checkouts of both repos:

```bash
python3 tools/build_data.py --vla-cpp ../../work/vla.cpp --vla-simd ../../release/gh/vla.simd
```

A new device needs one line in `CPP_REPORTS` or `SIMD_REPORTS` in the script and an
entry in `devices` in `data/meta.js`; a new model needs its name in `CPP_MODELS` or
`SIMD_MODELS` and an entry in `models`.

The vla.simd report links point at the `fix-inference-and-ci` branch, the only
branch that has `docs/benchmark/` today. Once it merges, change `reports` for
vla.simd in `data/meta.js` (and the link in the Method section of `index.html`)
to `main`.

## Deploying

The folder is ready for GitHub Pages as is (`.nojekyll` keeps Pages from running
Jekyll). Searches are kept in the URL, so `?q=jetson&proc=GPU` links to a filtered
view.
