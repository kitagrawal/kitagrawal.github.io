"""Build the six header logos at the repo root from the original light lockup.
Rounds coordinates to 0.1 unit, pads each viewBox 2 units past the letters' true edges (quadratic extrema
included), makes the dark file the light drawing recoloured, and the compact files the name over a full-width tagline, and the name-only files the name paths alone.
Run from the repo root:  python3 -I tools/header-logos/build.py
If the viewBox sizes change, update the aspect-ratio values on .logo-art in base.css."""
import re, os
root = '.'
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'source', 'logo-light.svg')).read()
INK, ACC = '#171C22', '#2457E7'
DINK, DACC = '#F5F2EA', '#2457E7'
PAD = 2.0

def tokens(d):
    return re.findall(r'[MLHVQZ]|-?\d*\.?\d+(?:e-?\d+)?', d)

def walk(d):
    """Yield (cmd, [numbers]) groups and track points for bbox (exact for quadratic)."""
    t = tokens(d); i = 0; cmd = None; out = []
    while i < len(t):
        if re.match('[A-Z]', t[i]): cmd = t[i]; i += 1
        if cmd == 'Z': out.append(('Z', [])); continue
        n = {'M':2,'L':2,'H':1,'V':1,'Q':4}[cmd]
        out.append((cmd, [float(x) for x in t[i:i+n]])); i += n
        if cmd == 'M': cmd = 'L'
    return out

def bbox(groups, tx, ty):
    xs, ys = [], []; cx = cy = 0
    for c, a in groups:
        if c in 'ML': cx, cy = a
        elif c == 'H': cx = a[0]
        elif c == 'V': cy = a[0]
        elif c == 'Q':
            x0, y0 = cx, cy; x1, y1, x2, y2 = a
            for p0, p1, p2, arr in ((x0, x1, x2, xs), (y0, y1, y2, ys)):
                den = p0 - 2*p1 + p2
                if den:
                    s = (p0 - p1) / den
                    if 0 < s < 1: arr.append((1-s)**2*p0 + 2*(1-s)*s*p1 + s*s*p2 + (tx if arr is xs else ty))
            cx, cy = x2, y2
        if c != 'Z': xs.append(cx + tx); ys.append(cy + ty)
    return min(xs), min(ys), max(xs), max(ys)

def fmt(v):
    s = f'{v:.1f}'.rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s

def rebuild(groups):
    out = ''
    for c, a in groups:
        out += c + ' '.join(fmt(v) for v in a)
    return re.sub(r' -', '-', out)

def scale(groups, cx, k):
    """Scale absolute path coordinates by k about local x = cx and the baseline (y = 0)."""
    X = lambda x: cx + (x - cx) * k
    out = []
    for c, a in groups:
        if c in 'ML': a = [X(a[0]), a[1] * k]
        elif c == 'H': a = [X(a[0])]
        elif c == 'V': a = [a[0] * k]
        elif c == 'Q': a = [X(a[0]), a[1] * k, X(a[2]), a[3] * k]
        out.append((c, a))
    return out

paths = re.findall(r'<path transform="translate\(([\d.]+) ([\d.]+)\)" d="([^"]*)"/>', src)
src_items = []
for tx, ty, d in paths:
    tx, ty = float(tx), float(ty); g = walk(d)
    src_items.append((tx, ty, g, bbox(g, tx, ty)))
# The source sets a word space between the closing quote and AGRAWAL (optical gap 97 units at the
# quote's height, against 19 between the opening quote and KIT). Pull AGRAWAL left by the difference
# so both quotes sit tight to the name they enclose.
NAME_KERN = 78.0
src_items = [(tx - NAME_KERN, ty, g, bbox(g, tx - NAME_KERN, ty)) if ty == 100 and b[0] > 900 else (tx, ty, g, b)
             for tx, ty, g, b in src_items]
