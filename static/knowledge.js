/* 知识库导航与列表；星团场景由 neural-creator-dashboard 原版组件提供。 */
window.Knowledge = (() => {
  const colors = ['#bdb6e7', '#a7d4c2', '#decba0', '#a9cfdc', '#d3adbf', '#c7d2b2'];
  const state = {data: null, pending: null, view: 'galaxy', query: '', detailId: null, docs: [], docsQuery: '', galaxy: null, detailRequest: 0, docRequest: 0, deleting: false};
  try { state.view = localStorage.getItem('pageindex-library-view') === 'list' ? 'list' : 'galaxy'; } catch {}
  const node = id => state.data?.nodes.find(k => k.kb_id === id);
  const connections = id => (state.data?.links || []).filter(l => l.source === id || l.target === id);
  const isOpen = () => location.hash.startsWith('#knowledge');
  const color = id => colors[(state.data?.nodes.findIndex(k => k.kb_id === id) || 0) % colors.length];
  const empty = (title, text, symbol = 'book') => `<div class="library-empty">${icon(symbol)}<h2>${esc(title)}</h2><p>${esc(text)}</p></div>`;
  const evidence = link => [link.shared_documents.length ? '同名文档：' + link.shared_documents.join('、') : '', link.shared_topics.length ? '共同标题关键词：' + link.shared_topics.join('、') : ''].filter(Boolean).join('；');
  const deleteButton = (kbId, docId = '', label = '删除知识库') => {
    const name = docId ? state.docs.find(d => d.doc_id === docId)?.doc_name : node(kbId)?.name;
    return `<button type="button" class="library-delete" data-delete-kb="${esc(kbId)}"${docId ? ` data-delete-doc="${esc(docId)}"` : ''} aria-label="${esc(label + ' ' + (name || ''))}" title="${label}">${icon('trash')}<span>${label}</span></button>`;
  };

  const deleteDialog = document.createElement('dialog');
  deleteDialog.className = 'document-dialog delete-dialog';
  deleteDialog.setAttribute('aria-labelledby', 'deleteDialogTitle');
  deleteDialog.setAttribute('aria-describedby', 'deleteDialogDescription');
  deleteDialog.innerHTML = `<form method="dialog"><span class="delete-dialog-icon">${icon('trash')}</span><h2 id="deleteDialogTitle"></h2><p class="delete-target" id="deleteDialogTarget"></p><p id="deleteDialogDescription"></p><div class="delete-dialog-actions"><button class="btn" value="cancel" autofocus>取消</button><button class="btn btn-delete-confirm" value="delete" id="confirmResourceDelete">确认删除</button></div></form>`;
  document.body.appendChild(deleteDialog);
  deleteDialog.addEventListener('click', e => { if (e.target === deleteDialog) deleteDialog.close('cancel'); });

  async function remove(kbId, docId = '') {
    if (sending || uploading) return toast('请等待当前任务完成后再删除');
    if (state.deleting) return;
    state.deleting = true;
    try {
      const kb = node(kbId) || knowledgeBases.find(k => k.kb_id === kbId);
      if (!kb) return toast('知识库不存在，请刷新后重试');
      const {docs} = await request('/api/kb/' + encodeURIComponent(kbId) + '/docs');
      const doc = docId ? docs.find(d => d.doc_id === docId) : null;
      if (docId && !doc) return toast('文档不存在，请刷新后重试');
      $('deleteDialogTitle').textContent = docId ? '删除这份文档？' : '删除这个知识库？';
      $('deleteDialogTarget').textContent = docId ? doc.doc_name : kb.name;
      $('deleteDialogDescription').textContent = docId
        ? '将删除该文档的索引和上传文件，其他文档不受影响。历史对话保留，删除后无法撤销。'
        : `将删除这个知识库及其中 ${docs.length} 份文档，包括文档索引和上传文件。历史对话保留，删除后无法撤销。`;
      deleteDialog.returnValue = 'cancel';
      const confirmed = await new Promise(resolve => {
        deleteDialog.addEventListener('close', () => resolve(deleteDialog.returnValue === 'delete'), {once: true});
        deleteDialog.showModal();
      });
      if (!confirmed) return;
      if (sending || uploading) return toast('当前任务正在执行，请完成后重试');
      const path = '/api/kb/' + encodeURIComponent(kbId) + (docId ? '/docs/' + encodeURIComponent(docId) : '');
      await request(path, {method: 'DELETE'});
      window.Studio?.closeDeletedReader(kbId, docId);
      if (!docId && activeKbId === kbId) {
        activeKbId = null; activeKbName = ''; activeConvId = null;
        closePanels(); syncSelection(); showWelcome();
      }
      await loadKBs(false);
      if (docId && activeKbId === kbId) await loadDocs();
      if (!docId && state.detailId === kbId) {
        await loadGraph();
        navigate('knowledge');
      } else await refresh();
      toast(docId ? '文档已删除' : '知识库已删除');
    } catch (e) { toast(e.message); }
    finally { state.deleting = false; }
  }

  function stopGalaxy() {
    const scene = state.galaxy?.snapshot(); state.galaxy?.stop(); state.galaxy = null; return scene;
  }
  function navigate(page = 'knowledge') {
    const hash = '#' + page;
    if (location.hash === hash) route(); else location.hash = hash;
  }
  function open(id) { navigate('knowledge/' + encodeURIComponent(id)); }
  async function loadGraph() {
    if (!state.pending) state.pending = request('/api/kb/graph').then(data => { state.data = data; return data; }).finally(() => { state.pending = null; });
    return state.pending;
  }
  async function refresh() {
    if (!isOpen()) { state.data = null; return; }
    try {
      await loadGraph();
      if (!isOpen()) return;
      if (state.detailId) await (state.view === 'galaxy' ? renderFocus(state.detailId) : renderDetail(state.detailId)); else renderOverview();
    } catch (e) { toast(e.message); }
  }
  function route() {
    const library = isOpen(), models = location.hash === '#models';
    document.querySelector('.app').classList.toggle('library-mode', library);
    $('knowledgePage').classList.toggle('galaxy-immersive', library && state.view === 'galaxy');
    $('knowledgePage').hidden = !library;
    $('modelsPage').hidden = !models;
    document.querySelector('.app').classList.toggle('models-mode', models);
    window.Models?.show(models);
    for (const [id, active] of [['navWorkspace', !library && !models], ['navKnowledge', library], ['navModels', models]]) {
      $(id).classList.toggle('active', active);
      if (active) $(id).setAttribute('aria-current', 'page'); else $(id).removeAttribute('aria-current');
    }
    window.Studio?.closeReader();
    closePanels();
    const keepScene = state.view === 'galaxy' && state.galaxy?.focus && location.hash.startsWith('#knowledge/');
    const origins = keepScene ? state.galaxy.snapshot() : stopGalaxy();
    $('libraryDetail').classList.remove('focus-shell');
    document.title = models ? 'PageIndex · 模型管理' : library ? 'PageIndex · 知识库' : 'PageIndex · 知识工作台';
    if (!library) { state.detailId = null; state.detailRequest++; return; }
    let id;
    try { id = decodeURIComponent(location.hash.split('/').slice(1).join('/')); } catch { id = ''; }
    state.detailId = id || null;
    $('libraryHome').hidden = !!id; $('libraryDetail').hidden = !id;
    if (!origins?.focused) $('knowledgePage').scrollTop = 0;
    if (id) state.view === 'galaxy' ? renderFocus(id, origins) : renderDetail(id);
    else if (state.data) renderOverview(origins);
    else {
      $('libraryContent').innerHTML = empty('正在连接知识空间', '汇集文档，连接每一份积累。', 'stars');
      $('libraryContent').setAttribute('aria-busy', 'true');
      loadGraph().then(() => { if (isOpen() && !state.detailId) renderOverview(); }).catch(e => {
        $('libraryContent').setAttribute('aria-busy', 'false');
        $('libraryContent').innerHTML = empty('暂时无法读取知识库', e.message);
      });
    }
  }
  function filtered() {
    const q = state.query.trim().toLocaleLowerCase();
    const nodes = (state.data?.nodes || []).filter(k => k.name.toLocaleLowerCase().includes(q));
    const ids = new Set(nodes.map(k => k.kb_id));
    return {nodes, links: (state.data?.links || []).filter(l => ids.has(l.source) && ids.has(l.target))};
  }
  function renderOverview(previous = null) {
    if (!isOpen() || state.detailId) return;
    $('knowledgePage').classList.toggle('galaxy-immersive', state.view === 'galaxy');
    previous ||= state.galaxy?.snapshot();
    stopGalaxy();
    const data = filtered();
    const stats = [[data.nodes.length, '知识库'], [data.nodes.reduce((n, k) => n + k.doc_count, 0), '知识文档'], [data.links.length, '库间关联']];
    $('libraryStats').innerHTML = stats.map(([n, label], i) => `<div class="library-stat${i === 2 ? ' gold' : ''}"><strong>${n}</strong><span>${label}</span></div>`).join('');
    for (const [id, view] of [['viewList', 'list'], ['viewGalaxy', 'galaxy']]) {
      $(id).classList.toggle('active', state.view === view); $(id).setAttribute('aria-pressed', String(state.view === view));
    }
    $('libraryContent').setAttribute('aria-busy', 'false');
    if (!data.nodes.length) $('libraryContent').innerHTML = empty(state.query ? '没有找到这个知识库' : '你的知识宇宙，等待第一颗星', state.query ? '换个关键词，继续探索。' : '点击“新建知识库”，为你的文档安一个家。', 'stars');
    else if (state.view === 'list') renderList(data);
    else renderGalaxy(data, previous);
    renderRelations(data.links);
  }
  function renderList(data) {
    $('libraryContent').innerHTML = `<div class="library-table-wrap"><table class="library-table"><thead><tr><th>知识库名称</th><th>文档</th><th class="page-column">页数</th><th class="connection-column">关联知识库</th><th><span class="section-en">EXPLORE</span></th></tr></thead><tbody>${data.nodes.map(k => {
      const count = connections(k.kb_id).length;
      return `<tr><td><button class="library-title-button" data-open-kb="${esc(k.kb_id)}"><span class="library-monogram" style="--cluster-color:${color(k.kb_id)}">${icon('book')}</span><span><span class="library-title-text">${esc(k.name)}</span><span class="library-title-preview">${esc(k.doc_names.join(' / ') || '等待添加第一份文档')}</span></span></button></td><td><span class="library-number">${k.doc_count}</span></td><td class="page-column">${k.page_count || '—'}</td><td class="connection-column">${count ? `<span class="connection-badge">${icon('link')}${count} 个关联</span>` : '<span class="meta">暂无关联</span>'}</td><td><div class="library-row-actions"><button class="library-enter" data-open-kb="${esc(k.kb_id)}" aria-label="进入 ${esc(k.name)}">进入 <span aria-hidden="true">↗</span></button>${deleteButton(k.kb_id, '', '删除')}</div></td></tr>`;
    }).join('')}</tbody></table></div>`;
  }
  function renderGalaxy(data, previous) {
    $('libraryContent').innerHTML = '<div class="neural-stage" id="galaxyStage"></div>';
    state.galaxy = window.NeuralGalaxy.mount($('galaxyStage'), data, {previous, onModule: open, onItem: openDocument});
  }
  function renderRelations(links) {
    $('relationPanel').innerHTML = '<h2>每一条连接，都有迹可循。</h2><p class="relation-description">依据同名文档，或至少两个有效的共同标题关键词推导。仅比较已索引的名称与章节标题，暂不进行全文语义分析。</p>' + (links.length ? links.map(l => `<div class="relation-item"><div class="relation-pair"><button data-open-kb="${esc(l.source)}">${esc(node(l.source)?.name)}</button>${icon('link')}<button data-open-kb="${esc(l.target)}">${esc(node(l.target)?.name)}</button></div><p class="relation-evidence">${esc(evidence(l))}</p></div>`).join('') : '<p class="relation-description">当前知识库之间尚未发现符合规则的关联，因此不会绘制连线。</p>');
  }
  async function renderFocus(id, origins) {
    origins ||= state.galaxy?.snapshot();
    const token = ++state.detailRequest;
    $('libraryHome').hidden = true; $('libraryDetail').hidden = false;
    $('libraryDetail').classList.add('focus-shell');
    if (!origins?.focused) $('libraryDetail').innerHTML = empty('正在展开知识星团', '沿着文档的脉络，发现更多内容。', 'stars');
    try {
      if (!state.data) await loadGraph();
      const kb = node(id);
      if (!kb) throw new Error('这个知识库不存在，或已经被删除。');
      const d = await request('/api/kb/' + encodeURIComponent(id) + '/docs');
      if (token !== state.detailRequest || !isOpen() || state.detailId !== id) return;
      state.docs = d.docs || [];
      document.title = kb.name + ' · 知识星团';
      if (state.galaxy) origins = stopGalaxy();
      $('libraryDetail').innerHTML = `<nav class="detail-crumbs" aria-label="星团路径"><button data-back-libraries>← 全部星团</button><span>/</span><span>${esc(kb.name)}</span></nav><header class="focus-heading"><div><p class="eyebrow">CONNECTED KNOWLEDGE</p><h1>${esc(kb.name)}</h1><p><span class="focus-doc-count">${state.docs.length} 份知识文档</span><span class="focus-description">沿着光丝，探索每一份知识。</span></p></div><div class="detail-header-actions"><button class="btn" data-upload-kb="${esc(id)}"${uploading ? ' disabled' : ''}>${icon('upload')}${uploading ? '正在索引…' : '添加文档'}</button><button class="btn btn-primary" data-chat-kb="${esc(id)}">${icon('chat')}进入问答</button><button class="btn" data-manage-kb="${esc(id)}">${icon('grid')}管理</button></div></header><div class="neural-stage" id="focusGalaxyStage"></div>`;
      state.galaxy = window.NeuralGalaxy.mount($('focusGalaxyStage'), state.data, {id, docs: state.docs, previous: origins, onModule: open, onItem: openDocument});
    } catch (e) {
      if (token !== state.detailRequest || !isOpen()) return;
      stopGalaxy();
      $('libraryDetail').innerHTML = '<nav class="detail-crumbs"><button data-back-libraries>← 全部星团</button></nav>' + empty('暂时无法展开知识库', e.message);
    }
  }

  function openDocument(id) {
    if (!state.detailId) return;
    state.galaxy?.selectDocument(id);
    window.Studio.openReader(state.detailId, id);
  }
  document.addEventListener('studio-reader-closed', () => state.galaxy?.selectDocument(null));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.querySelector('dialog[open]') && isOpen() && state.view === 'galaxy' && state.detailId) navigate('knowledge');
  });

  async function renderDetail(id) {
    const token = ++state.detailRequest;
    $('libraryHome').hidden = true; $('libraryDetail').hidden = false;
    $('libraryDetail').innerHTML = empty('正在打开知识库', '读取文档与关联信息…');
    try {
      if (!state.data) await loadGraph();
      const kb = node(id);
      if (!kb) throw new Error('这个知识库不存在，或已经被删除。');
      const d = await request('/api/kb/' + encodeURIComponent(id) + '/docs');
      if (token !== state.detailRequest || !isOpen() || state.detailId !== id) return;
      state.docs = d.docs || []; state.docsQuery = '';
      const links = connections(id);
      document.title = kb.name + ' · PageIndex';
      $('libraryDetail').innerHTML = `<nav class="detail-crumbs" aria-label="知识库路径"><button data-back-libraries>← 全部知识库</button><span>/</span><span>${esc(kb.name)}</span></nav><header class="library-heading"><div class="detail-title"><span class="library-monogram" style="--cluster-color:${color(id)}">${icon('book')}</span><div><p class="eyebrow">A CONSTELLATION OF IDEAS</p><h1>${esc(kb.name)}</h1></div></div><div class="detail-header-actions"><button class="btn" data-upload-kb="${esc(id)}"${uploading ? ' disabled' : ''}>${icon('upload')}${uploading ? '正在索引…' : '添加文档'}</button><button class="btn btn-primary" data-chat-kb="${esc(id)}">${icon('chat')}进入问答</button><button class="btn" data-manage-kb="${esc(id)}">${icon('grid')}管理</button></div></header><div class="library-stats"><div class="library-stat"><strong>${state.docs.length}</strong><span>知识文档</span></div><div class="library-stat"><strong>${state.docs.reduce((n, doc) => n + (doc.page_count || 0), 0) || '—'}</strong><span>文档页数</span></div><div class="library-stat gold"><strong>${links.length}</strong><span>关联知识库</span></div></div><section class="detail-section"><div class="detail-section-head"><div><h2>知识文档 <span class="section-en">DOCUMENTS</span></h2><p>每一页积累，都是下一次发现的起点。</p></div><label class="library-search">${icon('search')}<input type="search" id="detailSearch" placeholder="搜索文档…" aria-label="搜索文档"></label></div><div id="detailDocuments"></div></section><section class="detail-related"><h2>相邻的知识星团 <span class="section-en">CONNECTED LIBRARIES</span></h2>${links.length ? `<div class="related-grid">${links.map(l => { const other = node(l.source === id ? l.target : l.source); return `<button class="related-card" data-open-kb="${esc(other.kb_id)}"><strong>${esc(other.name)} ↗</strong><p>${esc(evidence(l))}</p></button>`; }).join('')}</div>` : '<p class="relation-description">暂未发现有依据的库间关联。文档与章节标题中的共同关键词会帮助星团建立连接。</p>'}</section>`;
      renderDocuments();
    } catch (e) {
      if (token !== state.detailRequest || !isOpen()) return;
      $('libraryDetail').innerHTML = `<nav class="detail-crumbs"><button data-back-libraries>← 全部知识库</button></nav>` + empty('暂时无法打开知识库', e.message);
    }
  }
  function renderDocuments() {
    const docs = state.docs.filter(d => d.doc_name.toLocaleLowerCase().includes(state.docsQuery.toLocaleLowerCase()));
    $('detailDocuments').innerHTML = docs.length ? `<div class="library-table-wrap"><table class="library-table"><thead><tr><th>文档名称</th><th>格式</th><th class="page-column">页数</th><th>状态</th><th>操作</th></tr></thead><tbody>${docs.map(d => `<tr><td><button class="library-title-button" data-open-document="${esc(d.doc_id)}"><span class="file-mark">${icon('doc')}</span><span class="library-title-text">${esc(d.doc_name)}</span></button></td><td><span class="detail-format">${/\.pdf$/i.test(d.doc_name) ? 'PDF' : /\.docx$/i.test(d.doc_name) ? 'DOCX' : /\.doc$/i.test(d.doc_name) ? 'DOC' : /\.(md|markdown)$/i.test(d.doc_name) ? 'MD' : '文档'}</span></td><td class="page-column">${d.page_count || '—'}</td><td><span class="index-status"><i class="status-dot"></i>已索引</span></td><td>${deleteButton(state.detailId, d.doc_id, '删除文档')}</td></tr>`).join('')}</tbody></table></div>` : empty(state.docsQuery ? '没有匹配的文档' : '还没有文档', state.docsQuery ? '换个关键词试试。' : '点击“添加文档”，上传 PDF、Word 或 Markdown 文件。', 'doc');
  }
  document.querySelector('.top-nav').addEventListener('click', e => { const b = e.target.closest('[data-route]'); if (b) navigate(b.dataset.route); });
  $('librarySearch').addEventListener('input', e => { state.query = e.target.value; renderOverview(); });
  document.querySelector('.view-switch').addEventListener('click', e => {
    const b = e.target.closest('[data-view]'); if (!b || b.dataset.view === state.view) return;
    state.view = b.dataset.view; try { localStorage.setItem('pageindex-library-view', state.view); } catch {}
    renderOverview();
  });
  $('relationToggle').addEventListener('click', () => { $('relationPanel').hidden = !$('relationPanel').hidden; $('relationToggle').setAttribute('aria-expanded', String(!$('relationPanel').hidden)); });
  $('knowledgePage').addEventListener('click', e => {
    const manage = e.target.closest('[data-manage-kb]');
    if (manage) { window.Studio.manageLibrary(manage.dataset.manageKb); return; }
    const removeButton = e.target.closest('[data-delete-kb]');
    if (removeButton) { remove(removeButton.dataset.deleteKb, removeButton.dataset.deleteDoc); return; }
    const documentButton = e.target.closest('[data-open-document]');
    if (documentButton) { openDocument(documentButton.dataset.openDocument); return; }
    const openButton = e.target.closest('[data-open-kb]'), chat = e.target.closest('[data-chat-kb]'), upload = e.target.closest('[data-upload-kb]');
    if (openButton) open(openButton.dataset.openKb);
    else if (e.target.closest('[data-back-libraries]')) navigate('knowledge');
    else if (chat || upload) {
      if (sending || uploading) return toast('请等待当前任务完成');
      const kb = node((chat || upload).dataset[chat ? 'chatKb' : 'uploadKb']); if (!kb) return;
      selectKB(kb.kb_id, kb.name, !!chat);
      if (upload) $('fileInput').click();
    }
  });
  $('libraryDetail').addEventListener('input', e => { if (e.target.id === 'detailSearch') { state.docsQuery = e.target.value; renderDocuments(); } });
  window.addEventListener('hashchange', route);

  route();
  return {navigate, open, refresh, isOpen, remove};
})();
