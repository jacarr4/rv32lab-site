const SVG_NS = 'http://www.w3.org/2000/svg';
let savedZoom = 'fit';

function svg(tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
}

function normalise(graph) {
  const nodes = graph?.nodes || [];
  // The reusable full-adder description predates recorded gate payloads. Keep
  // it viewable, but do not manufacture values for its internal signals.
  if (nodes.length && nodes[0].inputs) return {...graph, nodes, edges: graph.edges || [], recorded: graph.recorded === true};
  return {...graph, nodes: nodes.map(node => ({...node, inputs: node.inputs || [], output: node.output || node.id})), edges: graph?.edges || [], recorded: false};
}

function nodePositions(nodes) {
  const stageIndex = node => Number.isInteger(node.stage) ? node.stage : (/^bit(\d+)$/.exec(node.stage || '')?.[1] == null ? null : Number(/^bit(\d+)$/.exec(node.stage)[1]));
  const stagedNodes = nodes.filter(node => stageIndex(node) != null);
  if (stagedNodes.length) {
    const rows = new Map(), positions = new Map();
    stagedNodes.forEach(node => { const stage = stageIndex(node); const row = rows.get(stage) || 0; rows.set(stage, row + 1); positions.set(node.id, {x: 240 + stage * 210, y: 42 + row * 82}); });
    const scalarStart = Math.max(...stagedNodes.map(stageIndex)) + 2;
    nodes.filter(node => stageIndex(node) == null).forEach((node, index) => positions.set(node.id, {x: 240 + (scalarStart + Math.floor(index / 16)) * 210, y: 42 + (index % 16) * 82}));
    return positions;
  }
  // Ordinals are published from the actual gate construction. Grouping the
  // overview in sixteen rows bounds a full 32-bit circuit without inventing
  // stages or connections.
  if (nodes.every(node => Number.isInteger(node.ordinal))) return new Map(nodes.map((node, index) => [node.id, {x: 240 + Math.floor(index / 16) * 210, y: 42 + (index % 16) * 82}]));
  const producers = new Map(nodes.map(node => [node.output, node.id]));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const memo = new Map(), visiting = new Set();
  const depth = node => {
    if (memo.has(node.id)) return memo.get(node.id);
    if (visiting.has(node.id)) return 0;
    visiting.add(node.id);
    const parents = (node.inputs || []).map(input => producers.get(input)).filter(Boolean);
    const value = parents.length ? 1 + Math.max(...parents.map(id => depth(byId.get(id)))) : 0;
    visiting.delete(node.id); memo.set(node.id, value); return value;
  };
  const columns = new Map();
  nodes.forEach(node => { const column = depth(node); columns.set(column, [...(columns.get(column) || []), node]); });
  const positions = new Map();
  for (const [column, entries] of columns) entries.forEach((node, row) => positions.set(node.id, {x: 240 + column * 210, y: 55 + row * 94}));
  return positions;
}

function endpoint(edge, positions, outputPoints) {
  const destination = edge.to || edge.target || '', source = edge.from || edge.source || '';
  // Edges commonly end in ``node.input``.  Resolve that bounded suffix form
  // against the already-built position map instead of rescanning every node
  // for every edge in a large RAM/storage graph.
  const resolveId = value => {
    let candidate = String(value);
    while (candidate) {
      if (positions.has(candidate)) return candidate;
      const separator = candidate.lastIndexOf('.');
      if (separator < 0) return undefined;
      candidate = candidate.slice(0, separator);
    }
  };
  const toId = resolveId(destination), fromId = resolveId(source);
  const to = positions.get(toId), from = positions.get(fromId);
  const inputB = /(?:1|b|in1)$/i.test(edge.port || String(destination).slice((toId || '').length + 1) || '');
  return {from: from ? {x: from.x + 88, y: from.y + 28} : outputPoints.get(source), to: to ? {x: to.x, y: to.y + (inputB ? 38 : 18)} : outputPoints.get(destination), fromId, toId};
}

function heapPush(heap, item, compare) {
  heap.push(item);
  let index = heap.length - 1;
  while (index) {
    const parent = Math.floor((index - 1) / 2);
    if (compare(heap[parent], item) <= 0) break;
    heap[index] = heap[parent]; index = parent;
  }
  heap[index] = item;
}

function heapPop(heap, compare) {
  const first = heap[0], last = heap.pop();
  if (!heap.length) return first;
  let index = 0;
  while (index * 2 + 1 < heap.length) {
    let child = index * 2 + 1;
    if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) < 0) child += 1;
    if (compare(last, heap[child]) <= 0) break;
    heap[index] = heap[child]; index = child;
  }
  heap[index] = last;
  return first;
}

