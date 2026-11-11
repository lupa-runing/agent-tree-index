/*!
 * 场景直接提取自 neural-creator-dashboard/src/neural/Home.jsx。
 * Required Notice: Copyright (c) 2026 luoluo-121 and neural-creator-dashboard contributors
 * License: https://polyformproject.org/licenses/noncommercial/1.0.0/
 * 许可和适配范围见 来源说明.md、LICENSE、NOTICE.md。
 */
import React, {useEffect, useLayoutEffect, useMemo, useRef} from 'react';
import {Icon} from './icons';
import {T} from './theme';
const KINDS = {note:{color:T.kinds.note}};
function itemMeta(n) { return [[n.format, '', ''], ...(n.page_count ? [[n.page_count+' 页', '', '']] : []), ['已索引', '', '']]; }
// —— 布局目标 ——
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function targets(L, t) {
  const MODULES = L.modules, {w: W, h: H} = L.size, narrow = W < (L.stage === 'hub' ? 760 : 960);
  const swim = L.reduced ? 0 : 1, {top, bottom} = L.bounds;
  const edge = narrow ? 18 : clamp(W * .04, 24, 64);
  const res = {orb: {}, jelly: {}, fan: null};
  if (L.stage === 'hub') {
    const js = narrow ? 92 : clamp(W * .12, 120, 184);
    const yMin = top + js * .375 + 12, yMax = H - bottom - js * .36 - (narrow ? 60 : 90) - 12;
    const cy = (yMin + yMax) / 2;
    const s = narrow ? clamp(W * .56, 180, 280) : clamp(Math.min(W, H - top - bottom) * .66, 250, 440);
    res.orb = {x: W / 2, y: cy, s};
    const rx = Math.max(40, Math.min(W * .36, 540, W / 2 - edge - (narrow ? 60 : 92)));
    const ry = Math.max(24, Math.min((yMax - yMin) / 2, 262));
    MODULES.forEach((m, i) => {
      const a = (m.angle + swim * 7 * Math.sin(t * .17 + i * 1.7)) * Math.PI / 180;
      const r = 1 + swim * .025 * Math.sin(t * .23 + i);
      res.jelly[m.id] = {x: W / 2 + Math.cos(a) * rx * r, y: cy + Math.sin(a) * ry + swim * 6 * Math.sin(t * .9 + i * 2.1),
        s: js, o: 1, tilt: swim * 6 * Math.sin(t * .6 + i)};
    });
  } else if (narrow) {
    res.orb = {x: 50, y: top + 56, s: 92};
    MODULES.forEach((m, i) => {
      const sel = m.id === L.mod, k = slotOf(L.mod, m.id, MODULES);
      res.jelly[m.id] = {x: 106 + k * (W - 180) / Math.max(1, MODULES.length - 1), y: top + 52 + swim * 4 * Math.sin(t * .9 + i * 2),
        s: sel ? 76 : 54, o: sel ? 1 : .55, tilt: swim * 3 * Math.sin(t * .6 + i)};
    });
    const y0 = top + 210, n = L.items.length;
    res.fan = {x: edge + 10, y0, gap: n > 1 ? Math.min(88, (H - bottom - 44 - y0) / (n - 1)) : 0};
  } else {
    const ox = clamp(W * .13, 125, 210), cy = (top + H - bottom) / 2;
    res.orb = {x: ox, y: cy, s: 178};
    const colX = ox + clamp(W * .14, 112, 158);
    const compact = H - top - bottom < MODULES.length * 92;
    const gap = Math.min(132, (H - top - bottom - 110) / Math.max(1, MODULES.length - 1));
    MODULES.forEach((m, i) => {
      const sel = m.id === L.mod, k = slotOf(L.mod, m.id, MODULES);
      res.jelly[m.id] = {x: colX + (sel ? 16 : 0), y: cy + (k - Math.floor(MODULES.length / 2)) * gap + swim * 5 * Math.sin(t * .9 + i * 2),
        s: sel ? (compact ? 112 : 128) : (compact ? 76 : 92), o: sel ? 1 : .6, tilt: swim * 3 * Math.sin(t * .6 + i)};
    });
    const n = L.items.length, span = Math.min(H - top - bottom - 88, Math.max(0, n - 1) * 94);
    const cardWidth = clamp(W * .27, 270, 440);
    const labelRight = colX + 16 + (compact ? 112 : 128) / 2 + 10 + 164;
    const listX = Math.min(labelRight + clamp(W * .06, 64, 108), W - edge - cardWidth - 18);
    res.fan = {x: listX, y0: cy - span / 2, gap: n > 1 ? span / (n - 1) : 0};
  }
  return res;
}

