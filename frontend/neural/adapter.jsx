/* PageIndex 数据与路由适配；视觉场景使用从上游复制的 Scene。 */
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Scene, targets, sp} from './Scene';
import {T} from './theme';
import './scene.css';
import './adapter.css';

const variants = [T.modules.works, T.modules.methods, T.modules.ideas, T.modules.drafts, T.modules.concepts];
const flips = [1, -1, -1, 1, -1];

function mount(element, data, {id = null, docs = [], previous = null, onModule, onItem} = {}) {
  const modules = data.nodes.map((kb, i) => ({
    id: kb.kb_id, title: kb.name, en: '', kind: kb.kb_id, icon: 'methods', doc_count: kb.doc_count,
    link_count: data.links.filter(l => l.source === kb.kb_id || l.target === kb.kb_id).length,
    angle: data.nodes.length === 5 ? [180, -90, 0, 35, 145][i] : data.nodes.length === 2 ? 180 - i * 180 : -90 + i * 360 / data.nodes.length
  }));
  const styles = Object.fromEntries(modules.map((m, i) => [m.id, {...variants[i % variants.length], flip: flips[i % flips.length]}]));
  const allItems = docs.map(d => ({...d, id: d.doc_id, title: d.doc_name, kind: 'note',
    format: /\.pdf$/i.test(d.doc_name) ? 'PDF' : /\.docx$/i.test(d.doc_name) ? 'DOCX' : /\.doc$/i.test(d.doc_name) ? 'DOC' : /\.(md|markdown)$/i.test(d.doc_name) ? 'Markdown' : '文档'}));
  const graph = {links: data.links.map((l, i) => ({...l, id: 'kb-link-' + i}))};
  const root = createRoot(element), motion = matchMedia('(prefers-reduced-motion: reduce)');
  const pageElement = element.closest('.knowledge-page');
  const now = performance.now();
  const L = previous?.live || {t0: now, time: 0, hover: null, mediaTimes: {},
    springs: {dust: sp(.3), orb: {x: sp(0), y: sp(0), s: sp(120), o: sp(0)}, jelly: {}}};
  const live = {current: L};
  let selected = null, stopped = false, mounted = false, page = 0, pageSize = 0, visibleItems = [];
  Object.assign(L, {modules, items: visibleItems, stage: id ? 'module' : 'hub', mod: id, reduced: motion.matches,
    paused: false, element, mediaTimes: L.mediaTimes || {}, itemState: [], fanStart: now});

  const updatePage = () => {
    page = Math.min(page, Math.max(0, Math.ceil(allItems.length / pageSize) - 1));
    visibleItems = allItems.slice(page * pageSize, (page + 1) * pageSize);
    L.items = visibleItems;
  };
  const changePage = direction => {
    page += direction; selected = null; L.stage = 'module'; updatePage(); render();
  };
  const measure = () => {
    const width = element.clientWidth, height = pageElement.clientHeight;
    if (!width || !height) return;
    const css = getComputedStyle(pageElement);
    const top = parseFloat(css.getPropertyValue('--scene-top')) || 180;
    const bottom = parseFloat(css.getPropertyValue('--scene-bottom')) || 72;
    element.style.height = height + 'px';
    element.style.setProperty('--document-width', (width < 960 ? width - 70 : Math.min(440, Math.max(270, width * .27))) + 'px');
    L.size = {w: width, h: height}; L.bounds = {top, bottom}; L.focusHeight = height;
    element.classList.toggle('compact-libraries', !!id && width >= 760 && height - top - bottom < modules.length * 92);
    const available = height - top - bottom - (width < 960 ? 254 : 88);
    const capacity = Math.max(1, Math.floor(available / 88) + 1);
    if (capacity !== pageSize) {
      pageSize = capacity; updatePage();
      if (mounted) render();
    }
    const target = targets(L, L.time);
    if (target.fan) element.style.setProperty('--document-list-left', target.fan.x + 'px');
    if (!previous && !L.initialized) {
      for (const k of ['x', 'y']) L.springs.orb[k] = sp(target.orb[k]);
      if (id || L.reduced) for (const k of ['s', 'o']) L.springs.orb[k] = sp(k === 'o' ? 1 : target.orb.s);
      L.initialized = true;
    }
    for (const m of modules) if (!L.springs.jelly[m.id]) {
      const p = id || L.reduced ? target.jelly[m.id] : {x: target.orb.x, y: target.orb.y, s: 20, o: 0};
      L.springs.jelly[m.id] = {x: sp(p.x), y: sp(p.y), s: sp(p.s), o: sp(p.o), lo: sp(p.o)};
    }
  };
  const render = () => root.render(<div className="neural-scene"><div className={'home-stage stage-' + L.stage}>
    <div className="stage-bg"/>
    <Scene graph={graph} items={visibleItems} modules={modules} styles={styles} live={live} sel={selected} onModule={onModule} onItem={onItem}/>
    {id && !allItems.length && <div className="scene-empty"><strong>这个知识库还没有文档</strong><span>添加 PDF、Word 或 Markdown，让知识沿着触须展开。</span></div>}
    {id && allItems.length > pageSize && <nav className="scene-pagination" aria-label="文档分页">
      <span>{page * pageSize + 1}–{Math.min((page + 1) * pageSize, allItems.length)} / {allItems.length} 份文档</span>
      <button type="button" aria-label="上一页文档" disabled={!page} onClick={() => changePage(-1)}>←</button>
      <button type="button" aria-label="下一页文档" disabled={(page + 1) * pageSize >= allItems.length} onClick={() => changePage(1)}>→</button>
    </nav>}
    <div className="scene-legend"><span>光丝：空间归属</span><span>金线：库间关联</span><span>{id ? '点击文档查看详情' : '点击水母展开知识库'}</span></div>
  </div></div>);
  measure(); render(); mounted = true;
  const resize = new ResizeObserver(measure); resize.observe(pageElement);
  const onMotion = () => { L.reduced = motion.matches; L.syncVideo?.(); };
  motion.addEventListener('change', onMotion);
  return {
    focus: id,
    snapshot() {
      L.mediaTimes = Object.fromEntries([...element.querySelectorAll('video')].map((v, i) => [i === 0 ? 'orb' : modules[i - 1]?.id, v.currentTime]));
      return {focused: !!id, live: L};
    },
    selectDocument(docId) { selected = docId; L.stage = docId ? 'note' : id ? 'module' : 'hub'; render(); },
    stop() {
      if (stopped) return;
      stopped = true; resize.disconnect(); motion.removeEventListener('change', onMotion);
      element.querySelectorAll('video').forEach(v => v.pause()); root.unmount();
    }
  };
}
window.NeuralGalaxy = {mount};
