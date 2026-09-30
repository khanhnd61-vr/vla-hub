#!/usr/bin/env python3
"""Build data/bench.js from the vla.cpp and vla.simd benchmark reports.

    python3 tools/build_data.py [--vla-cpp PATH] [--vla-simd PATH]

PATH is a checkout of each repo. Every number on the site comes from their
Markdown reports; nothing here is typed in by hand except which report and
table each device's rows come from.
"""
import argparse
import json
import pathlib
import re
from datetime import date

ROOT = pathlib.Path(__file__).resolve().parent.parent

CPP_MODELS = {
    'SmolVLA': 'smolvla', 'π0': 'pi0', 'pi0': 'pi0', 'π0.5': 'pi05', 'pi0.5': 'pi05',
    'GR00T N1.5': 'gr00t15', 'GR00T N1.6': 'gr00t16', 'GR00T N1.7': 'gr00t17',
    'BitVLA': 'bitvla', 'Evo-1': 'evo1', 'VLA-Adapter': 'adapter', 'OpenVLA-OFT': 'oft',
    'VLA-JEPA': 'jepa', 'Octo-Small': 'octo', 'TurboVLA': 'turbovla',
}
SIMD_MODELS = {
    'ACT': 'act', 'IMPACT': 'impact', 'SmolVLA': 'smolvla', 'Octo-Small': 'octo',
    'TurboVLA': 'turbovla', 'Diffusion Policy': 'dp',
}
FLAGS = {
    '--flash-attn': 'flash-attn',
    '--weight-dtype f16': 'f16 weights',
    '--weight-dtype bf16': 'bf16 weights',
    '--weight-dtype f16 --flash-attn': 'f16 weights + flash-attn',
    '--weight-dtype bf16 --flash-attn': 'bf16 weights + flash-attn',
    '--flash-attn --mm-prec default': 'flash-attn + mm-prec default',
    '--act-dtype bf16 --flash-attn': 'bf16 act + flash-attn',
}
MEM_COLS = {
    'Peak VRAM MiB': 'vram', 'Peak host RSS MiB': 'rss', 'Peak RSS MiB': 'rss',
    'Peak working set MiB': 'rss', 'Peak device buffers MiB': 'shared',
}

# vla.cpp: report -> device, then one entry per section of that report:
# (heading substring or None, backend, processor class, unit shown to readers)
CPP_REPORTS = [
    ('rtx-5090.md', 'rtx5090', [(None, 'CUDA', 'GPU', 'GPU')]),
    ('rtx-3090.md', 'rtx3090', [(None, 'CUDA', 'GPU', 'GPU')]),
    ('rtx-5070-laptop.md', 'rtx5070l', [(None, 'CUDA', 'GPU', 'GPU')]),
    ('rtx-3060.md', 'rtx3060', [(None, 'CUDA', 'GPU', 'GPU')]),
    ('jetson-agx-orin.md', 'agxorin', [(None, 'CUDA', 'GPU', 'GPU')]),
    ('jetson-orin-nano.md', 'orinnano', [(None, 'CUDA', 'GPU', 'GPU')]),
    ('apple-m4.md', 'm4', [(None, 'Metal', 'GPU', 'GPU')]),
    ('arc-a380.md', 'a380', [(None, 'SYCL', 'GPU', 'GPU')]),
    ('core-ultra-x7-358h.md', 'x7', [
        ('Arc B390 iGPU', 'OpenVINO', 'GPU', 'Arc B390 iGPU'),
        ('AI Boost NPU', 'OpenVINO', 'NPU', 'AI Boost NPU'),
        ('OpenVINO CPU plugin', 'OpenVINO', 'CPU', 'CPU'),
        ('ggml CPU backend', 'ggml', 'CPU', 'CPU'),
    ]),
    ('snapdragon-x-hexagon.md', 'snapx', [
        ('Hexagon NPU', 'Hexagon', 'NPU', 'NPU'),
        ('Oryon CPU', 'ggml', 'CPU', 'Oryon CPU'),
    ]),
    ('core-i7-14700f.md', 'i7', [(None, 'ggml', 'CPU', 'CPU')]),
    ('core-i9-14900hx.md', 'i9', [(None, 'ggml', 'CPU', 'CPU')]),
    ('core-i5-12400f.md', 'i5', [(None, 'ggml', 'CPU', 'CPU')]),
    ('ryzen-5-5500.md', 'ryzen5', [(None, 'ggml', 'CPU', 'CPU')]),
]
# Reports that ran at a different commit from the round in docs/benchmark/README.md.
CPP_BUILD = {'x7': '450992c'}
CPP_ROUND = 'c93ca0a'
# docs/backend/ov.md lists π0's NPU output as wrong; the report did not re-check it.
CPP_EXCLUDE = {('pi0', 'x7', 'AI Boost NPU')}