// 保留原版选中项居中方式，将固定五格适配为实际知识库数量。
function slotOf(selId, id, modules) {
  const order = modules.filter(m => m.id !== selId).map(m => m.id);
  order.splice(Math.floor(modules.length / 2), 0, selId);
  return order.indexOf(id);
}

function spring(st, target, dt, k = 62) {
  const c = 2 * Math.sqrt(k);
  st.v += (-k * (st.x - target) - c * st.v) * dt;
  st.x += st.v * dt;
  return st.x;
}
const sp = x => ({x, v: 0});
// 光球边缘向外飘散的光点（光球本地坐标，画布 1012×1012，中心 506）
const DUST = Array.from({length: 110}, (_, i) => ({a: i * 2.39996, v: .035 + (i * 37 % 100) / 100 * .06, o: (i * .618034) % 1, w: (i % 2 ? 1 : -1) * (.15 + (i % 7) * .05), s: .7 + (i % 5) * .32, b: .45 + (i % 3) * .25, c: T.dust[i % T.dust.length]}));
// 光球与水母的视频逐帧画到 <canvas> 上显示：部分内置 / 嵌入式浏览器不合成 <video> 画面（解码正常但页面上是空的），
// 画布在所有浏览器里都能显示。视频本身透明地留在原位负责播放；未加载好时先画封面图。
const posterCache = new Map();
const posterOf = url => { if (!posterCache.has(url)) { const img = new Image(); img.src = url; posterCache.set(url, img); } return posterCache.get(url); };
function paintVideo(pair) {
  const {video, canvas} = pair;
  if (!video || !canvas) return;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (!cw || !ch) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2), W = Math.round(cw * dpr), H = Math.round(ch * dpr);
  const resized = canvas.width !== W || canvas.height !== H;
  if (resized) { canvas.width = W; canvas.height = H; }
  const ready = video.readyState >= 2 && video.videoWidth;
  const src = ready ? video : posterOf(video.poster);
  const sw0 = ready ? video.videoWidth : src.naturalWidth, sh0 = ready ? video.videoHeight : src.naturalHeight;
  if (!sw0 || !sh0) return;
  const stamp = ready ? video.currentTime : -1;
  if (!resized && stamp === pair.stamp && ready === pair.ready) return;
  pair.stamp = stamp; pair.ready = ready;
  // 等同 object-fit: cover
  const k = Math.max(W / sw0, H / sh0), sw = W / k, sh = H / k;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(src, (sw0 - sw) / 2, (sh0 - sh) / 2, sw, sh, 0, 0, W, H);
}

const bez = (p0, p1, p2, p3, u) => { const m = 1 - u; return m * m * m * p0 + 3 * m * m * u * p1 + 3 * m * u * u * p2 + u * u * u * p3; };

