const SVG = 'http://www.w3.org/2000/svg';
let markerSequence = 0;

function element(tag, attributes = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function portIds(ports, direction) {
  const values = ports?.[direction] || [];
  return values.map(port => typeof port === 'string' ? port : port.id).filter(Boolean);
}

function levelsFor(children, connections) {
  const ids = new Set(children.map(child => child.id));
  const level = new Map(children.map(child => [child.id, 0]));
  // Component graphs are expected to be acyclic. Bounded relaxation also keeps
  // malformed registries renderable instead of hanging the inspector.
  for (let pass = 0; pass < children.length; pass += 1) {
    let changed = false;
    for (const wire of connections) {
      if (!ids.has(wire.from) || !ids.has(wire.to)) continue;
      const next = Math.min(children.length - 1, level.get(wire.from) + 1);
      if (next > level.get(wire.to)) { level.set(wire.to, next); changed = true; }
    }
    if (!changed) break;
  }
  return level;
}

function labelFor(registry, id) {
  return registry[id]?.label || id;
}

/** Render any published component registry as an inspectable dataflow SVG. */
export function renderComponentDiagram({component, registry, selectedComponent = null,
                                        activeComponents = [], resultUsage = {}, onInspect = () => {}}) {
  const children = (component?.children || []).map(id => registry?.[id]).filter(Boolean);
  const connections = component?.connections || [];
  const childIds = new Set(children.map(child => child.id));
  const levels = levelsFor(children, connections);
  const byLevel = new Map();
  for (const child of children) {
    const level = levels.get(child.id) || 0;
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(child);
  }

  const inputs = portIds(component?.ports, 'inputs');
  const outputs = portIds(component?.ports, 'outputs');
  const maxRows = Math.max(1, inputs.length, outputs.length,
                           ...[...byLevel.values()].map(items => items.length));
  const width = Math.max(700, 360 + Math.max(1, byLevel.size) * 260);
  const height = Math.max(190, 74 + maxRows * 66);
  const positions = new Map();
  const rowY = (index, count) => 48 + ((index + 1) * (height - 94)) / (count + 1);

  // Leave a dedicated label gutter before input wires.  In particular,
  // "selectors" is wide enough to otherwise cross its own wire.
  inputs.forEach((id, index) => positions.set(id, {x: 92, y: rowY(index, inputs.length), port: true}));
  outputs.forEach((id, index) => positions.set(id, {x: width - 24, y: rowY(index, outputs.length), port: true}));
  const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);
  sortedLevels.forEach((level, column) => {
    const items = byLevel.get(level);
    const x = 195 + column * ((width - 390) / Math.max(1, sortedLevels.length - 1));
    items.forEach((child, index) => positions.set(child.id, {x, y: rowY(index, items.length)}));
  });

  const svg = element('svg', {class: 'component-topology', viewBox: `0 0 ${width} ${height}`,
    role: 'group', 'aria-label': `${component?.label || component?.id || 'Component'} dataflow diagram`});
  const title = element('title');
  const isAlu = component?.id === 'alu';
  const usage = resultUsage.computed
    ? (resultUsage.consumed ? `Result consumed by ${resultUsage.consumer || 'the datapath'}` : 'Result computed but not consumed')
    : 'No result computed';
  title.textContent = `${component?.label || component?.id || 'Component'}${isAlu ? `; ${usage}` : ''}`;
  svg.append(title);

  const markerId = `component-arrow-${markerSequence += 1}`;
  const defs = element('defs');
  const marker = element('marker', {id: markerId, viewBox: '0 0 6 6', refX: 5, refY: 3,
    markerWidth: 5, markerHeight: 5, orient: 'auto'});
  marker.append(element('path', {d: 'M0 0L6 3L0 6Z'})); defs.append(marker); svg.append(defs);

  const downstream = new Set();
  if (isAlu && selectedComponent && childIds.has(selectedComponent)) {
    const pending = [selectedComponent];
    while (pending.length) {
      const id = pending.shift();
      if (downstream.has(id)) continue;
      downstream.add(id);
      for (const wire of connections) {
        if (wire.from === id && childIds.has(wire.to) && !downstream.has(wire.to)) pending.push(wire.to);
      }
    }
  }
  const canonicalSignal = value => String(value || '').toLowerCase()
    .replace(/select(or)?/g, '').replace(/[^a-z0-9]/g, '');
  const selectedSignals = new Set(connections
    .filter(wire => wire.from === selectedComponent && downstream.has(wire.to))
    .map(wire => canonicalSignal(wire.signal)).filter(Boolean));
  const activeIds = new Set(activeComponents || []);
  // The backend names actual active descendants (for example pc.storage.word0).
  // Do not light every child merely because its parent is active: a component
  // root can be active while only one of its published child paths is used.
  const activeChild = id => activeIds.has(id) || [...activeIds]
    .some(active => active.startsWith(`${id}.`));
  const genericWireActive = wire => {
    const fromChild = childIds.has(wire.from) && activeChild(wire.from);
    const toChild = childIds.has(wire.to) && activeChild(wire.to);
    // A wire between two internal blocks belongs to the selected route only
    // when both endpoints are published as active.  Port wires have one
    // external endpoint, so their one active component endpoint is enough.
    if (childIds.has(wire.from) && childIds.has(wire.to)) return fromChild && toChild;
    return fromChild || toChild;
  };
  const isActive = wire => {
    if (!isAlu) return genericWireActive(wire);
    if (!selectedComponent) return false;
    if (!childIds.has(wire.from) && wire.to === selectedComponent) return true;
    if (downstream.has(wire.from) && (downstream.has(wire.to) || outputs.includes(wire.to))) return true;
    if (!childIds.has(wire.from) && downstream.has(wire.to)) {
      const signal = canonicalSignal(wire.signal);
      return selectedSignals.has(signal) || (selectedSignals.size === 0 &&
        connections.filter(item => item.from === wire.from && item.to === wire.to).length === 1);
    }
    return false;
  };

  const pairTotals = new Map();
  for (const wire of connections) {
    const key = `${wire.from}>${wire.to}`;
    pairTotals.set(key, (pairTotals.get(key) || 0) + 1);
  }
  const pairOrdinals = new Map();
  for (const [index, wire] of connections.entries()) {
    const from = positions.get(wire.from), to = positions.get(wire.to);
    if (!from || !to) continue;
    const startX = from.port ? from.x + 6 : from.x + 76;
    const endX = to.port ? to.x - 6 : to.x - 76;
    const pair = `${wire.from}>${wire.to}`, ordinal = pairOrdinals.get(pair) || 0;
    pairOrdinals.set(pair, ordinal + 1);
    const count = pairTotals.get(pair), offset = (ordinal - (count - 1) / 2) * 5;
    const bendX = startX + Math.max(18, (endX - startX) / 2) + offset;
    const route = from.y === to.y && count > 1
      ? `M${startX} ${from.y} H${startX + 12} V${from.y + offset} H${endX - 12} V${to.y} H${endX}`
      : `M${startX} ${from.y} H${bendX} V${to.y} H${endX}`;
    const path = element('path', {class: `component-wire${isActive(wire) ? ' executed' : ''}`,
      d: route,
      'marker-end': `url(#${markerId})`, 'data-component-wire': `${wire.from}>${wire.to}`,
      'data-signal': wire.signal || '', 'aria-label': `${wire.from} to ${wire.to}${wire.signal ? ` via ${wire.signal}` : ''}`});
    // Keep parallel connections independently visible.
    path.style.setProperty('--wire-index', index);
    svg.append(path);
  }

  for (const id of inputs) {
    const point = positions.get(id), dot = element('circle', {cx: point.x, cy: point.y, r: 4});
    const label = element('text', {x: 10, y: point.y - 7, class: 'component-port-label'});
    label.textContent = id; svg.append(dot, label);
  }
  for (const id of outputs) {
    const point = positions.get(id), dot = element('circle', {cx: point.x, cy: point.y, r: 4});
    const label = element('text', {x: point.x - 9, y: point.y - 7,
      class: 'component-port-label', 'text-anchor': 'end'});
    label.textContent = id; svg.append(dot, label);
  }

  for (const child of children) {
    const point = positions.get(child.id), selected = child.id === selectedComponent;
    const active = isAlu ? downstream.has(child.id) : activeChild(child.id);
    const group = element('g', {class: `component-svg-node${active ? ' executed' : ''}`,
      tabindex: 0, role: 'button', 'data-component-id': child.id,
      'aria-label': `Inspect ${child.label || child.id}`});
    group.append(element('rect', {x: point.x - 76, y: point.y - 24, width: 152, height: 48, rx: 5}));
    const label = element('text', {x: point.x, y: point.y - 2}); label.textContent = child.label || child.id;
    const note = element('text', {x: point.x, y: point.y + 14, class: 'component-svg-note'});
    note.textContent = selected ? (isAlu ? 'selected operation' : 'selected component') : active ? 'executing path' : 'topology'; group.append(label, note);
    const inspect = event => { event?.preventDefault(); onInspect(child.id); };
    group.addEventListener('click', inspect);
    group.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); inspect(event); }
    });
    svg.append(group);
  }

  const status = element('text', {x: width - 24, y: 22, 'text-anchor': 'end',
    class: 'component-port-label', 'data-component-usage': ''});
  if (isAlu) { status.textContent = usage; svg.append(status); }
  return svg;
}
