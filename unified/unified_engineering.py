"""Shared, dependency-free engineering presentation profiles.

Consolidated from RAMS Workbench 0.2.1. Reuses its bow-tie/RBD geometry,
Systems Visuals FTA gate silhouettes, and Archify generation-band principles.
No engineering calculations or executable model edits live in this module.
"""
import json
import hashlib
import math
import unicodedata
from collections import Counter
from xml.etree.ElementTree import Element, SubElement, tostring, register_namespace
class DiagramError(ValueError):
    """Unsupported or incomplete engineering presentation; no partial output."""

Invalid = DiagramError

VERSION = "1.1.0"
PROFILE = "unified-engineering/1"
FAMILIES = ("fault-tree", "bow-tie", "rbd")

NS = 'http://www.w3.org/2000/svg'
register_namespace('', NS)
INK = '#203743'
MUTED = '#526674'
STROKE = '#6e8792'


def svg(width, height, title):
    root = Element('svg', {'xmlns': NS, 'viewBox': f'0 0 {width:g} {height:g}',
        'width': f'{width:g}', 'height': f'{height:g}', 'role': 'group',
        'aria-label': title, 'data-renderer': 'unified-engineering/1.0'})
    SubElement(root, 'title').text = title
    SubElement(root, 'rect', {'width': '100%', 'height': '100%', 'fill': '#ffffff'})
    return root


def label(root, x, y, value, size=13, color=INK, anchor='middle', weight='400'):
    el = SubElement(root, 'text', {'x': str(x), 'y': str(y),
        'font-family': 'system-ui, sans-serif', 'font-size': str(size),
        'font-weight': weight, 'fill': color, 'text-anchor': anchor})
    el.text = str(value)
    return el


def route(root, points, source='', target='', role='connection', dashed=False):
    attrs = {'d': 'M' + ' L'.join(f'{x:g} {y:g}' for x, y in points),
        'fill': 'none', 'stroke': STROKE, 'stroke-width': '1.6',
        'stroke-linejoin': 'round', 'data-edge-from': source,
        'data-edge-to': target, 'data-edge-kind': role}
    if source and target:
        sequence = sum(1 for e in root if e.get('data-edge-from') == source and e.get('data-edge-to') == target and e.get('data-edge-kind') == role)
        attrs['data-edge-id'] = 'uv-edge-' + hashlib.sha256(json.dumps([role, source, target, sequence], separators=(',', ':')).encode()).hexdigest()
        attrs['data-edge-label'] = 'Boolean input' if role == 'input_to' else 'Causal path allocation' if role == 'causal-path' else role
    if dashed:
        attrs['stroke-dasharray'] = '5 4'
    return SubElement(root, 'path', attrs)


def line(root, x1, y1, x2, y2, dashed=False):
    return route(root, [(x1, y1), (x2, y2)], dashed=dashed)


def wrapped_title(value, limit):
    def units(s):
        return sum(2 if unicodedata.east_asian_width(c) in ('W', 'F') else 1 for c in s)
    lines, current = [], ''
    for word in str(value).split():
        chunks, chunk = [], ''
        for c in word:
            if chunk and units(chunk + c) > limit:
                chunks.append(chunk)
                chunk = ''
            chunk += c
        if chunk:
            chunks.append(chunk)
        for chunk in chunks:
            proposed = (current + ' ' + chunk).strip()
            if current and units(proposed) > limit:
                lines.append(current)
                current = chunk
            else:
                current = proposed
    if current:
        lines.append(current)
    return lines or ['']


def title_lines(e, width, maximum=5):
    rows = wrapped_title(e['title'], max(12, int((width - 30) / 7.2)))
    if len(rows) > maximum:
        rows = rows[:maximum]
        rows[-1] = rows[-1].rstrip() + '…'
    return rows


def card_height(e, width=220, annotation=''):
    return 48 + len(title_lines(e, width)) * 18 + (23 if annotation else 8)


def group_for(root, e, x, y, width, height, occurrence=''):
    attrs = {'data-select': e['id'], 'role': 'button', 'tabindex': '0',
        'aria-label': e['id'] + ' ' + e['title'], 'aria-pressed': 'false',
        'data-bounds': f'{x:g},{y:g},{width:g},{height:g}'}
    if occurrence:
        attrs['data-occurrence'] = occurrence
    attrs['data-node-id'] = occurrence or e['id']
    attrs['data-node-label'] = e['title']
    attrs['data-canonical-id'] = e['id']
    group = SubElement(root, 'g', attrs)
    SubElement(group, 'title').text = e['id'] + ' · ' + e['title']
    return group