name = [it for it in src_items if it[1] == 100]
src_tag = [it for it in src_items if it[1] == 160]
left = min(it[3][0] for it in name)
right = max(it[3][2] for it in name)
name_bottom = max(it[3][3] for it in name)
tag_cx = (min(it[3][0] for it in src_tag) + max(it[3][2] for it in src_tag)) / 2
tag_w = max(it[3][2] for it in src_tag) - min(it[3][0] for it in src_tag)
tag_cap = 160 - min(it[3][1] for it in src_tag)

def lockup(k, base, rules):
    """The name plus the tagline scaled by k with its baseline at y = base, centred under the name.
    With rules, equal cobalt rules run from the tagline out to the name's edges."""
    tag = []
    for tx, _, g, _ in src_tag:
        g = scale(g, tag_cx - tx, k)
        tag.append((tx, base, g, bbox(g, tx, base)))
    tl = min(it[3][0] for it in tag); tr = max(it[3][2] for it in tag)
    shift = (left + right - tl - tr) / 2
    tag = [(tx + shift, ty, g, bbox(g, tx + shift, ty)) for tx, ty, g, _ in tag]
    rects = []
    if rules:
        gap = 28
        rule_width = tl + shift - gap - left
        assert rule_width > 0
        # Rules sit on the tagline's optical middle, as in the source (y 145 against caps 125-160).
        rule_y = (min(it[3][1] for it in tag) + base) / 2 - 1.5
        rects = [(left, rule_y, rule_width, 3), (tr + shift + gap, rule_y, rule_width, 3)]
    return name + tag, rects

# Full lockup (680 px and up): the source tagline's capitals are ~35 units tall against ~102 for the
# name, about 7-9 px in the header, so it is scaled 1.4x and dropped clear of the name.
full = lockup(1.4, 175.0, True)
# Compact lockup (below 680 px, where the logo is 190-340 px wide): the tagline is scaled to the
# name's full width, with no rules, so its capitals stay about 9-12 px tall.
k_compact = (right - left) / tag_w
compact = lockup(k_compact, name_bottom + 20 + tag_cap * k_compact, False)

def svg(its, rects, ink, acc, label):
    bs = [it[3] for it in its] + [(x, y, x + w, y + h) for x, y, w, h in rects]
    x0 = min(b[0] for b in bs) - PAD; y0 = min(b[1] for b in bs) - PAD
    x1 = max(b[2] for b in bs) + PAD; y1 = max(b[3] for b in bs) + PAD
    body = ''.join(f'<path transform="translate({fmt(tx)} {fmt(ty)})" d="{rebuild(g)}"/>' for tx, ty, g, _ in its)
    r = ''.join(f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h}" fill="{acc}"/>' for x, y, w, h in rects)
    vb = f'{fmt(x0)} {fmt(y0)} {fmt(x1-x0)} {fmt(y1-y0)}'
    return (f'<svg role="img" aria-label="{label}" xmlns="http://www.w3.org/2000/svg" viewBox="{vb}">'
            f'<g fill="{ink}">{body}{r}</g></svg>\n'), (x1-x0, y1-y0, y0)

FULL = 'ANKIT “KIT” AGRAWAL, The Applied AI Letter'
for fn, (its, rects), ink, acc, label in [
    ('logo-light.svg', full, INK, ACC, FULL),
    ('logo-dark.svg', full, DINK, DACC, FULL),
    ('logo-compact-light.svg', compact, INK, ACC, FULL),
    ('logo-compact-dark.svg', compact, DINK, DACC, FULL),
    ('logo-name-light.svg', (name, []), INK, ACC, 'ANKIT “KIT” AGRAWAL'),
    ('logo-name-dark.svg', (name, []), DINK, DACC, 'ANKIT “KIT” AGRAWAL')]:
    s, dims = svg(its, rects, ink, acc, label)
    open(f'{root}/{fn}', 'w').write(s)
    print(fn, len(s), 'w=%.1f h=%.1f top=%.1f' % dims)