export function Scene({graph, items, onModule, onItem, live, sel, modules, styles}) {
  const MODULES = modules, MOD_STYLE = styles;
  const dustRef = useRef(null);
  const orbRef = useRef(null), jellyRefs = useRef({}), innerRefs = useRef({}), labelRefs = useRef({}), threadRefs = useRef({}), pulseRefs = useRef({});
  const itemRefs = useRef([]), fanRefs = useRef([]), fanPulseRefs = useRef([]), relationRefs = useRef({});
  const vids = useRef({});
  const vidRef = (id, part) => el => { (vids.current[id] ||= {})[part] = el; };
  const summaries = useMemo(() => Object.fromEntries(MODULES.map(m => [m.id, {count:m.doc_count, sub:[m.link_count, '关联', 'links']} ])), [modules]);

  useLayoutEffect(() => { live.current.itemState = items.map(() => null); live.current.fanStart = performance.now(); }, [items, live]);

  useEffect(() => {
    let raf, last = performance.now();
    const S = live.current.springs;
    const step = now => {
      const L = live.current;
      // rAF 给的是帧开始时间，可能早于上面记录的 last；负的 dt 会让后续计算出现 NaN，所以限制为 ≥ 0
      const dt = Math.max(0, Math.min(1 / 30, (now - last) / 1000)); last = Math.max(last, now);
      if (!L.paused) L.time += dt;
      const t = L.time, since = (now - L.t0) / 1000;
      const T = targets(L, t);
      const intro = L.stage === 'hub' && !L.reduced;
      // 光球
      const orbS = intro && since < .15 ? T.orb.s * .35 : T.orb.s;
      const ox = spring(S.orb.x, T.orb.x, dt), oy = spring(S.orb.y, T.orb.y, dt), os = spring(S.orb.s, orbS, dt, 40), oo = spring(S.orb.o, intro && since < .1 ? 0 : 1, dt, 30);
      L.orb = {x: ox, y: oy, s: os};
      if (orbRef.current) { orbRef.current.style.transform = `translate3d(${ox - os / 2}px,${oy - os / 2}px,0) scale(${os / 460})`; orbRef.current.style.opacity = clamp(oo, 0, 1); }
      const dust = dustRef.current;
      if (dust) {
        const di = clamp(spring(S.dust, L.stage === 'hub' ? .3 : 1, dt, 18), 0, 1);
        const ctx = dust.getContext('2d');
        ctx.clearRect(0, 0, 1012, 1012);
        if (!L.reduced && di > .02) {
          const sc = Math.max(os / 460, .2);
          ctx.globalCompositeOperation = 'lighter';
          for (const p of DUST) {
            const ph = ((t * p.v + p.o) % 1 + 1) % 1, r = 150 + ph * 340, a = p.a + ph * p.w;
            const x = 506 + Math.cos(a) * r, y = 506 + Math.sin(a) * r * .96;
            const al = di * Math.pow(Math.max(0, Math.sin(ph * Math.PI)), 1.3) * p.b, rad = p.s / sc * 2.2;
            const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
            g.addColorStop(0, `rgba(${p.c},${al})`); g.addColorStop(1, `rgba(${p.c},0)`);
            ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rad, 0, 7); ctx.fill();
          }
        }
      }
      // 水母
      MODULES.forEach((m, i) => {
        const j = S.jelly[m.id], tg = T.jelly[m.id];
        const gated = intro && since < 1 + i * .17;
        const x = spring(j.x, gated ? ox : tg.x, dt), y = spring(j.y, gated ? oy : tg.y, dt), s = spring(j.s, gated ? 24 : tg.s, dt), o = spring(j.o, gated ? 0 : tg.o, dt, 40);
        const lo = spring(j.lo, intro && since < 2 + i * .1 ? 0 : tg.o, dt, 40);
        j.cur = {x, y, s};
        const el = jellyRefs.current[m.id], inner = innerRefs.current[m.id], lab = labelRefs.current[m.id];
        if (el) { el.style.transform = `translate3d(${x - s / 2}px,${y - s * .375}px,0) scale(${s / 200})`; el.style.opacity = clamp(o, 0, 1); }
        if (inner) inner.style.transform = `rotate(${tg.tilt}deg) scaleX(${MOD_STYLE[m.id].flip})`;
        if (lab) {
          const lw = lab.offsetWidth, lh = lab.offsetHeight;
          const hub = L.stage === 'hub', narrow = L.size.w < (hub ? 760 : 960);
          // 侧列时标签放在水母右边缘之外再空 10px，触须不压标签
          const proposedLX = hub || narrow ? x - lw / 2 : x + s * .5 + 10;
          const lx = narrow ? clamp(proposedLX, 8, Math.max(8, L.size.w - lw - 8)) : proposedLX;
          const ly = hub ? y + s * .36 : narrow ? y + s * .36 : y - lh / 2;
          lab.style.transform = `translate3d(${lx}px,${ly}px,0)`;
          lab.style.opacity = clamp(narrow && !hub && m.id !== L.mod ? 0 : lo, 0, 1);
          j.label = {x: lx, y: ly, w: lw, h: lh};
        }
        // 光球 → 水母：神经丝与往返脉冲
        const g = threadRefs.current[m.id];
        if (g) {
          let x1, y1, x2, y2, c1x, c1y, c2x, c2y;
          if (L.stage === 'hub') {
            const dx = x - ox, dy = y - oy, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
            x1 = ox + ux * os * .2; y1 = oy + uy * os * .2; x2 = x - ux * s * .22; y2 = y - uy * s * .1;
            const bend = 26 * Math.sin(t * .5 + i);
            c1x = x1 + dx * .35 - uy * bend; c1y = y1 + dy * .35 + ux * bend; c2x = x1 + dx * .7 + uy * bend; c2y = y1 + dy * .7 - ux * bend;
          } else {
            x1 = ox + os * .3; y1 = oy; x2 = x - s * .34; y2 = y;
            const dx = x2 - x1; c1x = x1 + dx * .55; c1y = y1; c2x = x2 - dx * .55; c2y = y2;
          }
          const d = `M${x1},${y1} C${c1x},${c1y} ${c2x},${c2y} ${x2},${y2}`;
          const active = m.id === L.mod || m.kind === L.hover;
          g.glow.setAttribute('d', d); g.core.setAttribute('d', d);
          const vis = clamp(o, 0, 1) * (L.stage === 'hub' ? 1 : active ? 1 : .45);
          g.glow.style.opacity = vis * (active ? .9 : .45); g.core.style.opacity = vis;
          const pulses = pulseRefs.current[m.id] || [];
          pulses.forEach((c, k) => {
            if (!c) return;
            const inbound = k === 2;
            let u = ((t * (inbound ? .23 : .31) + k * .5 + i * .17) % 1);
            if (inbound) u = 1 - u;
            c.setAttribute('cx', bez(x1, c1x, c2x, x2, u)); c.setAttribute('cy', bez(y1, c1y, c2y, y2, u));
            c.style.opacity = L.reduced || L.paused ? 0 : vis * Math.sin(u * Math.PI);
          });
        }
      });
      // 选中模块 → 多篇笔记（触须式扇形展开）
      const sj = L.mod && S.jelly[L.mod];
      if (T.fan && sj?.label) {
        const narrow = L.size.w < 960;
        const ox2 = narrow ? sj.label.x - 8 : sj.label.x + sj.label.w + 6, oy2 = narrow ? sj.label.y + sj.label.h / 2 : sj.cur.y;
        items.forEach((n, i) => {
          if (!L.itemState[i]) L.itemState[i] = {x: sp(ox2), y: sp(oy2), o: sp(0)};
          const st = L.itemState[i];
          // 触须一根一根依次长出（20 条约 1.8 秒），形成伞状开花的节奏
          const ready = L.reduced || now - L.fanStart > 160 + i * Math.min(90, 1800 / Math.max(items.length, 1));
          const tx = T.fan.x, ty = T.fan.y0 + i * T.fan.gap + (L.reduced ? 0 : Math.sin(t * .8 + i * .9) * 2);
          const x = spring(st.x, ready ? tx : ox2, dt, 70), y = spring(st.y, ready ? ty : oy2, dt, 70), o = spring(st.o, ready ? 1 : 0, dt, 50);
          const el = itemRefs.current[i];
          if (el) { el.style.transform = `translate3d(${x}px,${y - el.offsetHeight / 2}px,0)`; el.style.opacity = clamp(o, 0, 1); }
          const p = fanRefs.current[i];
          if (p) {
            const dx = x - ox2, sway = L.reduced ? 0 : Math.sin(t * 1.1 + i * .7) * 7;
            const c1x = narrow ? x : ox2 + dx * .5, c1y = oy2 + sway;
            const c2x = narrow ? x : x - dx * .45, c2y = narrow ? oy2 : y - sway * .5;
            p.setAttribute('d', `M${ox2},${oy2} C${c1x},${c1y} ${c2x},${c2y} ${x},${y}`);
            const on = sel === n.id;
            p.style.opacity = clamp(o, 0, 1) * (sel ? (on ? 1 : .35) : .8);
            p.style.strokeWidth = on ? 1.8 : 1;
            (fanPulseRefs.current[i] || []).forEach((c, k) => {
              if (!c) return;
              let u = (t * (k ? .27 : .36) + i * .13 + k * .5) % 1;
              if (k) u = 1 - u;
              c.setAttribute('cx', bez(ox2, c1x, c2x, x, u)); c.setAttribute('cy', bez(oy2, c1y, c2y, y, u));
              c.style.opacity = L.reduced || L.paused ? 0 : clamp(o, 0, 1) * Math.sin(u * Math.PI) * (sel && !on ? .3 : 1);
            });
          }
        });
      }
      // 适配：只绘制 PageIndex 接口返回的真实库间关联，沿用原版曲线与脉冲。
      for (const link of graph.links) {
        const a = S.jelly[link.source]?.cur, b = S.jelly[link.target]?.cur, ref = relationRefs.current[link.id];
        if (!a || !b || !ref) continue;
        const mid = (a.y+b.y)/2 - Math.min(90, Math.hypot(a.x-b.x,a.y-b.y)*.18);
        const c1x = a.x+(b.x-a.x)*.35, c2x = a.x+(b.x-a.x)*.7;
        ref.path.setAttribute('d', `M${a.x},${a.y} C${c1x},${mid} ${c2x},${mid} ${b.x},${b.y}`);
        ref.path.style.opacity = L.stage === 'hub' ? .6 : .15;
        const u = (t*.23)%1;
        ref.pulse.setAttribute('cx', bez(a.x,c1x,c2x,b.x,u)); ref.pulse.setAttribute('cy', bez(a.y,mid,mid,b.y,u));
        ref.pulse.style.opacity = L.reduced || L.paused || L.stage !== 'hub' ? 0 : Math.sin(u*Math.PI);
      }
      // 光球与水母的视频画面
      for (const pair of Object.values(vids.current)) paintVideo(pair);
    };
    // 每帧先排好下一帧再执行：某一帧出错也不会让光球和水母停住
    let warned = false;
    const frame = now => { raf = requestAnimationFrame(frame); try { step(now); } catch (err) { if (!warned) { warned = true; console.error(err); } } };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [items, live, sel]);

  // 暂停时一并暂停视频
  useEffect(() => {
    const sync = () => live.current.element.querySelectorAll('.scene video').forEach(v => { if (live.current.paused || live.current.reduced || document.hidden) v.pause(); else v.play().catch(() => {}); });
    live.current.syncVideo = sync; sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, [live]);

  const hub = live.current.stage === 'hub';
  return <div className={`scene stage-${live.current.stage}`}>
    <div className="orb" ref={orbRef} aria-hidden="true">
      <div className="orb-halo"/>
      <video className="vsrc" ref={vidRef('orb', 'video')} src={T.media.orb} poster={T.media.orbPoster} muted loop playsInline autoPlay preload="auto" onLoadedMetadata={e => { e.currentTarget.currentTime = live.current.mediaTimes.orb || 0; }}/>
      <canvas className="vid" ref={vidRef('orb', 'canvas')}/>
      <canvas className="orb-dust" ref={dustRef} width="1012" height="1012"/>
    </div>
    <svg className="threads" aria-hidden="true">
      <defs>
        <filter id="thread-blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3.2"/></filter>
        <radialGradient id="pulse-out"><stop offset="0" stopColor={T.pulse.out[0]}/><stop offset=".4" stopColor={T.pulse.out[1]}/><stop offset="1" stopColor={T.pulse.out[1]} stopOpacity="0"/></radialGradient>
        <radialGradient id="pulse-in"><stop offset="0" stopColor={T.pulse.in[0]}/><stop offset=".4" stopColor={T.pulse.in[1]}/><stop offset="1" stopColor={T.pulse.in[1]} stopOpacity="0"/></radialGradient>
      </defs>
      {graph.links.map(link => <g key={link.id} style={{color:T.kinds.core}}>
        <path className="fan-thread" ref={el => { (relationRefs.current[link.id] ||= {}).path = el; }}/>
        <circle r="4.5" fill="url(#pulse-out)" ref={el => { (relationRefs.current[link.id] ||= {}).pulse = el; }}/>
      </g>)}
      {MODULES.map(m => <g key={m.id} style={{color: MOD_STYLE[m.id].color}}>
        <path ref={el => { threadRefs.current[m.id] = {...threadRefs.current[m.id], glow: el}; }} className="thread-glow" filter="url(#thread-blur)"/>
        <path ref={el => { threadRefs.current[m.id] = {...threadRefs.current[m.id], core: el}; }} className="thread-core"/>
        {[0, 1, 2].map(k => <circle key={k} r={k === 2 ? 4.5 : 5.5} fill={`url(#${k === 2 ? 'pulse-in' : 'pulse-out'})`} ref={el => { (pulseRefs.current[m.id] ||= [])[k] = el; }}/>)}
      </g>)}
      {items.map((n, i) => <g key={n.id} style={{color: KINDS[n.kind].color}}>
        <path className="fan-thread" ref={el => { fanRefs.current[i] = el; }}/>
        {[0, 1].map(k => <circle key={k} r={k ? 3.5 : 4.5} fill={`url(#${k ? 'pulse-in' : 'pulse-out'})`} ref={el => { (fanPulseRefs.current[i] ||= [])[k] = el; }}/>)}
      </g>)}
    </svg>
    {MODULES.map(m => {
      const sum = summaries[m.id], active = live.current.mod === m.id;
      return <React.Fragment key={m.id}>
        <button className={`jelly ${active ? 'active' : ''}`} ref={el => { jellyRefs.current[m.id] = el; }} onClick={() => onModule(m.id)}
          onPointerEnter={() => { live.current.hover = m.kind; }} onPointerLeave={() => { live.current.hover = null; }}
          aria-label={`${hub ? '进入' : '展开'}知识库 ${m.title}，${sum.count} 份文档`}>
          <div className="jelly-inner" ref={el => { innerRefs.current[m.id] = el; }} style={{filter: MOD_STYLE[m.id].filter}}>
            <video className="vsrc" ref={vidRef(m.id, 'video')} src={T.media.jelly} poster={T.media.jellyPoster} muted loop playsInline autoPlay preload="auto"
              onLoadedMetadata={e => { e.currentTarget.currentTime = live.current.mediaTimes[m.id] ?? (MODULES.indexOf(m) * 1.37) % 6; }}/>
            <canvas className="vid" ref={vidRef(m.id, 'canvas')}/>
          </div>
        </button>
        <button className={`jelly-label ${active ? 'active' : ''} ${hub ? 'below' : 'side'}`} ref={el => { labelRefs.current[m.id] = el; }} onClick={() => onModule(m.id)} tabIndex={-1} aria-label={`${hub ? '进入' : '展开'} ${m.title}`}
          onPointerEnter={() => { live.current.hover = m.kind; }} onPointerLeave={() => { live.current.hover = null; }} style={{'--mod': MOD_STYLE[m.id].color}}>
          <span className="jl-icon"><Icon name={m.icon} size={14}/></span>
          <span className="jl-count">{sum.count}{!hub && <small>篇文档</small>}</span>
          <span className="jl-name">{m.title}<em>{m.en}</em></span>
          <span className="jl-sub">{hub ? <>{sum.sub[0]} {sum.sub[1]} <em>{sum.sub[2]}</em></> : active ? '当前展开' : '点击切换知识库'}</span>
        </button>
      </React.Fragment>;
    })}
    {items.map((n, i) => {
      const meta = itemMeta(n);
      return <button key={n.id} className={`fan-item ${sel === n.id ? 'active' : ''} kind-${n.kind}`} ref={el => { itemRefs.current[i] = el; }} onClick={() => onItem(n.id)} style={{'--kc': KINDS[n.kind].color}} aria-label={`查看文档 ${n.title}`} title={n.title}>
        <span className="fi-dot"/>
        <span className="fi-body">
          <span className="fi-file"><Icon name="file" size={17}/></span>
          <span className="fi-title">{n.short || n.title}</span>
          <span className="fi-meta">{meta.map(([k, en, v], j) => <span key={j} className={k === '↔' ? 'mutual' : ''}>{k}{en && <em>{en}</em>} {v !== '' && <b>{v}</b>}</span>)}</span>
          <span className="fi-open"><Icon name="outlink" size={15}/></span>
        </span>
      </button>;
    })}
  </div>;
}

export {targets, sp};