// Interval colouring reuses a gutter lane once its previous horizontal span
// is clear.  It is O(E log E), so RAM/storage scopes do not turn routing into
// a quadratic pass over all gates.
function assignLanes(routes) {
  const active = [], free = [];
  let next = 0;
  [...routes].sort((a, b) => a.left - b.left || a.right - b.right || a.key.localeCompare(b.key)).forEach(route => {
    while (active.length && active[0].right < route.left - 4) heapPush(free, heapPop(active, (a, b) => a.right - b.right || a.lane - b.lane).lane, (a, b) => a - b);
    route.lane = free.length ? heapPop(free, (a, b) => a - b) : next++;
    heapPush(active, route, (a, b) => a.right - b.right || a.lane - b.lane);
  });
  return next;
}

function routedPath(from, to, route) {
  const exit = route.exitX, approach = route.approachX;
  return `M${from.x} ${from.y} H${exit} V${route.y} H${approach} V${to.y} H${to.x}`;
}

function crossingMarkers(routes) {
  // A crossing has no dot: the small paper-coloured bridge marks it as wires
  // passing over one another, never as an electrical junction.  The cap keeps
  // this purely presentational pass bounded for expanded RAM graphs.
  const horizontal = routes.filter(route => route.from && route.to).map(route => ({route, y: route.y})).sort((a, b) => a.y - b.y);
  const lowerBound = value => { let low = 0, high = horizontal.length; while (low < high) { const middle = (low + high) >> 1; if (horizontal[middle].y < value) low = middle + 1; else high = middle; } return low; };
  const found = [], seen = new Set(); let inspected = 0;
  for (const route of routes) {
    for (const vertical of [[route.exitX, route.from.y, route.y], [route.approachX, route.y, route.to.y]]) {
      const [x, first, second] = vertical, low = Math.min(first, second), high = Math.max(first, second);
      for (let index = lowerBound(low + .1); index < horizontal.length && horizontal[index].y < high - .1; index += 1) {
        if (inspected++ >= 2400 || found.length >= 180) return found;
        const other = horizontal[index].route;
        if (other === route || x <= Math.min(other.exitX, other.approachX) + .1 || x >= Math.max(other.exitX, other.approachX) - .1) continue;
        const key = `${Math.round(x * 10)}:${Math.round(other.y * 10)}`;
        if (!seen.has(key)) { seen.add(key); found.push({x, y: other.y}); }
      }
    }
  }
  return found;
}

function stemTracks(routes, extraSources = []) {
  const tracks = (side, key) => {
    const groups = new Map();
    const candidates = side === 'from' ? [...routes, ...extraSources] : routes;
    candidates.forEach(route => {
      const point = route[side], column = Math.round(point.x);
      const groupKey = `${column}:${key(route)}`;
      if (!groups.has(groupKey)) groups.set(groupKey, {column, groupKey, y:point.y});
    });
    const byColumn = new Map();
    groups.forEach(group => byColumn.set(group.column, [...(byColumn.get(group.column) || []), group]));
    const assigned = new Map();
    byColumn.forEach(entries => entries.sort((a, b) => a.y - b.y || a.groupKey.localeCompare(b.groupKey)).forEach((entry, index) => assigned.set(entry.groupKey, index)));
    return route => assigned.get(`${Math.round(route[side].x)}:${key(route)}`) || 0;
  };
  return {
    from: tracks('from', route => route.fromId || route.edge.from),
    to: tracks('to', route => `${route.toId || ''}:${route.edge.to}`),
  };
}

function spreadColumns(positions, routes, nodes, outputNames) {
  const columns = [...new Set([...positions.values()].map(point => point.x))].sort((a, b) => a - b);
  if (!columns.length) return positions;
  const outgoing = new Map(columns.map(column => [column, new Set()]));
  const incoming = new Map(columns.map(column => [column, new Set()]));
  const external = new Set();
  routes.forEach(route => {
    if (route.fromId) outgoing.get(positions.get(route.fromId).x)?.add(route.fromId);
    else external.add(route.edge.from);
    if (route.toId) incoming.get(positions.get(route.toId).x)?.add(route.edge.to);
  });
  const producer = new Map(nodes.map(node => [node.output, node.id]));
  outputNames.forEach(name => { const id = producer.get(name); if (id) outgoing.get(positions.get(id).x)?.add(id); });
  const width = new Map();
  let nextX = Math.max(columns[0], 220 + Math.max(0, external.size - 1) * 3 + Math.max(0, incoming.get(columns[0]).size - 1) * 3);
  width.set(columns[0], nextX);
  for (let index = 1; index < columns.length; index += 1) {
    const previous = columns[index - 1], column = columns[index];
    const channels = 134 + Math.max(0, outgoing.get(previous).size - 1) * 3 + Math.max(0, incoming.get(column).size - 1) * 3;
    nextX += Math.max(column - previous, channels);
    width.set(column, nextX);
  }
  return new Map([...positions].map(([id, point]) => [id, {x:width.get(point.x), y:point.y}]));
}