def node(root, e, x, y, width=220, height=None, fill='#f6f9fb',
         annotation='', accent='#567583', occurrence='', role=''):
    height = height or card_height(e, width, annotation)
    group = group_for(root, e, x, y, width, height, occurrence)
    group.set('data-node-role', role)
    SubElement(group, 'rect', {'x': str(x), 'y': str(y), 'width': str(width),
        'height': str(height), 'rx': '6', 'fill': fill, 'stroke': '#aabdc5', 'stroke-width': '1.2'})
    SubElement(group, 'rect', {'x': str(x), 'y': str(y + 8), 'width': '3',
        'height': str(height - 16), 'rx': '1.5', 'fill': accent})
    display_id = e['id'] if len(e['id']) <= 26 else e['id'][:13] + '…' + e['id'][-10:]
    label(group, x + 15, y + 23, display_id, 11, accent, 'start', '600')
    for i, text in enumerate(title_lines(e, width)):
        label(group, x + 15, y + 46 + i * 18, text, 13, INK, 'start', '500')
    if annotation:
        label(group, x + 15, y + height - 13, annotation, 11, MUTED, 'start')
    return height


def footer(root, height, text):
    width = float(root.get('viewBox').split()[2])
    rows = wrapped_title(text, max(20, int((width - 56) / 6)))
    for i, row in enumerate(rows):
        label(root, 28, height - 18 - (len(rows) - 1 - i) * 14, row, 11, MUTED, 'start')


