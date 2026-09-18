import { renderNandGraph, updateNandGraph } from './nand_graph.js';
import { renderComponentDiagram } from './component_diagram.js';
const $=id=>document.getElementById(id), hex=v=>`0x${(Number(v)>>>0).toString(16).toUpperCase().padStart(8,'0')}`;
const BACKEND='gate';
let session,index=0,timer,follow=true,requestId=0,navigationId=0,controller,componentDetail,componentDetailError,componentDetailRequest=0,componentDetailController,componentDetailSession=0,componentDetailProgram,componentDetailSource,componentDetailCache=new Map(),rowsByLine=new Map(),rowsByAddress=new Map(),currentRow,inspectorOpen=false,inspectorTrigger,selectedAdder,selectedComponentGate,selectedInspectorComponent='alu',selectedInspectorNand,genericGraph,staticManifest,staticProgram,staticManifestUrl,staticChunkCache=new Map(),staticChunkRequests=new Map();
const nodes=[['pc',35,55,112,58,'PC'],['memory',35,230,132,62,'Memory'],['ir',215,55,125,58,'Instruction register'],['control',410,55,140,58,'Decode / control'],['registers',640,165,178,66,'Register file · x0–x31'],['immediate',215,165,125,58,'Immediate'],['alu',405,278,132,66,'ALU'],['nextpc',35,405,145,58,'Next PC'],['writeback',640,405,178,58,'Writeback select']];
const wires=[['fetch','M91 113V230 M167 261H190V84H215'],['decode','M340 84H410 M277 113V165H278'],['operands','M640 198H570V311H537 M340 194H380V311H405'],['memory','M405 311H315V261H167'],['writeback','M537 311H620V434H640 M729 405V231'],['load','M167 261H190V434H640'],['pc','M471 344V434H180 M35 434H20V84H35']];
function el(tag,a={}){const e=document.createElementNS('http://www.w3.org/2000/svg',tag);Object.entries(a).forEach(([k,v])=>e.setAttribute(k,v));return e}
function draw(){const root=$('datapath');root.replaceChildren();const title=el('title',{id:'diagram-title'}),desc=el('desc',{id:'diagram-description'});title.textContent='RISC-V multicycle datapath';desc.textContent='Blue paths show selected RV32I data; cyan outlines show storage written at commit.';root.append(title,desc);const defs=el('defs'),marker=el('marker',{id:'arrow',viewBox:'0 0 6 6',refX:'5',refY:'3',markerWidth:'5',markerHeight:'5',orient:'auto'});marker.append(el('path',{d:'M0 0L6 3L0 6Z',fill:'#b9c8d2'}));defs.append(marker);root.append(defs);const g=el('g');wires.forEach(([id,d])=>g.append(el('path',{id:`wire-${id}`,class:'wire',d,'marker-end':'url(#arrow)'})));root.append(g);nodes.forEach(([id,x,y,w,h,name])=>{const attrs={id:`node-${id}`,class:'diagram-node',tabindex:'0',role:'button','aria-label':`Inspect ${name}`,'aria-controls':'alu-inspector','aria-expanded':'false','data-inspector-component':id};const g=el('g',attrs),label=el('text',{x:x+w/2,y:y+25,class:'node-label'}),value=el('text',{x:x+w/2,y:y+45,class:'node-value',id:`value-${id}`});label.textContent=name;value.textContent='—';g.append(el('rect',{x,y,width:w,height:h,rx:'5'}),label,value);const inspect=()=>openInspector(g,id);g.addEventListener('click',inspect);g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();inspect()}});root.append(g)})}
function pause(){clearInterval(timer);timer=null;$('play-icon').textContent='▶';$('play-label').textContent=session&&index===session.frames.length-1?'Replay':'Play'}
let followPending=false;
async function navigate(n){if(!session)return;const token=++navigationId,activeSession=session,target=Math.max(0,Math.min(session.frames.length-1,n));if(staticManifest&&!session.frames[target]){try{await loadStaticFrame(target,activeSession)}catch(error){if(token!==navigationId)return;$('message').className='message error';$('message').textContent=`Saved trace frame could not be loaded: ${error.message}`;return}}if(token!==navigationId||activeSession!==session)return;index=target;followPending=true;render()}
function fitAssemblyEditor(){const editor=$('assembly-source');if(!editor)return;editor.style.height='auto';editor.style.height=`${editor.scrollHeight+editor.offsetHeight-editor.clientHeight}px`}
document.addEventListener('input',event=>{if(event.target.id==='assembly-source')fitAssemblyEditor()});
window.addEventListener('resize',fitAssemblyEditor);
function enable(on){['reset','previous','play','next','next-instruction','scrubber','program'].forEach(id=>$(id).disabled=!on)}
function type(row){if(row.kind)return row.kind;const t=String(row.text||'').trim();return!t?'blank':t.startsWith('#')||t.startsWith(';')?'comment':t.endsWith(':')?'label':row.address==null?'data':'instruction'}
function listing(program){const root=$('listing');root.replaceChildren();rowsByLine=new Map();rowsByAddress=new Map();const f=document.createDocumentFragment();for(const item of program.listing||[]){const row=document.createElement('div'),k=type(item);row.className=`source-row ${k}`;if(item.line!=null){row.dataset.line=item.line;rowsByLine.set(+item.line,row)}if(item.address!=null){row.dataset.address=item.address;if(!rowsByAddress.has(+item.address))rowsByAddress.set(+item.address,row)}const addr=document.createElement('span'),text=document.createElement('span');addr.className='source-address';text.className='source-text';addr.textContent=item.address==null?'':hex(item.address);text.textContent=item.text||' ';row.append(addr,text);if(k==='instruction'&&item.address!=null){row.tabIndex=0;row.setAttribute('role','button');const jump=async()=>{const matching=frame=>+frame.instruction_address===+item.address;const next=staticManifest?await findStaticFrame((frame,position)=>position>index&&frame.instruction_start&&matching(frame),index+1):session.frames.findIndex((frame,position)=>position>index&&frame.instruction_start&&matching(frame));const fallback=next<0?(staticManifest?await findStaticFrame(matching,0):session.frames.findIndex(matching)):next;pause();navigate(fallback<0?0:fallback)};row.onclick=jump;row.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();jump()}}}f.append(row)}root.append(f)}
function registers(frame){const b=frame.before?.regs||frame.before?.registers||[],a=frame.after?.regs||frame.after?.registers||b,root=$('registers');if(root.children.length!==32)root.replaceChildren(...Array.from({length:32},(_,i)=>{const e=document.createElement('div');e.className='register-cell';for(const [c,t] of [['register-name',`x${i}`],['register-value','—'],['register-change','']]){const s=document.createElement('span');s.className=c;s.textContent=t;e.append(s)}return e}));[...root.children].forEach((cell,i)=>{const old=+(b[i]||0),value=+(a[i]||0),changed=old!==value;cell.classList.toggle('changed',changed);cell.querySelector('.register-value').textContent=hex(old);cell.querySelector('.register-change').textContent=changed?`→ ${hex(value)}`:'';cell.title=`x${i}: ${hex(old)} → ${hex(value)}`})}
function text(tag,content,className){const e=document.createElement(tag);if(className)e.className=className;e.textContent=content;return e}
function openInspector(trigger, component){if(!session)return;pause();inspectorOpen=true;inspectorTrigger=trigger||document.activeElement;if(component)selectedInspectorComponent=component;document.querySelectorAll('[data-inspector-component]').forEach(node=>node.setAttribute('aria-expanded',String(node===inspectorTrigger)));document.querySelector('.diagram-container').hidden=true;$('alu-inspector').hidden=false;renderInspector(session.frames[index]);$('alu-close').focus()}
function closeInspector(){if(!inspectorOpen)return;inspectorOpen=false;$('alu-inspector').hidden=true;document.querySelector('.diagram-container').hidden=false;document.querySelectorAll('[data-inspector-component]').forEach(node=>node.setAttribute('aria-expanded','false'));inspectorTrigger?.focus();inspectorTrigger=null}
const expandedChains=new Set(); let selectedTopologyNode,selectedGateNode,selectedGateOutput,selectedGateOperation;
function topologyDiagram(topology,selected){
  const svg=el('svg',{class:'topology-diagram',viewBox:'0 0 360 150',role:'group','aria-label':'Clickable ALU implementation topology'}),pos={add:[12,15],invert_b:[12,95],negate_b:[105,95],sub:[198,95],other:[105,15],select:[278,55]};
  const active=selected==='sub'?new Set(['invert_b>negate_b','negate_b>sub','sub>select']):new Set([`${selected}>select`]);
  const defs=el('defs'),marker=el('marker',{id:'topology-arrow',viewBox:'0 0 6 6',refX:'5',refY:'3',markerWidth:'5',markerHeight:'5',orient:'auto'});marker.append(el('path',{d:'M0 0L6 3L0 6Z'}));defs.append(marker);svg.append(defs);
  for(const edge of topology.edges||[]){const a=pos[edge.from],b=pos[edge.to],key=`${edge.from}>${edge.to}`;if(!a||!b)continue;const route=key==='add>select'?`M${a[0]+66} ${a[1]+15}V5H265Q278 5 278 18V70`:`M${a[0]+66} ${a[1]+15}L${b[0]} ${b[1]+15}`;svg.append(el('path',{d:route,class:active.has(key)?'topology-edge selected':'topology-edge','marker-end':'url(#topology-arrow)','data-topology-edge':key,'data-from':edge.from,'data-to':edge.to}))}
  for(const node of topology.nodes||[]){const id=node.id||node,p=pos[id];if(!p)continue;const g=el('g',{class:`topology-node${id===selected?' selected':''}`,tabindex:'0',role:'button','aria-label':`Inspect ${node.label||id}`, 'data-topology-node':id}),label=el('text',{x:p[0]+33,y:p[1]+19});label.textContent=id;g.append(el('rect',{x:p[0],y:p[1],width:66,height:30,rx:4}),label);const open=focus=>{selectedTopologyNode=id;if(['add','negate_b','sub'].includes(id))expandedChains.add(id);renderInspector(session.frames[index]);requestAnimationFrame(()=>{const detail=$('alu-content').querySelector(`.branch-detail[data-branch="${id}"]`);detail?.scrollIntoView({block:'nearest'});if(focus)detail?.focus();});};g.onclick=()=>open(false);g.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();open(true)}};svg.append(g)}return svg
}
function capturedBit(value,bit){return typeof value==='string'?value[bit]:((Number(value)>>>bit)&1)}
function portValues(values){const list=document.createElement('dl');list.className='captured-ports';for(const [name,value] of Object.entries(values)){const term=text('dt',name),definition=text('dd',value??'—');list.append(term,definition)}return list}
function showFullAdder(name,chain,bit,topology){
  const root=$('alu-content');
  root.querySelector('.full-adder-detail')?.remove();
  const values={a:capturedBit(chain.a,bit),b:capturedBit(chain.b,bit),cin:chain.carry_bits?.[bit],sum:chain.sum_bits?.[bit],cout:chain.carry_bits?.[bit+1]};
  const detail=document.createElement('section');detail.className='full-adder-detail';detail.dataset.chain=name;detail.dataset.bit=bit;
  detail.append(text('h3',`${name} · full adder ${bit}`),text('p','Captured stage ports for this recorded cycle. Internal NAND values are not inferred in the browser.'));
  detail.append(portValues({'a':values.a,'b':values.b,'carry in':values.cin,'sum':values.sum,'carry out':values.cout}));
  const component=topology.components?.full_adder;
  if(component){
    const selected = component.nodes?.find(node => node.id === selectedComponentGate);
    const source = selected?.source || component.nand_source || component.source;
    detail.append(text('h4','Full-adder NAND implementation'),renderNandGraph(component,{selected:selectedComponentGate,onSelect:node=>{selectedComponentGate=node.id;renderInspector(session.frames[index]);requestAnimationFrame(()=>root.querySelector('.component-gate-source')?.focus());}}));
    const sourceDetail=document.createElement('section');sourceDetail.className='component-gate-source';sourceDetail.tabIndex=-1;
    sourceDetail.append(text('h4',`${selected?.label||'NAND'} · ${selected?.id||'gate'} source`),text('p',sourceName(source),'expression-copy'),text('p','Topology only: internal NAND values were not recorded.','inspector-empty'));
    if(source?.file)sourceDetail.append(text('p',`${source.file}${source.line?`:${source.line}`:''}`,'implementation-copy'));
    if(source?.source_code)sourceDetail.append(text('pre',source.source_code,'source-code'));
    detail.append(sourceDetail);
  }else detail.append(text('p','The reusable full-adder implementation definition was not published by this trace.','inspector-empty'));
  root.append(detail)
}
function sourceName(source = {}) { return typeof source === 'string' ? source : [source.module, source.callable].filter(Boolean).join('.') || 'CSP NAND node'; }
function resolveSource(item, topology = session?.arithmetic?.topology) {
  if (typeof item?.source === 'string') return item.source;
  return item?.source || topology?.sources?.[item?.source_ref];
}
function gateSignalValues(operation, values, operationName) {
  if (values?.operation !== operationName) return {};
  if (values?.signals) return values.signals;
  const order = operation?.signal_order || [], bits = values?.values || '';
  return Object.fromEntries(order.flatMap((signal, index) => knownBit(bits, index) == null ? [] : [[signal, knownBit(bits, index)]]));
}
function componentSource(detail, component, title) {
  const source = resolveSource(component) || {};
  detail.append(text('h3', title || `${component?.label || component?.id || 'Component'} source`),
    text('p', sourceName(source), 'expression-copy'));
  if (source?.file) detail.append(text('p', `${source.file}${source.line ? `:${source.line}` : ''}`, 'implementation-copy'));
  if (source?.source_code) detail.append(text('pre', source.source_code, 'source-code'));
}
function knownBit(values, index) {
  return values?.[index] === '1' ? true : values?.[index] === '0' ? false : null;
}
// Public gate traces pack very large global signal vectors.  Keep the decoded
// bytes per frame and address only requested telemetry indices; expanding a
// RAM capture to a JavaScript bitstring would defeat the transport saving.
const packedInspectionBytes = new WeakMap();
function packedBytes(inspection, field) {
  let cached = packedInspectionBytes.get(inspection);
  if (!cached) { cached = {}; packedInspectionBytes.set(inspection, cached); }
  if (cached[field]) return cached[field];
  try {
    const binary = atob(inspection[field] || '');
    cached[field] = Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch (_) { cached[field] = new Uint8Array(); }
  return cached[field];
}
function inspectionBit(inspection, position) {
  if (!Number.isInteger(position) || position < 0) return null;
  if (inspection?.encoding !== 'packed-bits-v1') return knownBit(inspection?.values, position);
  if (position >= Number(inspection.signal_count)) return null;
  const bit = 7 - (position % 8), byte = Math.floor(position / 8);
  const valid = inspection.valid ? packedBytes(inspection, 'valid') : null;
  if (valid && !(valid[byte] & (1 << bit))) return null;
  return Boolean(packedBytes(inspection, 'values')[byte] & (1 << bit));
}
function componentTelemetry(component, graph, inspection) {
  const sample = inspection?.components?.[component.id];
  const telemetryOrder = graph?.telemetry_order?.length ? graph.telemetry_order : component?.circuit?.telemetry_order || [];
  const signalOrder = graph?.signal_order?.length ? graph.signal_order : component?.circuit?.signal_order || telemetryOrder;
  const detail = componentDetail?.component === component?.id && componentDetail?.frame === index ? componentDetail : null;
  if (detail && typeof detail.values === 'string' && Array.isArray(detail.signal_order)) { const signals=Object.fromEntries(detail.signal_order.flatMap((name, position) => knownBit(detail.values, position) == null ? [] : [[name, knownBit(detail.values, position)]])); return {signals, recorded:Object.keys(signals).length > 0, capturedFrame:detail.frame}; }
  if (sample?.recorded && typeof sample.values === 'string' && telemetryOrder.length) { const signals=Object.fromEntries(telemetryOrder.flatMap((name, position) => knownBit(sample.values, position) == null ? [] : [[name, knownBit(sample.values, position)]])); return {signals, recorded:Object.keys(signals).length > 0}; }
  const global = inspection?.values, indices = graph?.telemetry_indices || graph?.global_indices || component?.circuit?.telemetry_indices || component?.circuit?.global_indices;
  if (typeof global !== 'string' || !indices || !signalOrder.length) return {signals:{}, recorded:false};
  const signals = Object.fromEntries(signalOrder.flatMap((name, index) => {
    const position = Array.isArray(indices) ? indices[index] : indices[name];
    const value = inspectionBit(inspection, position);
    return value == null ? [] : [[name, value]];
  }));
  return {signals, recorded:Object.keys(signals).length > 0};
}
function inspectGenericComponent(id) {
  selectedInspectorComponent = id;
  selectedInspectorNand = null;
  genericGraph = null;
  requestRamDetail(id);
  renderInspector(session.frames[index]);
}
function componentBoundary(detail, component, inspection) {
  const boundary = component?.boundary;
  if (!boundary && !component?.implementation) return;
  const section = document.createElement('section'); section.className = 'component-boundary branch-detail';
  const nandStorage = component?.implementation === 'nand_storage' || boundary?.kind === 'nand_storage';
  const actualNands = component?.circuit?.nodes?.some(node => node.kind === 'nand');
  const description = boundary?.description || (nandStorage
    ? 'Seeded feedback and low-phase publication are explicit adapters around the actual NAND storage cells shown above.'
    : actualNands
      ? 'This published circuit is implemented by the actual NAND gates shown above.'
    : `Published boundary: ${boundary?.kind || component.implementation}. No NAND expansion is claimed here.`);
  section.append(text('h3', nandStorage ? 'NAND storage details' : actualNands ? 'NAND implementation' : 'Implementation boundary'), text('p', description, nandStorage || actualNands ? 'implementation-copy' : 'inspector-empty'));
  if (component.implementation) section.append(text('p', `Implementation: ${component.implementation}`, 'implementation-copy'));
  const {signals, recorded} = componentTelemetry(component, component?.circuit, inspection), order = component?.circuit?.telemetry_order || [];
  if (recorded && order.length) section.append(portValues(Object.fromEntries(order.map(name => [name, Object.hasOwn(signals, name) ? String(+signals[name]) : 'not recorded']))));
  else section.append(text('p', nandStorage ? 'The displayed NAND cells are real; this frame has no settled value for every requested cell signal.' : 'No live internal values are inferred for this boundary.', 'inspector-empty'));
  detail.append(section);
}
function componentInspectorCopy(component) {
  if (component.id.startsWith('pc')) return 'Program-counter storage is shown as seeded NAND cells with a low-phase publication boundary.';
  if (component.id.startsWith('ir')) return 'The instruction register samples fetch data through clocked seeded NAND storage.';
  if (component.id.startsWith('registers')) return 'Register-file words and bits are inspectable NAND storage cells.';
  if (component.id.startsWith('memory')) return 'Bounded RAM banks expose decoded NAND storage, read muxes, and selected cell values.';
  return `Inspect the published implementation and recorded signals for ${component.label || component.id}.`;
}
function componentIsActive(componentId, active) {
  return active.some(id => id === componentId || componentId.startsWith(`${id}.`) || id.startsWith(`${componentId}.`));
}
function componentGraph(component, topology) {
  const circuit = component?.circuit || {};
  if (circuit.nodes) return circuit;
  return topology.operations?.[circuit.operation] || topology.operations?.[circuit.operation_ref];
}
function genericSignals(component, graph, arithmetic, inspection) {
  if (!component || !graph || !arithmetic) return {signals:{}, recorded:false};
  const telemetry = componentTelemetry(component, graph, inspection);
  if (telemetry.recorded) return telemetry;
  if (arithmetic.selection_values?.component === component.id) {
    const values = arithmetic.selection_values || {};
    const order = values.signal_order || graph.signal_order || [];
    const bits = values.values || '';
    const signals = Object.fromEntries(order.flatMap((name, i) => knownBit(bits, i) == null ? [] : [[name, knownBit(bits, i)]]));
    return {signals, recorded:Object.keys(signals).length > 0};
  }
  const operation = graph.operation || component.circuit?.operation || component.circuit?.operation_ref;
  return {signals:gateSignalValues(graph, arithmetic.gate_values, operation), recorded:arithmetic.selected_component === component.id && arithmetic.gate_values?.operation === operation};
}
function componentPath(rootId, targetId, registry, trail = []) {
  if (rootId === targetId) return [...trail, rootId];
  for (const child of registry[rootId]?.children || []) {
    if (!registry[child]) continue;
    const found = componentPath(child, targetId, registry, [...trail, rootId]);
    if (found) return found;
  }
}
function renderGenericInspector(frame) {
  const arithmetic = frame.arithmetic || {}, topology = session.arithmetic?.topology || {}, registry = topology.components || {};
  const inspection = frame.inspection || arithmetic.inspection || {};
  const rootId = topology.root || 'alu';
  if (!registry[rootId]) return false;
  if (!registry[selectedInspectorComponent]) selectedInspectorComponent = rootId;
  const staticComponent = registry[selectedInspectorComponent];
  const current = componentDetail?.component === staticComponent.id && componentDetail?.frame === index && componentDetail?.circuit ? {...staticComponent, circuit:componentDetail.circuit} : staticComponent;
  const graph = componentGraph(current, topology), root = $('alu-content');
  $('alu-inspector-title').textContent = `${current.label || current.id} inspector`;
  document.querySelector('.inspector-copy').textContent = componentInspectorCopy(current);
  requestRamDetail(current.id);
  const {signals, recorded} = genericSignals(current, graph, arithmetic, inspection);
  // Stepping must refresh recorded values while retaining the same graph, zoom,
  // scroll position, and DOM node identities for a browsed NAND implementation.
  if (genericGraph?.component === current.id && root.contains(genericGraph.container)) {
    genericGraph.refresh({signals, recorded, arithmetic, inspection});
    root.querySelectorAll('[data-component-execution]').forEach(node => {
      const active = inspection.active_components || (arithmetic.selected_component ? [arithmetic.selected_component] : []);
      node.textContent = current.id === rootId ? `Active components: ${active.join(', ') || 'none'}` : `${componentIsActive(current.id, active) ? 'Active this cycle' : 'Not active this cycle'} · ${recorded ? 'recorded values' : 'topology only'}`;
    });
    root.querySelectorAll('[data-component-consumed]').forEach(node => {
      const use = arithmetic.result_usage || {};
      node.textContent = use.computed ? (use.consumed ? `Consumed by ${use.consumer || 'the datapath'}` : 'Computed but not consumed') : 'No result was computed this cycle';
    });
    return true;
  }
  genericGraph = null; root.replaceChildren();
  const crumb = document.createElement('nav'); crumb.className = 'inspector-breadcrumbs'; crumb.setAttribute('aria-label', 'Component inspector location');
  const home = document.createElement('button'); home.type = 'button'; home.textContent = 'CPU'; home.onclick = () => closeInspector(); crumb.append(home, text('span', '/'));
  const path = componentPath(rootId, current.id, registry) || [rootId];
  path.forEach((id, position) => { if (position) crumb.append(text('span', '/')); const item=registry[id]; if (position === path.length-1) crumb.append(text('strong',item.label||id)); else { const button=document.createElement('button');button.type='button';button.textContent=item.label||id;button.onclick=()=>inspectGenericComponent(id);crumb.append(button); } });
  root.append(crumb);
  const banner = document.createElement('section'); banner.className = 'alu-selection';
  const use = arithmetic.result_usage || {};
  const hasChildren = (current.children || []).some(id => registry[id]);
  const active = inspection.active_components || (arithmetic.selected_component ? [arithmetic.selected_component] : []);
  const execution = text('small', current.id === rootId ? `Active components: ${active.join(', ') || 'none'}` : `${componentIsActive(current.id, active) ? 'Active this cycle' : 'Not active this cycle'} · ${recorded ? 'recorded values' : 'topology only'}`); execution.dataset.componentExecution='';
  banner.append(text('span', hasChildren ? 'COMPONENT OVERVIEW' : 'COMPONENT INSPECTION', 'eyebrow'), text('strong', current.label || current.id), execution);
  if (current.id === 'alu') { const consumed = text('small', use.computed ? (use.consumed ? `Consumed by ${use.consumer || 'the datapath'}` : 'Computed but not consumed') : 'No result was computed this cycle', 'component-usage'); consumed.dataset.componentConsumed=''; banner.append(consumed); }
  if (componentDetailError?.component === current.id && componentDetailError?.frame === index) banner.append(text('small', `RAM capture unavailable: ${componentDetailError.message}. Showing topology with unrecorded values.`, 'inspector-empty'));
  root.append(banner);
  if (hasChildren) {
    const overview = document.createElement('section'); overview.className = 'component-overview'; overview.append(text('h3', `${current.label || current.id} blocks · select a component`));
    overview.append(renderComponentDiagram({component:current, registry, selectedComponent:arithmetic.selected_component, activeComponents:active, resultUsage:arithmetic.result_usage, onInspect:inspectGenericComponent})); root.append(overview); const detail = document.createElement('section'); detail.className = 'branch-detail'; componentSource(detail, current, `${current.label || current.id} graph source`); componentBoundary(detail, current, inspection); root.append(detail); return true;
  }
  if (!graph?.nodes?.length) { const source=document.createElement('section');source.className='branch-detail';componentSource(source,current,`${current.label || current.id} graph source`);componentBoundary(source,current,inspection);root.append(source,text('p', 'This primitive has no NAND expansion in the published topology.', 'inspector-empty')); return true; }
  const graphData = {...graph, recorded, edges:(graph.edges || []).map(edge => ({...edge, value:Object.hasOwn(signals, edge.from) ? signals[edge.from] : null}))};
  const graphDetail = document.createElement('section'); graphDetail.className = 'gate-detail'; graphDetail.append(text('h3', 'Actual NAND implementation · select a gate'));
  const graphSource = document.createElement('section'); graphSource.className = 'graph-source branch-detail'; componentSource(graphSource, current, `${current.label || current.id} graph source`); componentBoundary(graphSource, current, inspection);
  const nodeSource = document.createElement('section'); nodeSource.className = 'gate-source branch-detail'; nodeSource.tabIndex = -1;
  const showSource = (item, state) => { nodeSource.replaceChildren(); nodeSource.hidden = !item; if (!item) return; componentSource(nodeSource, item, `${item.label || 'NAND'} · ${item.id} source`); const inputs = Object.fromEntries((item.inputs || []).map((name, i) => [`input ${i ? 'b' : 'a'}`, Object.hasOwn(state.signals, name) && state.recorded ? String(+state.signals[name]) : 'not recorded'])); nodeSource.append(portValues({...inputs, output:Object.hasOwn(state.signals, item.output) && state.recorded ? String(+state.signals[item.output]) : 'not recorded'})); };
  const selected = graph.nodes.find(item => item.id === selectedInspectorNand), liveState = {signals, recorded};
  const rendered = renderNandGraph(graphData, {selected:selected?.id, onSelect:item => { selectedInspectorNand = item.id; showSource(item, liveState); }}); graphDetail.append(rendered); root.append(graphDetail, graphSource); showSource(selected, liveState); root.append(nodeSource); genericGraph = {component:current.id, container:rendered, refresh:state => { liveState.signals=state.signals; liveState.recorded=state.recorded; updateNandGraph(rendered, state.signals, state.recorded); showSource(graph.nodes.find(item=>item.id===selectedInspectorNand), liveState); }}; return true;
}
function renderGateInspector(root, arithmetic) {
  const recordedOperation = arithmetic.gate_values?.operation || arithmetic.operation;
  const operations = session.arithmetic?.topology?.operations || {};
  if (!selectedGateOperation || !operations[selectedGateOperation]) selectedGateOperation = recordedOperation;
  const operationName = selectedGateOperation;
  const operation = session.arithmetic?.topology?.operations?.[operationName];
  const signals = gateSignalValues(operation, arithmetic.gate_values, operationName);
  if (!operation?.nodes?.length) { root.append(text('p', 'This recorded gate operation has no published NAND topology.', 'inspector-empty')); return; }
  const outputs = operation.outputs || [];
  if (!selectedGateOutput || !outputs.includes(selectedGateOutput)) selectedGateOutput = outputs[0];
  const outputRoot = operation.nodes.find(node => node.output === selectedGateOutput)?.id;
  if (!selectedGateNode || !operation.nodes.some(node => node.id === selectedGateNode)) selectedGateNode = outputRoot || operation.root || operation.nodes.at(-1)?.id;
  const recorded = arithmetic.gate_values?.recorded && operationName === recordedOperation;
  const fullGraph = {...operation, operationName, recorded, edges: (operation.edges || []).map(edge => ({...edge, value: Object.hasOwn(signals, edge.from) ? signals[edge.from] : null}))};
  const selected = operation.nodes.find(node => node.id === selectedGateNode);
  const heading = document.createElement('section'); heading.className = 'alu-selection';
  heading.append(text('span', recorded ? 'RECORDED GATE-LEVEL NAND EVALUATION' : 'GATE-LEVEL NAND TOPOLOGY', 'eyebrow'), text('strong', `${operationName} · ${recorded ? 'recorded values' : 'topology only'}`), text('small', `${operation.nodes.length} actual gates · ${outputs.length} outputs`)); root.append(heading);
  const diagram = document.createElement('section'); diagram.className = 'gate-detail'; diagram.append(text('h3', 'Actual NAND gates · select a gate'));
  const operationPicker = document.createElement('label'); operationPicker.className = 'gate-output-picker'; operationPicker.append(text('span', 'OPERATION'), (() => { const select = document.createElement('select'); select.setAttribute('aria-label', 'Choose NAND operation'); Object.keys(operations).sort().forEach(name => { const option = document.createElement('option'); option.value = name; option.textContent = name; select.append(option); }); select.value = operationName; select.onchange = () => { selectedGateOperation = select.value; selectedGateNode = null; selectedGateOutput = null; renderInspector(session.frames[index]); }; return select; })()); diagram.append(operationPicker);
  if (outputs.length > 1) { const chooser = document.createElement('label'); chooser.className = 'gate-output-picker'; chooser.append(text('span', 'OUTPUT BIT'), (() => { const select = document.createElement('select'); select.setAttribute('aria-label', 'Choose recorded NAND output bit'); outputs.forEach((signal, bit) => { const option = document.createElement('option'); option.value = signal; option.textContent = `bit ${bit}`; select.append(option); }); select.value = selectedGateOutput; select.onchange = () => { selectedGateOutput = select.value; selectedGateNode = operation.nodes.find(node => node.output === selectedGateOutput)?.id; renderInspector(session.frames[index]); }; return select; })()); diagram.append(chooser); }
  const graphSource = document.createElement('section'); graphSource.className = 'graph-source branch-detail'; componentSource(graphSource, operation, `${operationName} graph source`);
  const detail = document.createElement('section'); detail.className = 'gate-source branch-detail'; detail.tabIndex = -1; detail.dataset.gateSource = selected?.id || '';
  const liveState = {signals, recorded};
  const fillSource = node => { detail.replaceChildren(); detail.dataset.gateSource = node?.id || ''; detail.hidden = !node; if (!node) return; const location = resolveSource(node) || resolveSource(operation) || session.arithmetic?.topology?.source; detail.append(text('h3', `${node.label || 'NAND'} · ${node.id} source`), text('p', sourceName(location), 'expression-copy')); const inputs = Object.fromEntries((node.inputs || []).map((signal, number) => [`input ${number ? 'b' : 'a'}`, Object.hasOwn(liveState.signals, signal) && liveState.recorded ? String(+liveState.signals[signal]) : 'not recorded'])); detail.append(portValues({...inputs, output:Object.hasOwn(liveState.signals, node.output) && liveState.recorded ? String(+liveState.signals[node.output]) : 'not recorded'})); if (location?.file) detail.append(text('p', `${location.file}${location.line ? `:${location.line}` : ''}`, 'implementation-copy')); if (location?.source_code) detail.append(text('pre', location.source_code, 'source-code')); };
  const rendered = renderNandGraph(fullGraph, {selected: selectedGateNode, onSelect: node => { selectedGateNode = node.id; fillSource(node); }}); diagram.append(rendered); root.append(diagram, graphSource);
  fillSource(selected);
  root.append(detail);
}
function renderInspector(frame) {
  if (!inspectorOpen) return;
  if (renderGenericInspector(frame)) return;
  $('alu-inspector-title').textContent = 'Captured ALU paths';
  document.querySelector('.inspector-copy').textContent = 'Every path below was evaluated for this recorded graph state. The ALU mux selects one result; that result may not be architecturally consumed in this phase.';
  const root = $('alu-content'), arithmetic = frame.arithmetic;
  root.replaceChildren();
  if (!arithmetic) {
    const metadata=session.arithmetic||{};
    root.append(text('p', metadata.capabilities?.alu_inspection === false
      ? 'The gate-level run does not record deep ALU inspection telemetry; this view is unavailable for the selected backend.'
      : 'This cycle has no ALU evaluation.', 'inspector-empty'));
    return;
  }
  if (arithmetic.backend === 'gate' || arithmetic.gate_values) { renderGateInspector(root, arithmetic); return; }
  const selected = arithmetic.selected || {}, topology = session.arithmetic?.topology || {};
  if (!selectedTopologyNode) selectedTopologyNode = selected.path;
  const selection = document.createElement('section'); selection.className = 'alu-selection';
  selection.append(text('span', 'ALU MUX OUTPUT FOR RECORDED GRAPH EVALUATION', 'eyebrow'),
    text('strong', `${selected.path || '—'} · ${hex(selected.value)}`),
    text('small', `cycle ${arithmetic.cycle} · ${arithmetic.operation} · a ${hex(arithmetic.a)} · b ${hex(arithmetic.b)}`));
  root.append(selection);
  const overview = document.createElement('section'); overview.className = 'alu-overview';
  overview.append(text('h3', 'ALU implementation · choose a node'), topologyDiagram(topology, selected.path)); root.append(overview);
  const paths = document.createElement('section'); paths.className = 'alu-paths'; paths.append(text('h3', 'Paths evaluated by the graph'));
  for (const [name, path] of Object.entries(arithmetic.paths || {})) {
    const row = document.createElement('button'); row.type='button'; row.className = `alu-path${name === selected.path ? ' selected' : ''}`;row.dataset.aluPath=name;
    row.append(text('span', name), text('code', hex(path.value)), text('small', 'evaluated'));
    if (path.carry_out != null) row.append(text('small', `carry out ${+path.carry_out}`));
    row.onclick=()=>{selectedTopologyNode=name;renderInspector(frame)};
    paths.append(row);
  }
  root.append(paths);
  const node=(topology.nodes||[]).find(item=>(item.id||item)===selectedTopologyNode)||{id:selectedTopologyNode};
  const detail=document.createElement('section');detail.className='branch-detail';detail.dataset.branch=node.id;detail.tabIndex=-1;
  const crumbs=document.createElement('nav');crumbs.className='inspector-breadcrumbs';crumbs.setAttribute('aria-label','ALU inspector location');
  const home=document.createElement('button');home.type='button';home.textContent='ALU';home.onclick=()=>{selectedTopologyNode=selected.path;selectedAdder=null;renderInspector(frame)};crumbs.append(home,text('span','/'),text('strong',node.label||node.id));
  if(selectedAdder?.name===node.id){crumbs.append(text('span','/'),text('strong',`full adder ${selectedAdder.bit}`));}
  detail.append(crumbs,text('h3',`${node.label||node.id} implementation`));
  if(node.implementation)detail.append(text('p',node.implementation,'implementation-copy'));
  if(node.source)detail.append(text('p',node.source,'expression-copy'));
  if(node.expression)detail.append(text('p',node.expression,'expression-copy'));
  if(node.source_code){const source=text('pre',node.source_code,'source-code');if(node.implementation==='ripple_full_adder'){const disclosure=document.createElement('details');disclosure.className='source-disclosure';disclosure.append(text('summary','Show structural adder source'),source);detail.append(disclosure)}else detail.append(source);}
  const branch=arithmetic.paths?.[node.id];
  if(branch)detail.append(portValues({'recorded output':hex(branch.value),...(branch.carry_out!=null?{'recorded carry out':String(+branch.carry_out)}:{})}));
  root.append(detail);
  if (!arithmetic.structural) { detail.append(text('p', 'Word backend: this is a captured behavioral word node; no structural gate component was evaluated.', 'inspector-empty')); return; }
  const chains = arithmetic.structural.chains, section = document.createElement('section'); section.className = 'structural-chains';
  const chainMetas=(topology.chains||[]).filter(meta=>meta.id===selectedTopologyNode);
  if(!chainMetas.length){detail.append(text('p','This selected node is behavioral or control mapping. Its source expression and recorded output are shown above; it has no fabricated gate expansion.','inspector-empty'));return;}
  section.append(text('h3', 'Structural ripple chains · bit order lsb0'));
  for (const meta of chainMetas) {
    const chain = chains[meta.id], block = document.createElement('div'); if (!chain) continue;
    block.className = 'chain-block'; const heading = document.createElement('div'); heading.className = 'chain-heading';
    const toggle = document.createElement('button'); toggle.className = 'chain-toggle';
    toggle.textContent = expandedChains.has(meta.id) ? 'Hide full adders' : 'Show 32 full adders';
    toggle.onclick = () => { expandedChains.has(meta.id) ? expandedChains.delete(meta.id) : expandedChains.add(meta.id); renderInspector(frame); };
    heading.append(text('strong', meta.id), text('span', `${meta.stages.length} full adders · each opens the reusable NAND component`), toggle); block.append(heading);
    if (expandedChains.has(meta.id)) {
      const groups = document.createElement('div'); groups.className = 'adder-groups';
      for (let offset = 0; offset < meta.stages.length; offset += 8) {
        const group = document.createElement('div'); group.className = 'adder-group'; group.append(text('span', `bits ${offset}–${offset + 7}`, 'eyebrow'));
        for (const stage of meta.stages.slice(offset, offset + 8)) { const button = document.createElement('button'); button.className = `adder-stage${selectedAdder?.name===meta.id&&selectedAdder?.bit===stage.bit?' selected':''}`; button.dataset.chain=meta.id;button.dataset.bit=stage.bit;button.append(text('span',`FA ${stage.bit}`),text('small',`c${stage.bit} ${chain.carry_bits?.[stage.bit]} → c${stage.bit+1} ${chain.carry_bits?.[stage.bit+1]}`,'stage-carry'));button.onclick = () => {selectedAdder={name:meta.id,bit:stage.bit};renderInspector(frame);root.querySelector('.full-adder-detail')?.scrollIntoView({block:'nearest'});}; group.append(button); }
        groups.append(group);
      }
      block.append(groups);
    }
    section.append(block);
  }
  root.append(section);
  if (selectedAdder && chains[selectedAdder.name] && selectedAdder.name===selectedTopologyNode) showFullAdder(selectedAdder.name, chains[selectedAdder.name], selectedAdder.bit,topology);
}
function render(){if(!session)return;const f=session.frames[index],b=f.before||{},a=f.after||b,ns=new Set(f.active_nodes||f.activeNodes||[]),ws=new Set(f.active_wires||f.active_paths||f.activeWires||[]);$('scrubber').value=index;$('cycle-count').textContent=index+1;$('cycle-total').textContent=`${session.frames.length} cycles`;$('phase').textContent=String(f.phase||'EXECUTE').toUpperCase();$('state-id').textContent=`Cycle ${b.cycle??index}`;$('operation-state').textContent=b.cycle??index;$('operation-title').textContent=f.operation||f.title||`${$('phase').textContent} operation`;$('operation-description').textContent=f.description||'Selected datapath values are shown before this cycle commits.';$('instruction-address').textContent=f.instruction_address==null?'—':hex(f.instruction_address);$('retired').hidden=!(f.retired||f.phase==='WRITEBACK');nodes.forEach(([id])=>{const e=$(`node-${id}`),changed=id==='registers'&&JSON.stringify(b.regs||b.registers)!==JSON.stringify(a.regs||a.registers);e.classList.toggle('active',ns.has(id));e.classList.toggle('write',(f.write_nodes||[]).includes(id)||changed)});wires.forEach(([id])=>$(`wire-${id}`).classList.toggle('active',ws.has(id)));const vals={pc:hex(b.pc||0),memory:f.paths?.address==null?'instruction / data':hex(f.paths.address),ir:hex(b.ir||0),control:f.control?.op||f.controls?.op||f.phase,registers:'32 × 32-bit',immediate:f.control?.immediate==null?'sign extend':hex(f.control.immediate),alu:f.paths?.alu==null?'selected operand':hex(f.paths.alu),nextpc:hex(a.pc||0),writeback:f.control?.writeback||f.controls?.writeback||'select'};Object.entries(vals).forEach(([id,v])=>{const e=$(`value-${id}`);if(e)e.textContent=v});const controls=f.control||f.controls||{},chips=$('control-signals');chips.replaceChildren(...Object.entries(controls).filter(([,v])=>v!==false&&v!=null&&v!=='').slice(0,10).map(([n,v])=>{const e=document.createElement('span');e.className=`control-signal ${v===true?'enabled':''}`;e.textContent=v===true?n:`${n}: ${v}`;return e}));const row=rowsByAddress.get(+f.instruction_address)||rowsByLine.get(+f.source_line);if(row!==currentRow){currentRow?.classList.remove('current');currentRow?.removeAttribute('aria-current');row?.classList.add('current');row?.setAttribute('aria-current','step');currentRow=row}if(follow&&followPending&&row&&!inspectorOpen)row.scrollIntoView({block:'nearest',inline:'nearest'});followPending=false;registers(f);if(inspectorOpen)renderInspector(f);$('previous').disabled=index===0;$('next').disabled=index===session.frames.length-1;$('next-instruction').disabled=index===session.frames.length-1;if(!timer)$('play-label').textContent=index===session.frames.length-1?'Replay':'Play'}
function results(summary = {}) {
  const root = $('program-result');
  root.replaceChildren();
  const matrix = summary.matrix;
  if (matrix && Number.isInteger(matrix.size)) {
    [['A', matrix.a], ['B', matrix.b], ['C', matrix.result]].forEach(([name, values], index) => {
      if (index) {
        const op = document.createElement('span'); op.className = 'matrix-operator';
        op.textContent = index === 1 ? '×' : '='; root.append(op);
      }
      const group = document.createElement('div'); group.className = 'matrix-group';
      const label = document.createElement('span'); label.className = 'matrix-label'; label.textContent = name;
      const cells = document.createElement('div'); cells.className = 'matrix' + (index === 2 ? ' result' : '');
      cells.style.gridTemplateColumns = `repeat(${matrix.size}, 1fr)`;
      for (const value of values) { const cell = document.createElement('span'); cell.textContent = Number(value) | 0; cells.append(cell); }
      group.append(label, cells); root.append(group);
    });
  } else {
    const out = document.createElement('div'); out.className = 'simple-result';
    out.textContent = summary.result || 'No result was recorded.'; root.append(out);
  }
  $('verification').textContent = summary.verified ? 'Matches golden output' : (summary.stop_reason || 'Recorded run');
  const trap = summary.trap && (summary.trap.cause || summary.trap.message);
  const stop = trap ? `Stopped: ${trap}. ` : summary.stop_reason === 'cycle_limit' ? 'Partial trace: cycle limit reached. ' : '';
  $('result-note').textContent = `${stop}${summary.instructions || 0} instructions · ${summary.cycles || 0} cycles. Scrubbing changes the view, not the recorded execution.`;
}

function apply(data,program,captureSource){if(!data?.frames?.length){session=null;enable(false);results(data.summary||data);listing({listing:data.listing||data.program?.listing||[]});$('message').className='message error';$('message').textContent=data.summary?.trap?.cause||data.trap?.cause||data.summary?.stop_reason||'Execution stopped before a trace frame was produced.';$('program').disabled=false;return}componentDetailController?.abort();componentDetailSession++;componentDetailCache=new Map();componentDetail=null;componentDetailError=null;componentDetailProgram=program;componentDetailSource=captureSource;session=data;index=0;selectedAdder=null;selectedComponentGate=null;selectedTopologyNode=null;selectedGateNode=null;selectedGateOutput=null;selectedGateOperation=null;selectedInspectorComponent=null;selectedInspectorNand=null;genericGraph=null;expandedChains.clear();pause();listing({listing:data.listing||data.program?.listing||[]});$('source-file').textContent=data.program?.title||data.program?.id||`${program}.s`;$('scrubber').max=data.frames.length-1;enable(true);results(data.summary);const warn=data.warning||data.summary?.warning;$('message').className=`message${warn?' error':''}`;$('message').textContent=warn||`${data.summary?.instructions??'Trace'} instructions · ${data.summary?.cycles??data.frames.length} cycles · ${data.summary?.backend??'RV32I'} datapath`;render()}
async function requestRamDetail(component) {
  if (!session || !component.startsWith('memory.')) return;
  const frame = index;
  // Static chunks include the same packed global vector plus RAM circuit
  // indices, so componentTelemetry can project selected RAM signals locally.
  if (staticManifest) return;
  if (!(session.frames[frame].inspection || session.frames[frame].arithmetic?.inspection)) {
    componentDetailError = {component, frame, scopeKey:`${componentDetailSession}:${frame}:${component}`, message:'this phase has no recorded RAM capture'};
    return;
  }
  if (componentDetail?.component === component && componentDetail?.frame === frame) return;
  const scopeKey = `${componentDetailSession}:${frame}:${component}`, cached = componentDetailCache.get(scopeKey);
  if (cached) { componentDetail = cached; return; }
  if (componentDetailError?.scopeKey === scopeKey) return;
  componentDetailController?.abort();
  componentDetailController = new AbortController();
  const request = ++componentDetailRequest, detailSession = componentDetailSession, detailController = componentDetailController, backend = BACKEND, program = componentDetailProgram;
  try {
    let response;
    if (program === 'custom') response = await fetch('/api/assemble', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({source:componentDetailSource, backend, inspect_component:component, frame}), signal:detailController.signal});
    else response = await fetch(`/api/session?program=${encodeURIComponent(program)}&backend=${encodeURIComponent(backend)}&inspect_component=${encodeURIComponent(component)}&frame=${frame}`, {signal:detailController.signal});
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    const detail = (await response.json()).inspection_detail;
    if (request !== componentDetailRequest || detailSession !== componentDetailSession || !detail || detail.component !== component || detail.frame !== frame) return;
    componentDetailCache.set(scopeKey, detail);
    componentDetail = detail;
    if (inspectorOpen && selectedInspectorComponent === component && index === frame) renderInspector(session.frames[index]);
  } catch (error) {
    if (error.name === 'AbortError' || request !== componentDetailRequest || detailSession !== componentDetailSession) return;
    componentDetailError = {component, frame, scopeKey, message:error.message || 'request failed'};
    if (inspectorOpen && selectedInspectorComponent === component && index === frame) renderInspector(session.frames[index]);
  }
}
function staticUrl(path) { return new URL(path, staticManifestUrl).href; }
async function staticJson(path) {
  const response = await fetch(staticUrl(path));
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (gzip) {
    if (!globalThis.DecompressionStream) throw Error('this browser cannot read gzip-compressed saved traces');
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json();
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function staticChunk(chunk) {
  const url = staticUrl(chunk.path);
  if (staticChunkCache.has(url)) return staticChunkCache.get(url);
  if (staticChunkRequests.has(url)) return staticChunkRequests.get(url);
  const request = (async () => {
    const response = await fetch(url);
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
    if (gzip && !globalThis.DecompressionStream) throw Error('this browser cannot read gzip-compressed saved traces');
    const frames = gzip ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json()
      : JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(frames) || frames.length !== chunk.frame_count) throw Error('invalid saved trace chunk');
    staticChunkCache.set(url, frames); staticChunkRequests.delete(url);
    return frames;
  })();
  staticChunkRequests.set(url, request);
  try { return await request; } catch (error) { staticChunkRequests.delete(url); throw error; }
}
async function loadStaticFrame(frame, targetSession = session, entry = staticProgram) {
  const descriptor = entry?.frames;
  const chunk = descriptor?.chunks?.find(item => frame >= item.first_frame && frame < item.first_frame + item.frame_count);
  if (!chunk) throw Error(`frame ${frame} is missing from the saved trace`);
  const frames = await staticChunk(chunk), offset = frame - chunk.first_frame;
  frames.forEach((item, position) => { targetSession.frames[chunk.first_frame + position] = item; });
  if (!targetSession.frames[frame] || !frames[offset]) throw Error(`frame ${frame} is missing from its saved chunk`);
}
async function findStaticFrame(predicate, start, step = 1) {
  const targetSession = session;
  for (let frame = start; frame >= 0 && frame < targetSession.frames.length; frame += step) {
    if (!targetSession.frames[frame]) await loadStaticFrame(frame, targetSession);
    if (targetSession !== session) return -1;
    if (predicate(targetSession.frames[frame], frame)) return frame;
  }
  return -1;
}
async function staticMetadata(entry) {
  if (entry.metadata && typeof entry.metadata === 'object') return entry.metadata;
  const path = entry.metadata_path || entry.metadata;
  if (typeof path !== 'string') throw Error('saved trace metadata is missing');
  return staticJson(path);
}
async function loadStatic(program) {
  const token = ++requestId;
  const entry = staticManifest?.programs?.[program];
  if (!entry) throw Error(`saved ${program} trace is unavailable`);
  pause(); closeInspector(); enable(false); $('message').className='message';
  $('message').textContent='Loading saved CSP trace…';
  try {
    const metadata = await staticMetadata(entry), frames = new Array(entry.frames?.count || 0);
    if (token !== requestId) return;
    staticProgram = entry;
    const data = {...metadata, frames}; session = data;
    await loadStaticFrame(0, data, entry);
    if (token !== requestId || session !== data) return;
    apply(data, program);
    $('message').textContent=`Saved CSP trace · ${data.summary?.instructions ?? 'recorded'} instructions · ${data.summary?.cycles ?? frames.length} cycles`;
  } catch (error) {
    if (token === requestId) { session=null; enable(false); $('program').disabled=false; ; }
    throw error;
  }
}
async function bootstrap() {
  let manifest, manifestFailure;
  try {
    const response = await fetch(new URL('manifest.json', document.baseURI));
    if (response.status === 404) { load('matrix'); return; }
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    manifest = await response.json();
    if (manifest.format !== 'rv-nand-static-v1' || !manifest.programs) manifestFailure = Error('invalid RV NAND static manifest');
  } catch (error) { manifestFailure = error; }
  if (manifestFailure || !manifest) { $('message').className='message error'; $('message').textContent=`Saved trace could not be loaded: ${(manifestFailure || Error('empty manifest')).message}`; return; }
  staticManifest = manifest; staticManifestUrl = new URL('manifest.json', document.baseURI).href;
  const allowed = new Set(Object.keys(manifest.programs));
  [...$('program').options].forEach(option => { if (!allowed.has(option.value)) option.remove(); });
  $('editor-panel').hidden = true;
  try { await loadStatic($('program').value in manifest.programs ? $('program').value : Object.keys(manifest.programs)[0]); }
  catch (error) { session=null; $('message').className='message error'; $('message').textContent=`Saved trace could not be loaded: ${error.message}`; }
}
async function load(program){const mine=++requestId;controller?.abort();controller=new AbortController();pause();closeInspector();enable(false);$('message').className='message';$('message').textContent='Running the program and preparing its execution trace…';try{const backend=encodeURIComponent(BACKEND);const r=await fetch(`/api/session?program=${encodeURIComponent(program)}&backend=${backend}`,{signal:controller.signal});if(!r.ok)throw Error(`HTTP ${r.status}`);const d=await r.json();if(mine===requestId)apply(d,program)}catch(e){if(e.name!=='AbortError'&&mine===requestId){session=null;$('message').className='message error';$('message').textContent=`Execution could not be loaded: ${e.message}. Reload to retry.`;$('program').disabled=false;}}}
async function assemble(){const mine=++requestId;controller?.abort();controller=new AbortController();pause();closeInspector();$('diagnostics').textContent='Assembling…';$('assemble').disabled=true;session=null;enable(false);$('program').disabled=false;const source=$('assembly-source').value;try{const r=await fetch('/api/assemble',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source,backend:BACKEND}),signal:controller.signal}),d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||d.message||`HTTP ${r.status}`);if(mine===requestId){$('diagnostics').textContent=d.warning||'';apply(d,'custom',source)}}catch(e){if(e.name!=='AbortError'&&mine===requestId){$('diagnostics').textContent=e.message;$('message').className='message error';$('message').textContent=`Assembly failed: ${e.message}`}}finally{if(mine===requestId)$('assemble').disabled=false}}
draw();$('reset').onclick=()=>{pause();navigate(0)};$('previous').onclick=()=>{pause();navigate(index-1)};$('next').onclick=()=>{pause();navigate(index+1)};$('play').onclick=()=>{if(!session)return;if(timer)return pause();if(index===session.frames.length-1)navigate(0);$('play-icon').textContent='Ⅱ';$('play-label').textContent='Pause';timer=setInterval(()=>index>=session.frames.length-1?pause():navigate(index+1),1000/+$('speed').value)};$('scrubber').oninput=e=>{pause();navigate(+e.target.value)};$('speed').onchange=pause;$('next-instruction').onclick=async()=>{if(!session)return;pause();const n=staticManifest?await findStaticFrame(frame=>frame.instruction_start||String(frame.phase).toUpperCase()==='FETCH',index+1):session.frames.findIndex((frame,position)=>position>index&&(frame?.instruction_start||String(frame?.phase).toUpperCase()==='FETCH'));navigate(n<0?session.frames.length-1:n)};$('follow').onclick=()=>{follow=!follow;$('follow').setAttribute('aria-pressed',follow);$('follow').textContent=follow?'Follow on':'Follow off'};$('program').onchange=e=>{const custom=e.target.value==='custom';$('editor-panel').hidden=!custom;pause();$('assemble').disabled=false;if(custom){++requestId;controller?.abort();$('program').disabled=false;$('assembly-source').focus()}else if(staticManifest)loadStatic(e.target.value).catch(error=>{$('message').className='message error';$('message').textContent=`Saved trace could not be loaded: ${error.message}`});else load(e.target.value)};$('assemble').onclick=assemble;$('alu-close').onclick=closeInspector;document.addEventListener('keydown',e=>{if(e.key==='Escape'&&inspectorOpen){e.preventDefault();closeInspector();return}if(!session||e.ctrlKey||e.metaKey||e.altKey||['INPUT','TEXTAREA','SELECT','BUTTON'].includes(e.target.tagName))return;if(e.key==='ArrowRight'){e.preventDefault();pause();e.shiftKey?$('next-instruction').click():navigate(index+1)}else if(e.key==='ArrowLeft'){e.preventDefault();pause();if(e.shiftKey&&staticManifest){findStaticFrame(frame=>frame.instruction_start,index-1,-1).then(prior=>navigate(prior<0?0:prior));}else{const prior=session.frames.map((frame,position)=>frame?.instruction_start&&position<index?position:-1).filter(position=>position>=0);navigate(e.shiftKey?(prior.at(-1)??0):index-1)}}else if(e.code==='Space'){e.preventDefault();$('play').click()}});bootstrap();