function nandShape(gate, point, selected, activate) {
  const group = svg('g', {class: `nand-gate component-node nand${selected ? ' selected' : ''}`, transform: `translate(${point.x} ${point.y})`, tabindex: '0', role: 'button', 'data-nand-node': gate.id, 'data-component-node': gate.id, 'aria-label': `Inspect ${gate.label || 'NAND'} · ${gate.id}, NAND gate`});
  // Classical ANSI NAND: flat input side, AND's curved output side, then inversion bubble.
  group.append(svg('path', {d: 'M0 4 H33 A24 24 0 0 1 33 52 H0 Z', class: 'nand-body'}));
  group.append(svg('circle', {cx: 62, cy: 28, r: 5, class: 'nand-bubble'}));
  group.append(svg('path', {d: 'M-16 18 H0 M-16 38 H0 M67 28 H88', class: 'nand-pin'}));
  const label = svg('text', {x: 31, y: 72, class: 'nand-label', 'text-anchor': 'middle'}); label.textContent = gate.label || gate.id;
  const title = svg('title'); title.textContent = `${gate.label || 'NAND'} · ${gate.id} · ${gate.source?.module || gate.source || 'actual NAND CSP node'}`;
  group.append(label, title);
  group.addEventListener('click', () => activate(gate));
  group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); activate(gate, true); } });
  return group;
}