def bowtie(snapshot, hazard_id):
    by_id = {e['id']: e for e in snapshot['entities'] if e['state'] != 'archived'}
    h = by_id.get(hazard_id)
    if not h or h['kind'] != 'hazard':
        raise Invalid('Select an active hazard for its bow-tie view')
    links = snapshot['links']
    causes = sorted({l['source'] for l in links if l['relation'] == 'causes'
        and l['target'] == hazard_id and l['source'] in by_id})
    consequences = sorted({l['target'] for l in links if l['relation'] == 'causes'
        and l['source'] == hazard_id and l['target'] in by_id})
    if len(causes) > 30 or len(consequences) > 30:
        raise Invalid('Bow-tie graphical view supports up to 30 causes and 30 consequences; narrow the study boundary')
    paths = {}
    for records, relation in [(causes, 'prevents'), (consequences, 'mitigates')]:
        for identity in records:
            controls = sorted({l['source'] for l in links if l['relation'] == relation
                and l['target'] == identity and l['source'] in by_id})
            if len(controls) > 5:
                raise Invalid('Bow-tie graphical view supports five allocated controls per path; narrow the boundary')
            paths[relation, identity] = controls
    # Each barrier is ON its allocated path. Ordering is stable display order,
    # not an asserted sequence, independent layer, or effectiveness calculation.
    cw, gap, margin, centre_w = 210, 28, 28, 240
    left_count = max([len(paths['prevents', i]) for i in causes] + [1])
    right_count = max([len(paths['mitigates', i]) for i in consequences] + [1])
    left_width = left_count * cw + (left_count - 1) * gap
    right_width = right_count * cw + (right_count - 1) * gap
    centre_x = margin + cw + gap + left_width + 52
    right_x = centre_x + centre_w + 52
    end_x = right_x + right_width + gap
    width = end_x + cw + margin
    row_height = max([card_height(by_id[i], cw, 'Proposed') for i in causes + consequences] +
        [card_height(by_id[c], cw, by_id[c]['data'].get('status', 'Unspecified'))
         for controls in paths.values() for c in controls] + [112]) + 32
    count = max(len(causes), len(consequences), 1)
    height = 116 + count * row_height + 54
    root = svg(width, height, f'Bow tie · {hazard_id} · revision {snapshot["project"]["revision"]}')
    root.set('data-diagram-kind', 'bowtie')
    bands = [(margin, cw, 'THREATS / CAUSES', '#426378'),
        (margin + cw + gap, left_width, 'PREVENTIVE BARRIERS', '#176a76'),
        (centre_x, centre_w, 'TOP EVENT / HAZARD', '#8a5b18'),
        (right_x, right_width, 'MITIGATIVE BARRIERS', '#52678a'),
        (end_x, cw, 'CONSEQUENCES', '#426378')]
    for x, w, heading, color in bands:
        label(root, x, 32, heading, 11, color, 'start', '700')
        line(root, x, 45, x + w, 45)
    centre_h = card_height(h, centre_w, 'Qualitative top event')
    mid = 80 + (count * row_height - 32) / 2
    allocated = set()
    for records, relation, left in [(causes, 'prevents', True), (consequences, 'mitigates', False)]:
        for index, identity in enumerate(records):
            e, controls = by_id[identity], paths[relation, identity]
            cy = 80 + index * row_height + (row_height - 32) / 2
            ex = margin if left else end_x
            eh = card_height(e, cw)
            node(root, e, ex, cy - eh / 2, cw, eh, role='cause' if left else 'consequence')
            lane_x, lane_width = (margin + cw + gap, left_width) if left else (right_x, right_width)
            first = lane_x + (lane_width - (len(controls) * cw + max(0, len(controls) - 1) * gap)) / 2
            endpoints = []
            for j, control in enumerate(controls):
                c = by_id[control]
                cx = first + j * (cw + gap)
                annotation = c['data'].get('status', 'Unspecified')
                ch = card_height(c, cw, annotation)
                # Connector layer precedes cards to avoid drawing over their labels.
                endpoints.append((cx, cx + cw))
                allocated.add(control)
                node(root, c, cx, cy - ch / 2, cw, ch, '#eff8f7' if left else '#f1f4fa',
                    annotation, '#176a76' if left else '#52678a',
                    occurrence=f'{relation}:{identity}:{control}', role=relation)
            if left:
                previous = ex + cw
                for start, end in endpoints:
                    route(root, [(previous, cy), (start, cy)], identity, hazard_id, 'causal-path')
                    previous = end
                elbow = centre_x - 22
                route(root, [(previous, cy), (elbow, cy), (elbow, mid), (centre_x, mid)], identity, hazard_id, 'causes')
            else:
                elbow = right_x - 30
                first_start = endpoints[0][0] if endpoints else ex
                route(root, [(centre_x + centre_w, mid), (elbow, mid), (elbow, cy), (first_start, cy)], hazard_id, identity, 'causes')
                for j, (_, end) in enumerate(endpoints):
                    following = endpoints[j + 1][0] if j + 1 < len(endpoints) else ex
                    route(root, [(end, cy), (following, cy)], hazard_id, identity, 'causal-path')
            if not controls:
                label(root, lane_x + lane_width / 2, cy - 13, 'No allocated barrier', 12, '#8a5b18')
        if not records:
            label(root, margin + cw / 2 if left else end_x + cw / 2, mid, 'No linked cause' if left else 'No linked consequence', 12, MUTED)
    node(root, h, centre_x, mid - centre_h / 2, centre_w, centre_h, '#fff5df',
        'Qualitative top event', '#8a5b18', role='top-event')
    footer(root, height, 'Barrier placement shows allocation only. Display order does not assert sequence, independence or effectiveness.')
    return tostring(root, encoding='unicode'), allocated