SIMD_REPORTS = {
    'raspberry-pi-5.md': ('pi5', 'CPU'), 'snapdragon-x.md': ('snapx', 'Oryon CPU'),
    'apple-m4.md': ('m4', 'CPU'), 'amd-ryzen-5-5500.md': ('ryzen5', 'CPU'),
    'intel-core-i5-12400f.md': ('i5', 'CPU'), 'intel-core-i7-14700f.md': ('i7', 'CPU'),
    'intel-core-i9-14900hx.md': ('i9', 'CPU'),
}
SIMD_BACKENDS = {'x86-avx2': 'AVX2', 'amd-zen': 'AVX2', 'apple': 'NEON + Accelerate', 'neon': 'NEON'}
SIMD_ROUND = '7636baa'


def tables(text):
    """Yield (heading, header, rows) for every Markdown table, with its nearest heading."""
    heading, lines, i = '', text.splitlines(), 0
    while i < len(lines):
        ln = lines[i]
        if ln.startswith('#'):
            heading = ln.lstrip('#').strip()
        if ln.startswith('|') and i + 1 < len(lines) and re.match(r'^\|[-:| ]+\|$', lines[i + 1]):
            hdr = [c.strip() for c in ln.strip().strip('|').split('|')]
            rows, j = [], i + 2
            while j < len(lines) and lines[j].startswith('|'):
                rows.append([c.strip() for c in lines[j].strip().strip('|').split('|')])
                j += 1
            yield heading, hdr, rows
            i = j
            continue
        i += 1


def num(s):
    s = s.replace(',', '').replace('**', '').strip()
    return None if s in ('-', '', 'n/a') else float(s)


def pick(hdr, row, col):
    return num(row[hdr.index(col)]) if col in hdr else None


def mem_of(hdr, row):
    mem = {}
    for col, key in MEM_COLS.items():
        v = pick(hdr, row, col)
        if v is not None:
            mem[key] = int(v)
    return mem or None


def strip_ticks(s):
    return s.replace('`', '').strip()


def build_cpp(repo):
    bench = repo / 'docs' / 'benchmark'
    out = []
    for fn, dev, sections in CPP_REPORTS:
        text = (bench / fn).read_text()
        all_tables = list(tables(text))
        for key, backend, proc, unit in sections:
            lat = fast = None
            for heading, hdr, rows in all_tables:
                if key and key not in heading:
                    continue
                if hdr[:2] == ['Model', 'Views']:
                    lat = (hdr, rows)
                elif hdr[:2] == ['Model', 'Fastest flags']:
                    fast = (hdr, rows)
            if lat is None:
                raise SystemExit(f'{fn}: no latency table for {key or "the device"}')
            base = dict(engine='vla.cpp', device=dev, backend=backend, proc=proc, unit=unit,
                        build=CPP_BUILD.get(dev, CPP_ROUND), report=fn)
            hdr, rows = lat
            views = {}
            author = dev == 'rtx5090'  # author's numbers: min at defaults, nothing else
            for r in rows:
                model = CPP_MODELS[r[0]]
                views[model] = int(r[1])
                if (model, dev, unit) in CPP_EXCLUDE:
                    continue
                stats = {k: pick(hdr, r, f'{k} ms') for k in ('min', 'mean', 'p50', 'p90')}
                out.append(dict(base, model=model, config='defaults', setup='defaults',
                                flags='', stat='min' if author else 'mean',
                                ms=stats['min'] if author else stats['mean'],
                                stats={k: v for k, v in stats.items() if v is not None},
                                vision=pick(hdr, r, 'vision ms'), mem=mem_of(hdr, r),
                                views=views[model]))
            if fast is None or author:
                continue
            hdr, rows = fast
            for r in rows:
                model, flags = CPP_MODELS[r[0]], strip_ticks(r[1])
                if flags == '*(defaults)*' or (model, dev, unit) in CPP_EXCLUDE:
                    continue
                stats = {k: pick(hdr, r, f'{k} ms') for k in ('min', 'mean', 'p50', 'p90')}
                out.append(dict(base, model=model, config='fastest', setup=FLAGS[flags],
                                flags=flags, stat='mean', ms=stats['mean'], stats=stats,
                                vision=pick(hdr, r, 'vision ms'), mem=mem_of(hdr, r),
                                views=views[model], vsDefaults=r[hdr.index('vs defaults')]))

    # Apple M5 Max is not in the round: docs/backend/metal.md, an earlier build.
    metal = (repo / 'docs' / 'backend' / 'metal.md').read_text()
    for heading, hdr, rows in tables(metal):
        if hdr[:4] == ['Model', 'Views', 'Input', 'min ms'] and 'p50 ms' in hdr:
            for r in rows:
                stats = {k: pick(hdr, r, f'{k} ms') for k in ('min', 'p50', 'p90')}
                out.append(dict(engine='vla.cpp', device='m5max', backend='Metal', proc='GPU',
                                unit='GPU', build='llama.cpp b10331', report='../backend/metal.md',
                                model=CPP_MODELS[r[0]], config='defaults', setup='defaults',
                                flags='', stat='p50', ms=stats['p50'], stats=stats,
                                vision=pick(hdr, r, 'vision ms'), mem=None, views=int(r[1]),
                                earlier=True))
            break
    return out


