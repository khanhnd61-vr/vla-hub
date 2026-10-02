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
| `.github/ISSUE_TEMPLATE/` | The issue forms behind "Request a benchmark" and "Submit a result"; the result form is the step-by-step measuring guide |

## Updating the numbers

Every number comes from the Markdown reports in each engine's `docs/benchmark/`
(plus `docs/backend/metal.md` for the Apple M5 Max). After a new benchmark round,
regenerate the data from local checkouts of both repos:

```bash
python3 tools/build_data.py --vla-cpp ../../work/vla.cpp --vla-simd ../../release/gh/vla.simd
```

A new device needs one line in `CPP_REPORTS` or `SIMD_REPORTS` in the script and an
entry in `devices` in `data/meta.js`; a new model needs its name in `CPP_MODELS` or
`SIMD_MODELS` and an entry in `models`. A report from a commit other than the round's
goes in `CPP_BUILD` or `SIMD_BUILD`, and the Method section of `index.html` says so.

## Requests and submitted results

"Request a benchmark" and "Submit a result" open the issue forms in
`.github/ISSUE_TEMPLATE/`, with the policy, device and engine filled in from the
current search (a query parameter named after a field's `id` fills that field).
The result form walks a submitter through measuring with vla.cpp: build, checkpoint,
the `vla-bench` command per policy, best of three processes, memory, and the flag
screen. Keep it in step with vla.cpp's `docs/benchmark/TEMPLATE.md`. GitHub only
shows the forms once they are on the repo's default branch.

## Deploying

The folder is ready for GitHub Pages as is (`.nojekyll` keeps Pages from running
Jekyll). Searches are kept in the URL, so `?q=jetson&proc=GPU` links to a filtered
view.