def fault_tree(snapshot, top):
    by_id = {e['id']: e for e in snapshot['entities'] if e['state'] != 'archived'}
    children = {}
    for link in snapshot['links']:
        if link['relation'] == 'input_to':
            children.setdefault(link['target'], set()).add(link['source'])
    visiting, seen, depths = set(), set(), {}
    def visit(identity, depth=0):
        if identity in visiting:
            raise Invalid('Fault-tree cycle blocks the graphical view')
        if depth > 24:
            raise Invalid('Graphical fault-tree depth exceeds 24')
        if identity not in by_id or by_id[identity]['kind'] not in ('fault_event', 'fault_gate'):
            raise Invalid('Fault-tree input missing or archived')
        if identity in depths and depth <= depths[identity]:
            return
        depths[identity] = depth
        e = by_id[identity]
        if e['kind'] == 'fault_gate':
            if e['data'].get('logic') not in ('AND', 'OR'):
                raise Invalid('Graphical fault tree supports static AND/OR gates only')
            if not children.get(identity):
                raise Invalid('Fault-tree gate has no inputs')
        elif children.get(identity):
            raise Invalid('A basic event cannot own gate inputs')
        seen.add(identity)
        if len(seen) > 80:
            raise Invalid('Graphical fault-tree bound is 80 reachable nodes')
        visiting.add(identity)
        for child in sorted(children.get(identity, [])):
            visit(child, depth + 1)
        visiting.remove(identity)
    visit(top)
    ids = sorted(seen)
    usage = Counter(child for parent in seen for child in children.get(parent, []))
    sizes = {}
    for identity in ids:
        e = by_id[identity]
        w = 234
        h = card_height(e, w) + (68 if e['kind'] == 'fault_gate' else 42) + (22 if usage[identity] > 1 else 0)
        sizes[identity] = w, h
    edges = [(parent, child) for parent in ids for child in sorted(children.get(parent, []))]
    positions, routes, width, height = dag_layout(top, sizes, edges, depths)
    root = svg(width, height, f'Static fault tree · {top} · revision {snapshot["project"]["revision"]}')
    root.set('data-diagram-kind', 'fta')
    label(root, 28, 27, 'FAILURE LOGIC', 11, MUTED, 'start', '700')
    label(root, width - 28, 27, 'AND / OR · shared events retain one identity', 11, MUTED, 'end')
    for parent, child in edges:
        route(root, routes[parent, child], child, parent, 'input_to')
    for identity in ids:
        e = by_id[identity]
        x, y = positions[identity]
        w, h = sizes[identity]
        x, y = x - w / 2, y - h / 2
        gate = e['kind'] == 'fault_gate'
        ch = card_height(e, w)
        group = group_for(root, e, x, y, w, h)
        group.set('data-fta-type', e['data']['logic'] if gate else 'basic')
        node(group, e, x, y, w, ch, '#fff5df' if identity == top else '#f6f9fb',
            accent='#8a5b18' if identity == top else '#426378')
        # Only the outer group is selectable. The card and symbol are one record.
        nested = list(group)[-1]
        for attr in ('data-select', 'data-node-id', 'data-node-label', 'data-canonical-id', 'role', 'tabindex', 'aria-pressed'):
            nested.attrib.pop(attr, None)
        cx = x + w / 2
        line(group, cx, y + ch, cx, y + ch + 12)
        if gate:
            gy, gw, gh = y + ch + 38, 52, 48
            if e['data']['logic'] == 'AND':
                path = f'M{cx-gw/2} {gy+gh/2} L{cx-gw/2} {gy} C{cx-gw/2} {gy-gh*.68} {cx+gw/2} {gy-gh*.68} {cx+gw/2} {gy} L{cx+gw/2} {gy+gh/2} Z'
            else:
                path = f'M{cx-gw/2} {gy+gh/2} Q{cx} {gy+gh*.14} {cx+gw/2} {gy+gh/2} Q{cx+gw/2} {gy-gh*.15} {cx} {gy-gh/2} Q{cx-gw/2} {gy-gh*.15} {cx-gw/2} {gy+gh/2} Z'
            SubElement(group, 'path', {'d': path, 'fill': '#edf1f8', 'stroke': '#52678a', 'stroke-width': '1.6'})
            label(group, cx, gy + 8, e['data']['logic'], 11, '#334e76', weight='700')
            line(group, cx, gy + gh / 2, cx, y + h)
        else:
            SubElement(group, 'circle', {'cx': str(cx), 'cy': str(y + ch + 26),
                'r': '14', 'fill': '#fff', 'stroke': STROKE, 'stroke-width': '1.6'})
        if usage[identity] > 1:
            label(group, x + w - 8, y + h - 5, f'SHARED · {usage[identity]} uses', 10, '#52678a', 'end', '600')
    footer(root, height, 'Rectangles: event statements · circles: basic events · unarrowed connectors: Boolean inputs · no probability inferred')
    return tostring(root, encoding='unicode')