def build_libero(repo):
    text = (repo / 'docs' / 'benchmark' / 'libero.md').read_text()
    obj, suites = {}, {}
    for heading, hdr, rows in tables(text):
        if hdr[:4] == ['Model', 'Replay', 'Successes', 'Success rate']:
            for r in rows:
                obj[CPP_MODELS[r[0]]] = {'rate': num(r[3].rstrip('%')), 'successes': r[2],
                                         'replay': int(r[1])}
        elif hdr[:3] == ['Model', 'Spatial', 'Object']:
            for r in rows:
                suites[CPP_MODELS[r[0]]] = {h: num(v.rstrip('%')) for h, v in zip(hdr[1:], r[1:])}
    return {'object': obj, 'suites': suites}


def build_simd(repo):
    bench = repo / 'docs' / 'benchmark'
    out = []
    for fn, (dev, unit) in SIMD_REPORTS.items():
        text = (bench / fn).read_text()
        backend, settings, results = None, {}, []
        for heading, hdr, rows in tables(text):
            if hdr == ['Item', 'Value']:
                for r in rows:
                    if r[0] == 'Backend':
                        backend = SIMD_BACKENDS[strip_ticks(r[1])]
            elif hdr[:3] == ['Model', 'Precision', 'Threads']:
                for r in rows:
                    settings[(r[0], r[1])] = {'threads': int(r[2]), 'int8Mask': r[3],
                                              'other': strip_ticks(r[4])}
            elif hdr[:3] == ['Model', 'Precision', 'Median (ms)'] and heading == 'Results':
                results = [(hdr, r) for r in rows]
        for hdr, r in results:
            s = settings[(r[0], r[1])]
            stats = {k: pick(hdr, r, f'{k} (ms)') for k in ('p10', 'p90', 'p95')}
            stats['median'] = pick(hdr, r, 'Median (ms)')
            out.append(dict(engine='vla.simd', model=SIMD_MODELS[r[0]], device=dev,
                            backend=backend, proc='CPU', unit=unit, build=SIMD_ROUND, report=fn,
                            config=r[1], setup=f'{r[1]} · {s["threads"]} threads',
                            threads=s['threads'], int8Mask=s['int8Mask'], other=s['other'],
                            stat='median', ms=stats['median'], stats=stats, vision=None,
                            mem={'rss': int(pick(hdr, r, 'Peak RSS (MiB)'))}, views=None))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--vla-cpp', type=pathlib.Path, default=pathlib.Path('/home/khanh/work/vla.cpp'))
    ap.add_argument('--vla-simd', type=pathlib.Path,
                    default=pathlib.Path('/home/khanh/release/gh/vla.simd'))
    args = ap.parse_args()

    results = build_cpp(args.vla_cpp) + build_simd(args.vla_simd)
    results = [{k: v for k, v in r.items() if v not in (None, '')} for r in results]
    data = {
        'generated': date.today().isoformat(),
        'rounds': {'vla.cpp': CPP_ROUND, 'vla.simd': SIMD_ROUND},
        'libero': build_libero(args.vla_cpp),
        'results': results,
    }
    body = ',\n'.join('    ' + json.dumps(r, ensure_ascii=False, separators=(',', ':')) for r in results)
    head = {k: v for k, v in data.items() if k != 'results'}
    js = ('// Generated by tools/build_data.py from the vla.cpp and vla.simd benchmark reports.\n'
          '// Do not edit by hand: re-run the script when a report changes.\n'
          'window.VLA_BENCH = Object.assign(' + json.dumps(head, ensure_ascii=False, indent=2) +
          ', {\n  results: [\n' + body + '\n  ],\n});\n')
    (ROOT / 'data').mkdir(exist_ok=True)
    (ROOT / 'data' / 'bench.js').write_text(js)
    cpp = sum(r['engine'] == 'vla.cpp' for r in results)
    print(f'wrote data/bench.js: {len(results)} results ({cpp} vla.cpp, {len(results) - cpp} vla.simd)')


if __name__ == '__main__':
    main()