/** Render actual captured NAND instances. `onSelect` receives the source-backed node. */
export function renderNandGraph(graph, {selected, onSelect} = {}) {
  const data = normalise(graph), nodes = data.nodes, rawPositions = nodePositions(nodes);
  const inputNames = [...new Set(data.ports?.inputs || [])], outputNames = data.ports?.outputs || data.outputs || [];
  const rawInputPoints = new Map(inputNames.map((name, index) => [name, {x: 180, y: 28 + index * 20}]));
  const rawOutputs = new Map(nodes.map(node => [node.output, {x: rawPositions.get(node.id).x + 88, y: rawPositions.get(node.id).y + 28}]));
  const producers = new Map(nodes.map(node => [node.output, node.id]));
  rawInputPoints.forEach((point, name) => rawOutputs.set(name, point));
  const routes = data.edges.map((edge, index) => {
    const ends = endpoint(edge, rawPositions, rawOutputs);
    const returning = ends.from && ends.to && ends.to.x <= ends.from.x + 24;
    return {...ends, fromId: ends.fromId || producers.get(edge.from), edge, index, returning, feedback: edge.feedback === true, key: `${edge.from}>${edge.to}:${index}`, left: Math.min(ends.from?.x ?? 0, ends.to?.x ?? 0), right: Math.max(ends.from?.x ?? 0, ends.to?.x ?? 0)};
  }).filter(route => route.from && route.to);
  const channelPositions = spreadColumns(rawPositions, routes, nodes, outputNames);
  const channelOutputs = new Map(nodes.map(node => [node.output, {x: channelPositions.get(node.id).x + 88, y: channelPositions.get(node.id).y + 28}]));
  rawInputPoints.forEach((point, name) => channelOutputs.set(name, point));
  routes.forEach(route => { const ends = endpoint(route.edge, channelPositions, channelOutputs); route.from = ends.from; route.to = ends.to; route.fromId = ends.fromId || producers.get(route.edge.from); route.toId = ends.toId; route.returning = route.from && route.to && route.to.x <= route.from.x + 24; route.left = Math.min(route.from.x, route.to.x); route.right = Math.max(route.from.x, route.to.x); });
  const forward = routes.filter(route => !route.returning), returning = routes.filter(route => route.returning);
  const topLaneCount = assignLanes(forward), bottomLaneCount = assignLanes(returning);
  const topMargin = Math.max(48, 22 + topLaneCount * 9);
  const positions = new Map([...channelPositions].map(([id, point]) => [id, {x:point.x, y:point.y + topMargin}]));
  const inputPoints = new Map(inputNames.map((name, index) => [name, {x:180, y:topMargin + 20 + index * 18}]));
  const outputs = new Map(nodes.map(node => [node.output, {x: positions.get(node.id).x + 88, y: positions.get(node.id).y + 28}]));
  inputPoints.forEach((point, name) => outputs.set(name, point));
  const nodesBottom = Math.max(210, ...[...positions.values()].map(point => point.y + 100));
  routes.forEach(route => { const ends = endpoint(route.edge, positions, outputs); route.from = ends.from; route.to = ends.to; route.fromId = ends.fromId || producers.get(route.edge.from); route.toId = ends.toId; });
  const outputRoutes = outputNames.map(name => ({name, from:outputs.get(name), fromId:producers.get(name), edge:{from:name}})).filter(route => route.from);
  const outputRouteByName = new Map(outputRoutes.map(route => [route.name, route]));
  const stems = stemTracks(routes, outputRoutes);
  routes.forEach(route => {
    route.exitX = route.from.x + 8 + stems.from(route) * 3;
    route.approachX = route.to.x - 22 - stems.to(route) * 3;
    route.y = route.returning ? nodesBottom + 22 + route.lane * 9 : 14 + route.lane * 9;
  });
  const outputProducers = new Map(nodes.map(node => [node.output, node.id]));
  const routeBottom = nodesBottom + (returning.length ? 28 + bottomLaneCount * 9 : 0);
  const outputBaseY = routeBottom + 22;
  const height = Math.max(210, outputBaseY + outputNames.length * 18 + 22, ...[...inputPoints.values()].map(point => point.y + 22));
  const outputStartX = Math.max(...[...positions.values()].map(point => point.x + 115)) + 34;
  const outputTerminalX = outputStartX + Math.max(0, outputNames.length - 1) * 11;
  const width = Math.max(600, outputTerminalX + 108, ...[...positions.values()].map(point => point.x + 150));
  const container = document.createElement('section'); container.className = 'nand-graph-container';
  const controls = document.createElement('div'); controls.className = 'nand-graph-controls';
  const scroll = document.createElement('div'); scroll.className = 'nand-graph-scroll';
  const drawing = svg('svg', {class: 'nand-graph', viewBox: `0 0 ${width} ${height}`, width, height, role: 'group', 'aria-label': 'Actual NAND gate topology'});
  const caption = svg('title'); caption.textContent = data.recorded ? 'Recorded CSP NAND gate values' : 'CSP NAND topology; internal values were not recorded'; drawing.append(caption);
  const groups = svg('g', {class: 'nand-groups'});
  for (const group of graph?.groups || []) {
    const points = (group.nodes || []).map(id => positions.get(id)).filter(Boolean); if (!points.length) continue;
    const x0 = Math.min(...points.map(point => point.x)) - 14, x1 = Math.max(...points.map(point => point.x)) + 102;
    const y0 = Math.min(...points.map(point => point.y)) - 24, y1 = Math.max(...points.map(point => point.y)) + 58;
    groups.append(svg('rect', {x:x0,y:y0,width:x1-x0,height:y1-y0,rx:8,class:'nand-group','data-component-group':group.id}));
    const label = svg('text', {x:x0+7,y:y0+14,class:'nand-group-label'}); label.textContent = group.label || group.id; groups.append(label);
  }
  drawing.append(groups);
  const edges = svg('g', {class: 'nand-edges'});
  const external = svg('g', {class: 'nand-external-inputs'});
  const signalLabel = name => data.signals?.[name]?.label || name;
  for (const [name, point] of inputPoints) { const label = svg('text', {x: point.x - 6, y: point.y - 4, class: 'nand-external-label', 'text-anchor': 'end', 'data-nand-boundary': name}); label.textContent = signalLabel(name); external.append(label); }
  for (const route of routes) {
    const {edge} = route;
    const line = svg('path', {d: routedPath(route.from, route.to, route), 'data-nand-edge': `${edge.from}>${edge.to}`, 'data-component-edge': `${edge.from}>${edge.to}`, 'data-nand-signal': edge.from, 'data-nand-from-node': route.fromId || '', 'data-nand-to-node': route.toId || '', 'data-nand-route': route.returning ? 'return' : 'forward', class: `${edge.value == null ? 'nand-edge' : `nand-edge value-${+edge.value}`}${route.feedback ? ' feedback' : ''}`});
    const title = svg('title'); title.textContent = `${edge.from} → ${edge.to} · ${route.feedback ? 'feedback connection · ' : ''}${edge.value == null ? 'topology only' : `recorded ${+edge.value}`}`;
    line.append(title); edges.append(line);
  }
  const crossings = svg('g', {class:'nand-crossings', 'aria-label':'Wire crossings; no crossing is a junction'});
  crossingMarkers(routes).forEach(point => { crossings.append(svg('circle', {cx:point.x, cy:point.y, r:3.2, class:'nand-crossing', 'data-nand-crossing':''}), svg('path', {d:`M${point.x - 3.5} ${point.y} H${point.x + 3.5}`, class:'nand-crossing-overpass'})); });
  drawing.append(edges, crossings, external);
  const outputLabels = svg('g', {class: 'nand-output-labels'});
  for (const [bit, name] of outputNames.entries()) { const point = outputs.get(name); if (!point) continue; const y = outputBaseY + bit * 18, terminalX = outputStartX + bit * 11, exitX = point.x + 8 + stems.from(outputRouteByName.get(name)) * 3; const producer = outputProducers.get(name) || ''; const wire = svg('path', {d:`M${point.x} ${point.y} H${exitX} V${y} H${terminalX}`,class:'nand-output-wire','data-nand-output-wire':name, 'data-nand-output-from-node':producer}); outputLabels.append(wire); const label = svg('text', {x: terminalX + 4, y: y + 3, class: 'nand-output-label', 'data-nand-output': name}); label.textContent = data.operationName ? `${data.operationName}[${bit}]` : (data.signals?.[name]?.label || `out[${bit}]`); outputLabels.append(label); }
  drawing.append(outputLabels);
  const showSelection = nodeId => { container.querySelectorAll('.nand-gate').forEach(gate => gate.classList.toggle('selected', gate.dataset.nandNode === nodeId)); container.querySelectorAll('[data-nand-edge]').forEach(edge => edge.classList.toggle('selected', edge.dataset.nandFromNode === nodeId || edge.dataset.nandToNode === nodeId)); container.querySelectorAll('[data-nand-output-wire]').forEach(edge => edge.classList.toggle('selected', edge.dataset.nandOutputFromNode === nodeId)); };
  const activate = (node, focus) => { showSelection(node.id); onSelect?.(node); if (focus) requestAnimationFrame(() => container.querySelector(`[data-nand-node="${CSS.escape(node.id)}"]`)?.focus()); };
  nodes.forEach(node => drawing.append(nandShape(node, positions.get(node.id), node.id === selected, activate)));
  showSelection(selected);
  const note = svg('text', {x: 12, y: height - 12, class: 'nand-note'}); note.textContent = data.recorded ? 'Wire states are recorded from this execution frame.' : 'Topology only: no internal NAND values are inferred.'; drawing.append(note);
  const zoom = document.createElement('output'); zoom.className = 'nand-graph-zoom-state'; zoom.setAttribute('aria-live', 'polite');
  const applyZoom = value => { savedZoom = value; if (value === 'fit') { drawing.style.width = '100%'; drawing.style.height = 'auto'; zoom.textContent = 'Fit'; scroll.scrollTo({left: 0, top: 0}); } else { const scale = Math.max(.55, Math.min(2, value)); savedZoom = scale; drawing.style.width = `${width * scale}px`; drawing.style.height = `${height * scale}px`; zoom.textContent = `${Math.round(scale * 100)}%`; } };
  const button = (label, aria, action) => { const control = document.createElement('button'); control.type = 'button'; control.textContent = label; control.setAttribute('aria-label', aria); control.onclick = action; return control; };
  controls.append(button('Fit', 'Fit NAND circuit to inspector width', () => applyZoom('fit')), button('−', 'Zoom NAND circuit out', () => applyZoom(savedZoom === 'fit' ? .75 : Number(savedZoom) - .25)), button('+', 'Zoom NAND circuit in', () => applyZoom(savedZoom === 'fit' ? 1.25 : Number(savedZoom) + .25)), button('100%', 'Show NAND circuit at 100 percent', () => applyZoom(1)), zoom);
  scroll.append(drawing); container.append(controls, scroll); applyZoom(savedZoom); return container;
}

/** Update recorded wire colouring without replacing the graph or its viewport. */
export function updateNandGraph(container, signals, recorded) {
  if (!container) return;
  container.querySelectorAll('[data-nand-signal]').forEach(edge => {
    const signal = edge.dataset.nandSignal;
    const value = signals && Object.hasOwn(signals, signal) ? signals[signal] : null;
    edge.classList.toggle('value-0', recorded && value != null && !+value);
    edge.classList.toggle('value-1', recorded && value != null && +value);
    const title = edge.querySelector('title');
    if (title) title.textContent = `${signal} · ${edge.classList.contains('feedback') ? 'feedback connection · ' : ''}${recorded && value != null
      ? `recorded ${+value}` : 'topology only'}`;
  });
  const note = container.querySelector('.nand-note');
  if (note) note.textContent = recorded
    ? 'Wire states are recorded from this execution frame.'
    : 'Topology only: no internal NAND values are inferred.';
}