def rbd(snapshot, tree):
    by_id = {e['id']: e for e in snapshot['entities'] if e['state'] != 'archived'}
    used = set()
    def measure(n, depth=0):
        if not isinstance(n, dict) or depth > 24:
            raise Invalid('Invalid RBD drawing topology')
        if set(n) == {'item'}:
            identity = n['item']
            if identity not in by_id or by_id[identity]['kind'] != 'item':
                raise Invalid('RBD item is missing')
            if identity in used:
                raise Invalid('Repeated physical instance in RBD drawing')
            used.add(identity)
            if len(used) > 50:
                raise Invalid('RBD schematic bound is 50 component instances')
            return (220, card_height(by_id[identity]), [])
        if set(n) != {'op', 'children'} or n['op'] not in ('series', 'parallel') or not isinstance(n['children'], list) or not n['children']:
            raise Invalid('RBD drawing needs nonempty series/parallel groups')
        sizes = [measure(c, depth + 1) for c in n['children']]
        if n['op'] == 'series':
            return (sum(s[0] for s in sizes) + 40 * (len(sizes) - 1) + 56, max(s[1] for s in sizes) + 54, sizes)
        return (max(s[0] for s in sizes) + 100, sum(s[1] for s in sizes) + 32 * (len(sizes) - 1) + 54, sizes)
    sizes = measure(tree)
    w, h = sizes[:2]
    root = svg(w + 120, h + 112, 'RBD success schematic · revision ' + str(snapshot['project']['revision']))
    root.set('data-diagram-kind', 'rbd')
    label(root, 28, 28, 'SUCCESS LOGIC', 11, MUTED, 'start', '700')
    def draw(n, x, y, size):
        width, height, kids = size
        if 'item' in n:
            node(root, by_id[n['item']], x, y, width, height, role='success-block')
            return
        SubElement(root, 'rect', {'x': str(x), 'y': str(y), 'width': str(width),
            'height': str(height), 'rx': '8', 'fill': 'none', 'stroke': '#d5e0e5', 'stroke-dasharray': '4 5'})
        label(root, x + 12, y + 20, n['op'].upper() + (' · all required' if n['op'] == 'series' else ' · any one sufficient'), 11, MUTED, 'start', '600')
        # All children connect to the same vertical port, including a nested group.
        mid = y + 32 + (height - 32) / 2
        if n['op'] == 'series':
            cursor = x + 28
            previous = x
            for child, cs in zip(n['children'], kids):
                cy = mid - (cs[1] + 32) / 2 if 'item' not in child else mid - cs[1] / 2
                route(root, [(previous, mid), (cursor, mid)])
                draw(child, cursor, cy, cs)
                previous = cursor + cs[0]
                cursor += cs[0] + 40
            line(root, previous, mid, x + width, mid)
        else:
            cursor = y + 38
            left, right, mids = x + 20, x + width - 20, []
            for child, cs in zip(n['children'], kids):
                cx = x + (width - cs[0]) / 2
                cy = cursor + (cs[1] + (32 if 'item' not in child else 0)) / 2
                mids.append(cy)
                line(root, left, cy, cx, cy)
                line(root, cx + cs[0], cy, right, cy)
                draw(child, cx, cursor, cs)
                cursor += cs[1] + 32
            line(root, left, min(mids + [mid]), left, max(mids + [mid]))
            line(root, right, min(mids + [mid]), right, max(mids + [mid]))
            line(root, x, mid, left, mid)
            line(root, right, mid, x + width, mid)
    draw(tree, 60, 52, sizes)
    mid = 52 + (h + (32 if 'item' not in tree else 0)) / 2
    line(root, 28, mid, 60, mid)
    line(root, 60 + w, mid, 92 + w, mid)
    for x in (28, 92 + w):
        SubElement(root, 'circle', {'cx': str(x), 'cy': str(mid), 'r': '4', 'fill': INK})
    footer(root, h + 112, 'Series / active parallel only. Separate physical instances; no probability, independence or availability inferred by drawing.')
    return tostring(root, encoding='unicode')


