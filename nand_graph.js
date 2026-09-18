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
    stagedNodes.forEach(node => { const stage = stageIndex(node); const row = rows.get(stage) || 0; rows.set(stage, row + 1); positions.set(node.id, {x: 240 + stage * 126, y: 42 + row * 82}); });
    const scalarStart = Math.max(...stagedNodes.map(stageIndex)) + 2;
    nodes.filter(node => stageIndex(node) == null).forEach((node, index) => positions.set(node.id, {x: 240 + (scalarStart + Math.floor(index / 16)) * 126, y: 42 + (index % 16) * 82}));
    return positions;
  }
  // Ordinals are published from the actual gate construction. Grouping the
  // overview in sixteen rows bounds a full 32-bit circuit without inventing
  // stages or connections.
  if (nodes.every(node => Number.isInteger(node.ordinal))) return new Map(nodes.map((node, index) => [node.id, {x: 240 + Math.floor(index / 16) * 118, y: 42 + (index % 16) * 82}]));
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
  for (const [column, entries] of columns) entries.forEach((node, row) => positions.set(node.id, {x: 240 + column * 155, y: 55 + row * 94}));
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
  return {from: from ? {x: from.x + 88, y: from.y + 28} : outputPoints.get(source), to: to ? {x: to.x, y: to.y + (inputB ? 38 : 18)} : outputPoints.get(destination)};
}

function edgePath(from, to) { const middle = Math.max(from.x + 18, from.x + (to.x - from.x) * .54); return `M${from.x} ${from.y} H${middle} V${to.y} H${to.x}`; }

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
  const data = normalise(graph), nodes = data.nodes, positions = nodePositions(nodes);
  const inputNames = [...new Set(data.ports?.inputs || [])], outputNames = data.ports?.outputs || data.outputs || [];
  const inputPoints = new Map(inputNames.map((name, index) => [name, {x: 180, y: 28 + index * 20}]));
  const height = Math.max(210, ...[...positions.values()].map(point => point.y + 100), ...[...inputPoints.values()].map(point => point.y + 22));
  const outputTerminalX = Math.max(...[...positions.values()].map(point => point.x + 115)) + 72;
  const width = Math.max(600, outputTerminalX + 90, ...[...positions.values()].map(point => point.x + 150));
  const container = document.createElement('section'); container.className = 'nand-graph-container';
  const controls = document.createElement('div'); controls.className = 'nand-graph-controls';
  const scroll = document.createElement('div'); scroll.className = 'nand-graph-scroll';
  const drawing = svg('svg', {class: 'nand-graph', viewBox: `0 0 ${width} ${height}`, width, height, role: 'group', 'aria-label': 'Actual NAND gate topology'});
  const caption = svg('title'); caption.textContent = data.recorded ? 'Recorded CSP NAND gate values' : 'CSP NAND topology; internal values were not recorded'; drawing.append(caption);
  const outputs = new Map(nodes.map(node => [node.output, {x: positions.get(node.id).x + 88, y: positions.get(node.id).y + 28}]));
  inputPoints.forEach((point, name) => outputs.set(name, point));
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
  for (const edge of data.edges) {
    const ends = endpoint(edge, positions, outputs); if (!ends.to) continue;
    if (!ends.from) continue;
    const line = svg('path', {d: edgePath(ends.from, ends.to), 'data-nand-edge': `${edge.from}>${edge.to}`, 'data-component-edge': `${edge.from}>${edge.to}`, 'data-nand-signal': edge.from, class: `${edge.value == null ? 'nand-edge' : `nand-edge value-${+edge.value}`}${edge.feedback ? ' feedback' : ''}`});
    const title = svg('title'); title.textContent = `${edge.from} → ${edge.to} · ${edge.feedback ? 'feedback connection · ' : ''}${edge.value == null ? 'topology only' : `recorded ${+edge.value}`}`;
    line.append(title); edges.append(line);
  }
  drawing.append(edges, external);
  const outputLabels = svg('g', {class: 'nand-output-labels'});
  for (const [bit, name] of outputNames.entries()) { const point = outputs.get(name); if (!point) continue; const y = 26 + bit * 20; const wire = svg('path', {d:`M${point.x} ${point.y} H${outputTerminalX - 7} V${y} H${outputTerminalX}`,class:'nand-output-wire','data-nand-output-wire':name}); outputLabels.append(wire); const label = svg('text', {x: outputTerminalX + 5, y: y + 4, class: 'nand-output-label', 'data-nand-output': name}); label.textContent = data.operationName ? `${data.operationName}[${bit}]` : (data.signals?.[name]?.label || `out[${bit}]`); outputLabels.append(label); }
  drawing.append(outputLabels);
  const activate = (node, focus) => { container.querySelectorAll('.nand-gate').forEach(gate => gate.classList.toggle('selected', gate.dataset.nandNode === node.id)); onSelect?.(node); if (focus) requestAnimationFrame(() => container.querySelector(`[data-nand-node="${CSS.escape(node.id)}"]`)?.focus()); };
  nodes.forEach(node => drawing.append(nandShape(node, positions.get(node.id), node.id === selected, activate)));
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