def dag_layout(top, sizes, edges, depths):
    """Deterministic layered DAG placement, using only the standard library.

    Archify's tree keeps generation bands and measured boxes. This extension
    keeps those rules but inserts layout-only corridors for multi-parent and
    rank-skipping edges; canonical shared events are never duplicated.
    """
    if len(edges) > 320:
        raise Invalid('FTA graphical edge bound is 320; narrow the view')
    layers = {}
    display_sizes = dict(sizes)
    chains = {}
    for identity in sorted(sizes):
        layers.setdefault(depths[identity], []).append(identity)
    for index, (parent, child) in enumerate(edges):
        chain = [parent]
        for rank in range(depths[parent] + 1, depths[child]):
            key = ('corridor', index, rank)
            display_sizes[key] = (12, 0)
            layers.setdefault(rank, []).append(key)
            chain.append(key)
        chain.append(child)
        chains[parent, child] = chain
    if len(display_sizes) - len(sizes) > 2048:
        raise Invalid('FTA layout corridor bound is 2048; narrow the view')
    preceding, following = {}, {}
    for chain in chains.values():
        for a, b in zip(chain, chain[1:]):
            following.setdefault(a, []).append(b)
            preceding.setdefault(b, []).append(a)
    ordered = sorted(layers)
    def key(value):
        return ('node', value) if isinstance(value, str) else ('corridor', str(value))
    for row in layers.values():
        row.sort(key=key)
    # Barycentre sweeps reduce crossings without changing source identities.
    for sweep in range(8):
        sequence = ordered[1:] if sweep % 2 == 0 else list(reversed(ordered[:-1]))
        adjacency = preceding if sweep % 2 == 0 else following
        positions = {n: i for row in layers.values() for i, n in enumerate(row)}
        for rank in sequence:
            old = {n: i for i, n in enumerate(layers[rank])}
            def score(n):
                neighbours = adjacency.get(n, [])
                return (sum(positions[x] for x in neighbours) / len(neighbours) if neighbours else old[n], old[n])
            layers[rank].sort(key=score)
            positions.update({n: i for i, n in enumerate(layers[rank])})
    gap, margin = 40, 28
    widths = {r: sum(display_sizes[n][0] for n in row) + gap * (len(row) - 1) for r, row in layers.items()}
    width = max(900, max(widths.values()) + margin * 2)
    centres, bands = {}, {}
    cursor_y = 62
    for rank in ordered:
        row_height = max(display_sizes[n][1] for n in layers[rank])
        bands[rank] = (cursor_y, cursor_y + row_height)
        cursor_x = (width - widths[rank]) / 2
        for n in layers[rank]:
            w, h = display_sizes[n]
            centres[n] = (cursor_x + w / 2, cursor_y + h / 2)
            cursor_x += w + gap
        cursor_y += row_height + 80
    routes = {}
    for edge, chain in chains.items():
        parent, child = edge
        x, y = centres[parent]
        points = [(x, y + sizes[parent][1] / 2)]
        for a, b in zip(chain, chain[1:]):
            ra = depths[a] if isinstance(a, str) else a[2]
            rb = depths[b] if isinstance(b, str) else b[2]
            ax, _ = centres[a]
            bx, by = centres[b]
            points.append((ax, bands[ra][1] + 20))
            points.append((bx, bands[rb][0] - 20))
            if isinstance(b, str):
                points.append((bx, by - sizes[b][1] / 2))
            else:
                points.extend([(bx, bands[rb][0]), (bx, bands[rb][1])])
        routes[edge] = points
    return {n: centres[n] for n in sizes}, routes, width, cursor_y + 12


def validate_trace(model):
    """Validate inert, producer-owned trace excerpts; never assess their adequacy."""
    import re
    trace = model['trace']
    if not isinstance(trace, dict) or set(trace) != {'origin', 'scope', 'records', 'links', 'notices'}:
        raise Invalid('Trace needs origin, scope, records, links and notices')
    try:
        if len(json.dumps(trace, ensure_ascii=False, allow_nan=False).encode()) > 1000000:
            raise Invalid('Trace exceeds the 1 MB review-context limit')
    except (TypeError, ValueError, RecursionError) as error:
        raise Invalid('Invalid or oversized trace JSON') from error
    def text(value, maximum=50000, empty=False):
        return isinstance(value, str) and len(value) <= maximum and (empty or bool(value.strip()))
    def identity(value):
        return isinstance(value, str) and bool(re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', value))
    origin = trace['origin']
    if (not isinstance(origin, dict) or set(origin) != {'id', 'title', 'revision'}
            or not identity(origin['id']) or not text(origin['title'], 1000)
            or type(origin['revision']) is not type(model['revision']) or origin['revision'] != model['revision']):
        raise Invalid('Trace origin must identify the same study revision as the view')
    if not text(trace['scope']):
        raise Invalid('Trace scope must describe the selected excerpts and limits')
    records, links, notices = trace['records'], trace['links'], trace['notices']
    if (not isinstance(records, list) or not records or len(records) > 500
            or not isinstance(links, list) or len(links) > 2000
            or not isinstance(notices, list) or len(notices) > 500):
        raise Invalid('Invalid trace record/link/notice census')
    indexed = {}
    for record in records:
        if not isinstance(record, dict) or set(record) != {'id', 'kind', 'title', 'description', 'state', 'revision', 'data'}:
            raise Invalid('Unknown or missing trace record fields')
        if not identity(record['id']) or record['id'] in indexed:
            raise Invalid('Trace record identities must be unique and portable')
        if (not text(record['kind'], 100) or not text(record['title'], 1000)
                or not text(record['description'], empty=True)
                or record['state'] not in ('draft', 'in_review', 'reviewed', 'archived')
                or type(record['revision']) is not int or record['revision'] < 1
                or not isinstance(record['data'], dict)):
            raise Invalid('Invalid trace record excerpt')
        indexed[record['id']] = record
    for node_record in model['nodes']:
        record = indexed.get(node_record['id'])
        if not record or any(record[k] != node_record[k] for k in ('kind', 'title', 'state', 'revision', 'description') if k in node_record):
            raise Invalid('Trace record contradicts or omits a diagram record')
        if any(record['data'].get(k) != v for k, v in node_record.get('data', {}).items()):
            raise Invalid('Trace attributes contradict the diagram record')
    seen = set()
    for link in links:
        if not isinstance(link, dict) or set(link) != {'source', 'relation', 'target', 'rationale'}:
            raise Invalid('Trace links need source, relation, target and rationale')
        if (not identity(link['source']) or not identity(link['target'])
                or link['source'] not in indexed or link['target'] not in indexed
                or not text(link['relation'], 100) or not text(link['rationale'], empty=True)):
            raise Invalid('Unresolved or invalid trace relationship')
        signature = link['source'], link['relation'], link['target']
        if signature in seen:
            raise Invalid('Duplicate trace relationship')
        seen.add(signature)
    if any((link['source'], link['relation'], link['target']) not in seen for link in model.get('links', [])):
        raise Invalid('Trace omits a declared diagram relationship')
    for notice in notices:
        if (not isinstance(notice, dict) or set(notice) != {'record', 'message'}
                or not identity(notice['record']) or notice['record'] not in indexed or not text(notice['message'])):
            raise Invalid('Trace notice must reference an included record')


def validate(model):
    """Validate the closed presentation profile; numerical analysis is out of scope."""
    import re
    if not isinstance(model, dict) or model.get('profile') != PROFILE or model.get('family') not in FAMILIES:
        raise Invalid('Expected unified-engineering/1 and a supported engineering family')
    allowed = {'profile', 'family', 'id', 'title', 'note', 'revision', 'nodes', 'links', 'subject', 'topology', 'trace'}
    if set(model) - allowed:
        raise Invalid('Unknown engineering presentation fields: ' + ', '.join(sorted(set(model) - allowed)))
    for field in ('id', 'title', 'note'):
        if not isinstance(model.get(field), str) or not model[field].strip():
            raise Invalid('Engineering view needs ' + field)
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,127}', model['id']):
        raise Invalid('Engineering view ID must be lowercase and URL-safe')
    if not isinstance(model.get('revision'), (int, str)) or isinstance(model.get('revision'), bool):
        raise Invalid('Engineering view needs an explicit source revision')
    nodes = model.get('nodes')
    links = model.get('links', [])
    if not isinstance(nodes, list) or not nodes or len(nodes) > 10000 or not isinstance(links, list) or len(links) > 50000:
        raise Invalid('Invalid engineering node/link census')
    kinds = {'fault-tree': {'fault_event', 'fault_gate'},
             'bow-tie': {'hazard', 'cause', 'failure_mode', 'deviation', 'consequence', 'control'}, 'rbd': {'item'}}[model['family']]
    indexed = {}
    for n in nodes:
        if not isinstance(n, dict) or set(n) - {'id', 'kind', 'title', 'state', 'data', 'revision', 'description'}:
            raise Invalid('Unknown engineering node fields')
        identity = n.get('id')
        if not isinstance(identity, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', identity) or identity in indexed:
            raise Invalid('Engineering node identities must be unique and portable')
        if n.get('kind') not in kinds or not isinstance(n.get('title'), str) or not n['title'].strip():
            raise Invalid('Unsupported or incomplete engineering node')
        if n.get('state', 'draft') not in ('draft', 'in_review', 'reviewed', 'archived'):
            raise Invalid('Unknown engineering record state')
        data = n.get('data', {})
        if not isinstance(data, dict) or set(data) - {'logic', 'status'}:
            raise Invalid('Presentation attributes only support gate logic and barrier status; retain analysis data in the source study')
        if 'logic' in data and n['kind'] != 'fault_gate':
            raise Invalid('Only a fault gate can declare Boolean logic')
        if n['kind'] == 'fault_gate' and data.get('logic') not in ('AND', 'OR'):
            raise Invalid('Graphical fault tree supports static AND/OR gates only')
        if 'status' in data and not isinstance(data['status'], str):
            raise Invalid('Barrier status must be text')
        indexed[identity] = n
    signatures = set()
    for link in links:
        if not isinstance(link, dict) or set(link) != {'source', 'relation', 'target'}:
            raise Invalid('Engineering links require source, relation and target')
        a, b, relation = link['source'], link['target'], link['relation']
        if not all(isinstance(x, str) for x in (a, b, relation)) or a not in indexed or b not in indexed:
            raise Invalid('Unresolved engineering link endpoint')
        signature = a, relation, b
        if signature in signatures:
            raise Invalid('Duplicate engineering relationship')
        signatures.add(signature)
        source, target = indexed[a]['kind'], indexed[b]['kind']
        valid = (model['family'] == 'fault-tree' and relation == 'input_to' and target == 'fault_gate') or (
            model['family'] == 'bow-tie' and (
                relation == 'causes' and source in ('cause', 'failure_mode', 'deviation', 'hazard') and target in ('hazard', 'consequence') or
                source == 'control' and ((relation == 'prevents' and target in ('cause', 'deviation')) or (relation == 'mitigates' and target == 'consequence') or (relation == 'controls' and target == 'hazard'))))
        if not valid:
            raise Invalid('Unsupported typed engineering relationship')
    if model['family'] in ('fault-tree', 'bow-tie'):
        subject = indexed.get(model.get('subject'))
        if not subject or subject.get('state') == 'archived' or subject['kind'] != ('hazard' if model['family'] == 'bow-tie' else 'fault_gate'):
            raise Invalid('Select an active engineering view subject')
        if 'topology' in model:
            raise Invalid('Success topology belongs to the RBD profile')
    elif 'subject' in model or 'topology' not in model or links:
        raise Invalid('RBD needs its explicit success topology, without causal links')
    if 'trace' in model:
        validate_trace(model)
    return model


def render(model):
    """Return inert SVG, canonical source and presentation metadata, without mutation."""
    validate(model)
    snapshot = {'project': {'revision': model['revision']},
        'entities': [dict(n, state=n.get('state', 'draft'), data=n.get('data', {})) for n in model['nodes']],
        'links': model.get('links', [])}
    allocated = set()
    if model['family'] == 'fault-tree':
        drawing = fault_tree(snapshot, model['subject'])
    elif model['family'] == 'bow-tie':
        drawing, allocated = bowtie(snapshot, model['subject'])
    else:
        drawing = rbd(snapshot, model['topology'])
    from xml.etree.ElementTree import fromstring
    root = fromstring(drawing)
    # Neutral paints participate in the existing unified Technical/Editorial themes.
    paints = {INK: 'var(--text,' + INK + ')', MUTED: 'var(--text-muted,' + MUTED + ')',
        STROKE: 'var(--arrow,' + STROKE + ')', '#ffffff': 'var(--panel,#ffffff)',
        '#fff': 'var(--panel,#fff)', '#f6f9fb': 'var(--lane-fill,#f6f9fb)'}
    for element in root.iter():
        for attr in ('fill', 'stroke'):
            if element.get(attr) in paints:
                element.set(attr, paints[element.get(attr)])
        if element.get('data-node-id') and element.get('data-occurrence'):
            element.set('data-node-id', '@uv:occ:' + element.get('data-occurrence'))
        if element.get('data-edge-from') and model['family'] == 'bow-tie':
            element.set('data-edge-traversal', 'inspect')
    root.set('data-unified-profile', PROFILE)
    root.set('data-source-revision', str(model['revision']))
    # Bind the exact render input, without copying the application's database.
    SubElement(root, 'metadata', {'id': 'unified-engineering-source'}).text = json.dumps(model, ensure_ascii=False, sort_keys=True)
    return {'svg': tostring(root, encoding='unicode'), 'allocated': sorted(allocated), 'renderer': VERSION}
