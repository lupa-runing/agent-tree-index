/* 知识工作室：阅读与证据、索引任务、模型路由和云端空间。 */
window.Studio = (() => {
  const api = '/api/studio', json = body => ({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const state = {reader:null, readerToken:0, pageToken:0, models:null, settings:null, tab:'tasks', jobs:[], jobsInitialized:false, scope:new Map(), controller:null, folder:'root', offset:0, folders:[], cloudDocs:[], cloudTrail:[], panelToken:0};
  const date = v => v ? new Date(v*1000).toLocaleString('zh-CN',{hour12:false}) : '未记录';
  const number = n => Number(n||0).toLocaleString('zh-CN');
  const base = (kid,did) => api+'/kb/'+encodeURIComponent(kid)+'/docs/'+encodeURIComponent(did);
  const statusName = s => ({queued:'排队中',running:'处理中',completed:'已完成',failed:'失败',cancelled:'已取消',cancelling:'正在取消',interrupted:'已中断',stopped:'已停止'})[s]||s;
  function dialog(id,title,cls='') {
    const el=document.createElement('dialog');el.id=id;el.className='studio-dialog '+cls;el.setAttribute('aria-labelledby',id+'Title');
    el.innerHTML=`<header class="studio-dialog-head"><div><span class="studio-kicker">PAGEINDEX STUDIO</span><h2 id="${id}Title">${title}</h2></div><button type="button" class="btn-ghost" data-close-studio aria-label="关闭${title}">${icon('close')}</button></header><div class="studio-dialog-body"></div>`;
    document.body.appendChild(el);el.addEventListener('click',e=>{if(e.target===el||e.target.closest('[data-close-studio]'))el.close()});return el;
  }
  const reader=dialog('studioReader','文档阅读室','reader-dialog');
  const control=dialog('studioControl','控制中心','control-dialog');
  const editor=dialog('studioEditor','编辑','editor-dialog');
  const uploader=dialog('studioUpload','添加知识文档','upload-dialog');
  const scopeDialog=dialog('studioScope','选择问答范围','scope-dialog');
  const inputViewer=dialog('studioModelInput','模型输入','model-input-dialog');
  const inputTraces=new Map();let inputView=null;
  const body = el => el.querySelector('.studio-dialog-body');
  function open(el){if(!el.open)el.showModal()}
  function empty(title,text=''){return `<div class="studio-empty">${icon('book')}<h3>${esc(title)}</h3><p>${esc(text)}</p></div>`}
  function error(el,e){body(el).innerHTML=empty('暂时无法读取',e.message)}
  function download(kid,did,kind){return base(kid,did)+'/export/'+kind}
  reader.addEventListener('close',()=>{state.readerToken++;state.pageToken++;state.reader=null;document.dispatchEvent(new Event('studio-reader-closed'))});
  const launch=document.createElement('button');launch.className='studio-launch';launch.id='studioLaunch';launch.setAttribute('aria-label','打开控制中心');launch.title='索引任务、用量与云端空间';launch.innerHTML=icon('grid')+'<span>控制中心</span><b id="studioJobBadge" hidden></b>';
  const topbarTools=document.createElement('div');topbarTools.className='topbar-tools';const topbarMeta=document.querySelector('.top-meta');topbarMeta.before(topbarTools);topbarTools.append(topbarMeta,launch);launch.addEventListener('click',()=>openControl('tasks'));
  const scopeBar=document.createElement('div');scopeBar.className='chat-scope-controls';
  scopeBar.innerHTML=`<button class="scope-trigger" id="studioScopeButton">${icon('book')}<span>全部文档</span></button><label><span class="sr-only">检索方式</span><select id="studioRetrieval"><option value="tree">PageIndex 树检索</option><option value="hybrid">混合检索</option><option value="vector">向量检索</option></select></label><span class="spacer"></span><button id="studioStop" class="stop-generation" hidden>${icon('close')}停止生成</button>`;
  document.querySelector('.composer').prepend(scopeBar);
  $('studioScopeButton').addEventListener('click',selectScope);$('studioStop').addEventListener('click',()=>state.controller?.abort());

  async function form(title,html,save) {
    if(editor.open)return;
    $('studioEditorTitle').textContent=title;
    body(editor).innerHTML=`<form class="studio-form">${html}<p class="studio-form-error" role="alert" hidden></p><footer><button type="button" class="btn" data-cancel-form>取消</button><button class="btn btn-primary" type="submit">保存</button></footer></form>`;
    const f=body(editor).querySelector('form');f.querySelector('[data-cancel-form]').onclick=()=>editor.close();
    f.onsubmit=async e=>{e.preventDefault();const button=f.querySelector('[type=submit]'),err=f.querySelector('[role=alert]');button.disabled=true;err.hidden=true;try{await save(new FormData(f));editor.close()}catch(e){err.textContent=e.message;err.hidden=false}finally{button.disabled=false}};open(editor);
  }
  function field(label,name,value='',type='text',extra=''){return `<label class="studio-field"><span>${label}</span><input type="${type}" name="${name}" value="${esc(value)}" ${extra}></label>`}
  function modelOptions(role,selected){const kind=role==='vision'?'vision':role==='embedding'?'embedding':'chat';return `<option value="">${role==='vision'?'跟随默认视觉模型':'跟随默认配置'}</option><option value="environment"${selected==='environment'?' selected':''}>${role==='vision'?'使用环境 OCR 配置':'使用环境模型'}</option>`+(state.models?.models||[]).filter(m=>m.kind===kind).map(m=>`<option value="${esc(m.id)}"${m.id===selected?' selected':''}>${esc(m.provider_name+' / '+m.model)}</option>`).join('')}

  async function openReader(kid,did,page=1) {
    const token=++state.readerToken;state.pageToken++;state.reader={kid,did,page,mode:'original'};
    reader.classList.add('reader-dialog');body(reader).innerHTML=empty('正在打开文档','读取目录与原文…');open(reader);
    try{
      let doc;try{doc=await request('/api/kb/'+encodeURIComponent(kid)+'/docs/'+encodeURIComponent(did))}catch{const location=await request(api+'/docs/'+encodeURIComponent(did)+'/location');kid=location.kb_id;doc=await request('/api/kb/'+encodeURIComponent(kid)+'/docs/'+encodeURIComponent(did))}
      if(token!==state.readerToken||!reader.open)return;
      state.reader={kid,did,page:Math.min(Math.max(1,page),doc.page_count||1),mode:doc.type==='pdf'?'original':'text',zoom:'page',doc};
      const tree=(nodes,depth=0)=>nodes.map(n=>`<div class="reader-tree-node" style="--depth:${depth}"><button data-reader-page="${n.start_index||1}" title="${esc(n.title)}"><span>${esc(n.title)}</span><small>${n.start_index?'p'+n.start_index:''}</small></button>${n.summary?`<details><summary>章节摘要</summary><p>${esc(n.summary)}</p></details>`:''}${tree(n.nodes||[],depth+1)}</div>`).join('');
      body(reader).innerHTML=`<div class="reader-title"><div><span class="studio-kicker">A CLOSER LOOK AT YOUR KNOWLEDGE</span><h1>${esc(doc.doc_name)}</h1><div class="reader-document-meta"><span>${esc(doc.kb_name)}</span><span>${doc.source_type?doc.source_type.toUpperCase():doc.type==='pdf'?'PDF':'Markdown'}</span>${doc.source_type?'<span>PDF 阅读版</span>':''}<span>${doc.page_count||'—'} 页</span><span>${doc.indexed_at?'索引于 '+date(doc.indexed_at):'已索引'}</span></div></div><div class="reader-tools"><button class="btn" data-reader-ask>${icon('chat')}问这篇</button><button class="btn" data-doc-manage>${icon('grid')}管理文档</button><details class="export-menu"><summary class="btn">${icon('doc')}导出</summary><nav>${[['original',doc.source_type?'Word 原件':'原始文件'],...(doc.source_type?[['pdf','PDF 阅读版']]:[]),['tree','目录 JSON'],['summary','章节摘要'],['text','提取内容 Markdown'],['html','含表格原文 HTML']].map(([key,label])=>`<a href="${download(kid,did,key)}">${label} ↗</a>`).join('')}</nav></details><button class="library-delete" data-reader-delete>${icon('trash')}删除</button></div></div><div class="reader-layout"><aside class="reader-outline"><div class="reader-outline-head"><span>文档目录</span><small>${countNodes(doc.structure)} 个节点</small></div>${doc.description?`<details class="reader-overview"><summary>文档概览</summary><p>${esc(doc.description)}</p></details>`:''}<div class="reader-tree">${tree(doc.structure)||'<p class="meta">暂无目录，可在管理中重建索引。</p>'}</div></aside><main class="reader-main"><div class="reader-page-toolbar"><div class="studio-segments"><button data-reader-mode="original"${doc.type!=='pdf'?' disabled':''}>${doc.source_type?'PDF 阅读版':'原文'}</button><button data-reader-mode="text">提取文本</button><button data-reader-mode="summary">摘要</button></div><div class="reader-pagination"><select id="readerZoom" aria-label="原文缩放"><option value="page">整页</option><option value="width">适宽</option><option value="large">放大 150%</option></select><button class="btn-ghost" data-page-delta="-1" aria-label="上一页">←</button><label>第 <input id="readerPageInput" type="number" min="1" max="${doc.page_count||1}" value="${state.reader.page}" aria-label="文档页码"> / ${doc.page_count||1} 页</label><button class="btn-ghost" data-page-delta="1" aria-label="下一页">→</button></div></div><div class="reader-page" id="readerPage"></div><p class="reader-footnote" id="readerFootnote">原文与索引摘要分开展示，引用按实际 PDF 页码定位。</p></main></div>`;
      await renderPage();
    }catch(e){if(token===state.readerToken)error(reader,e)}
  }
  function countNodes(nodes){return(nodes||[]).reduce((a,n)=>a+1+countNodes(n.nodes),0)}
  function flatten(nodes){return(nodes||[]).flatMap(n=>[n,...flatten(n.nodes)])}
  async function renderPage(){
    const r=state.reader;if(!r?.doc)return;const token=++state.pageToken;
    const page=$('readerPage');page.className='reader-page zoom-'+r.zoom;page.style.setProperty('--reader-height',Math.max(120,page.clientHeight-50)+'px');$('readerPageInput').value=r.page;$('readerZoom').disabled=r.mode!=='original';
    reader.querySelectorAll('[data-reader-mode]').forEach(b=>b.classList.toggle('active',b.dataset.readerMode===r.mode));
    reader.querySelectorAll('[data-reader-page]').forEach(b=>b.classList.toggle('active',Number(b.dataset.readerPage)===r.page));
    if(r.mode==='original'){
      page.innerHTML=`<img class="reader-page-image" alt="${esc(r.doc.doc_name)} 第 ${r.page} 页" src="${base(r.kid,r.did)}/image/${r.page}">`;
      const img=page.querySelector('img');img.onerror=()=>{if(token===state.pageToken)page.innerHTML=empty('原文页面暂不可用','可切换提取文本查看，或下载原始文件。')};
      $('readerFootnote').textContent=(r.doc.source_type?'Word 转换后的 PDF 阅读版，页码与引用按此版本定位 · 第 ':'正在阅读原始 PDF · 第 ')+r.page+' 页';
    }else if(r.mode==='summary'){
      const nodes=flatten(r.doc.structure).filter(n=>(n.start_index||1)<=r.page&&(n.end_index||n.start_index||1)>=r.page);
      page.innerHTML=`<article class="reader-text"><span class="studio-kicker">SECTION INSIGHTS</span><h2>第 ${r.page} 页 · 章节摘要</h2>${nodes.map(n=>`<section><h3>${esc(n.title)}</h3><p>${esc(n.summary||'该章节没有摘要，可在重建索引时开启摘要。')}</p></section>`).join('')||'<p>当前页没有对应章节摘要。</p>'}</article>`;
      $('readerFootnote').textContent='摘要由模型生成；需要核对细节时请切换原文。';
    }else{
      page.innerHTML=empty('正在读取页面文字');
      try{const data=await request(base(r.kid,r.did)+'/page/'+r.page);if(token!==state.pageToken)return;r.pageContent=data;page.classList.toggle('has-tables',data.table_count>0);page.innerHTML=renderContent(data,r);$('readerFootnote').textContent=data.table_count?`已识别 ${data.table_count} 张表格 · 合并单元格按原始结构保留 · CSV 会展开为完整行。`:(data.ocr?'该页使用视觉 OCR 识别，请结合原文核对。':'按阅读顺序提取的页面文字；复杂排版可能与原文不同。');if(data.notes?.length)$('readerFootnote').textContent+=' '+data.notes.join(' ')}catch(e){if(token===state.pageToken)page.innerHTML=empty('读取失败',e.message)}
    }
  }
  function renderContent(data,r) {
    if(!data.blocks?.length)return `<article class="reader-text"><span class="studio-kicker">EXTRACTED TEXT · PAGE ${r.page}</span><pre>${esc(data.text||'该页没有可提取的文字。扫描件可配置视觉模型后重建索引。')}</pre></article>`;
    return `<article class="reader-text${data.table_count?' structured-content':''}"><span class="studio-kicker">${data.ocr?'VISION OCR':'EXTRACTED CONTENT'} · PAGE ${r.page}${data.table_count?' · '+data.table_count+' TABLES':''}</span>${data.blocks.map(b=>{
      if(b.type!=='table')return `<p class="reader-content-text">${esc(b.text)}</p>`;
      const rows=Array.from({length:b.row_count},()=>[]);for(const cell of b.cells)if(rows[cell.row])rows[cell.row].push(cell);
      const renderRows=(start,end)=>rows.slice(start,end).map((cells,i)=>`<tr>${cells.sort((a,b)=>a.col-b.col).map(c=>{const tag=start+i<b.header_rows?'th':'td',numeric=/^[\d.,%+−-]+$/.test(c.text||'');return `<${tag}${tag==='th'?` scope="${c.colspan>1?'colgroup':'col'}"`:''}${c.rowspan>1?` rowspan="${Number(c.rowspan)}"`:''}${c.colspan>1?` colspan="${Number(c.colspan)}"`:''} class="${numeric?'numeric-cell':''}">${esc(c.text||'')}</${tag}>`}).join('')}</tr>`).join('');
      return `<figure class="reader-table"><figcaption><div><strong>表 ${b.index}</strong><span>${b.row_count-b.header_rows} 行数据 · ${b.col_count} 列${b.header_rows>1?' · '+b.header_rows+' 层表头':''}</span></div><div class="reader-table-actions"><button data-copy-table="${b.index}">复制 Markdown</button><a href="${base(r.kid,r.did)}/table/${r.page}/${b.index}.csv">下载 CSV ↗</a></div></figcaption><div class="reader-table-scroll" tabindex="0" aria-label="第 ${b.index} 张表，可横向滚动"><table style="--table-columns:${b.col_count}">${b.header_rows?'<thead>'+renderRows(0,b.header_rows)+'</thead>':''}<tbody>${renderRows(b.header_rows,b.row_count)}</tbody></table></div>${b.source==='pdf-text'?'<p class="table-detection-note">按文字对齐识别，建议结合原文核对表头与边界。</p>':''}</figure>`;
    }).join('')}</article>`;
  }
  reader.addEventListener('click',async e=>{
    const r=state.reader;if(!r?.doc)return;
    const copy=e.target.closest('[data-copy-table]');if(copy){const table=r.pageContent?.blocks.find(b=>b.type==='table'&&b.index===Number(copy.dataset.copyTable));if(table)try{await navigator.clipboard.writeText(table.markdown);toast('表格已复制，合并单元格使用 HTML 保留')}catch{toast('复制未成功，可通过导出保存表格')}return}
    const page=e.target.closest('[data-reader-page]'),mode=e.target.closest('[data-reader-mode]'),delta=e.target.closest('[data-page-delta]');
    if(page||mode||delta){if(mode)r.mode=mode.dataset.readerMode;if(page)r.page=Number(page.dataset.readerPage);if(delta)r.page=Math.min(r.doc.page_count||1,Math.max(1,r.page+Number(delta.dataset.pageDelta)));renderPage()}
    else if(e.target.closest('[data-reader-delete]'))window.Knowledge.remove(r.kid,r.did);
    else if(e.target.closest('[data-doc-manage]'))manageDocument(r);
    else if(e.target.closest('[data-reader-ask]')){state.scope.set(r.kid,[r.did]);reader.close();if(control.open)control.close();const kb=knowledgeBases.find(k=>k.kb_id===r.kid);selectKB(r.kid,kb?.name||r.doc.kb_name);syncKB()}
  });
  reader.addEventListener('change',e=>{if(e.target.id==='readerZoom'&&state.reader){state.reader.zoom=e.target.value;renderPage()}if(e.target.id==='readerPageInput'&&state.reader){state.reader.page=Math.min(state.reader.doc.page_count||1,Math.max(1,Number(e.target.value)||1));renderPage()}});
  function closeReader(){if(reader.open)reader.close()}
  function closeDeletedReader(kid,did){if(reader.open&&state.reader?.kid===kid&&(!did||state.reader.did===did))reader.close()}

  async function manageLibrary(kid){
    const kb=knowledgeBases.find(k=>k.kb_id===kid);if(!kb)return;
    await form('管理知识库',field('知识库名称','name',kb.name,'text','maxlength="120" required')+`<p class="studio-help">名称更新后会同步显示在列表和星团中。</p><div class="studio-danger-zone"><span>删除整个知识库及其中的文档</span><button type="button" class="library-delete" id="manageDeleteKb">${icon('trash')}删除知识库</button></div>`,async fd=>{await request(api+'/kb/'+encodeURIComponent(kid),{...json({name:fd.get('name')}),method:'PATCH'});await loadKBs();if(activeKbId===kid){activeKbName=fd.get('name');syncSelection()}toast('知识库名称已更新')});
    $('manageDeleteKb').onclick=()=>{editor.close();window.Knowledge.remove(kid)};
  }
  async function manageDocument(r){
    await form('管理文档',field('文档名称','name',r.doc.doc_name,'text','maxlength="240" required')+`<label class="studio-field"><span>所属知识库</span><select name="target_kb_id">${knowledgeBases.map(k=>`<option value="${esc(k.kb_id)}"${k.kb_id===r.kid?' selected':''}>${esc(k.name)}</option>`).join('')}</select></label><p class="studio-help">移动会更新文档归属，原始文件保持不变。</p><div class="studio-form-divider"></div><button type="button" class="btn" id="readerReindex">${icon('tree')}重建索引</button><p class="studio-help">可切换索引模式与模型，完成后才替换现有索引。</p>`,async fd=>{await request(base(r.kid,r.did),{...json({name:fd.get('name'),target_kb_id:fd.get('target_kb_id')}),method:'PATCH'});reader.close();await loadKBs();await loadDocs();toast('文档信息已更新')});
    $('readerReindex').onclick=()=>{editor.close();prepareUpload([],r.kid,{id:r.did,doc:r.doc})};
  }
  async function selectScope(){
    if(!activeKbId)return toast('先选择一个知识库');const kid=activeKbId;
    try{const data=await request('/api/kb/'+encodeURIComponent(kid)+'/docs');const selected=state.scope.get(kid)||[];
      body(scopeDialog).innerHTML=`<p class="studio-intro">选择参与本次问答的文档。留空代表当前知识库全部文档。</p><div class="scope-list">${data.docs.map(d=>`<label><input type="checkbox" value="${esc(d.doc_id)}"${selected.includes(d.doc_id)?' checked':''}>${icon('doc')}<span>${esc(d.doc_name)}</span></label>`).join('')||empty('还没有文档')}</div><footer class="studio-footer"><button class="btn" id="scopeAll">使用全部文档</button><button class="btn btn-primary" id="scopeApply">应用范围</button></footer>`;
      $('scopeAll').onclick=()=>{state.scope.set(kid,[]);scopeDialog.close();syncKB()};$('scopeApply').onclick=()=>{state.scope.set(kid,[...scopeDialog.querySelectorAll('input:checked')].map(i=>i.value));scopeDialog.close();syncKB()};open(scopeDialog);
    }catch(e){toast(e.message)}
  }
  function syncKB(){const ids=state.scope.get(activeKbId)||[];$('studioScopeButton').disabled=!activeKbId;$('studioScopeButton').querySelector('span').textContent=ids.length?'已选 '+ids.length+' 份文档':'全部文档';$('studioRetrieval').disabled=!activeKbId}
  function renderProcess(refs,steps,status,modelInput){
    if(!steps.length&&!modelInput)return '';
    const running=status==='running',last=steps.at(-1),writing=last?.title==='组织回答';
    const label=running?(writing?'正在生成回答':'正在检索与阅读'):({completed:'检索已完成',stopped:'生成已停止',failed:'请求未完成'})[status]||'检索记录';
    const title=running?(last?.title||'正在准备检索'):refs.length?`已读取 ${refs.length} 处原文证据`:(status==='failed'?'这次请求没有完成':'本次检索记录');
    const detail=running?(last?.detail||'正在连接文档与模型服务'):refs.length?`来自 ${new Set(refs.map(r=>r.doc_id||r.doc_name)).size} 份文档，可通过引用核对原文。`:(status==='stopped'?'已保留停止前的检索过程与模型输入。':'可展开过程，查看本次检索的处理记录。');
    const input=modelInput?`<button class="process-input" data-model-input="${esc(modelInput.trace_id)}" data-input-conv="${esc(modelInput.conv_id||'')}">${icon('doc')}<span>查看模型输入</span><span aria-hidden="true">↗</span></button>`:'';
    const metrics=modelInput?`<span class="process-metrics"><span>${number(modelInput.call_count)} 次调用</span><i></i><span>${modelInput.context_chars?number(modelInput.context_chars)+' 字符原文':running?'原文准备中':'暂无原文证据'}${modelInput.truncated?' · 已截断':''}</span></span>`:'';
    const trace=steps.length?`<details class="retrieval-trace"><summary><span>检索过程</span><small>${steps.length} 个步骤</small><span class="trace-chevron" aria-hidden="true">⌄</span></summary><ol>${steps.map((s,i)=>`<li${running&&i===steps.length-1?' class="trace-current"':''}><strong>${esc(s.title)}</strong><span>${esc(s.detail||'')}</span></li>`).join('')}</ol></details>`:'';
    return `<section class="answer-process process-${esc(status)}" aria-label="本次检索状态"><header><span class="process-status"><i aria-hidden="true"></i>${label}</span>${input}</header><div class="process-current"><strong>${esc(title)}</strong><p>${esc(detail)}</p></div><footer>${trace}${metrics}</footer></section>`;
  }
  function renderAnswer(text,refs=[],steps=[],usage=null,status='completed',reasoning='',modelInput=null){
    const cited=(text||'').split(/```[^\n]*\n([\s\S]*?)```/g).map((part,i)=>i%2?`<pre class="answer-code"><code>${esc(part)}</code></pre>`:esc(part).replace(/^#{1,4} (.+)$/gm,'<h3>$1</h3>').replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>').replace(/`([^`\n]+)`/g,'<code>$1</code>').replace(/^[-*] (.+)$/gm,'<span class="answer-list-item">• $1</span>').replace(/\[(\d+)\]/g,(all,index)=>{const r=refs[Number(index)-1];return r?.doc_id?`<button class="inline-citation" data-reader-kb="${esc(r.kb_id)}" data-reader-doc="${esc(r.doc_id)}" data-cite-page="${Number(r.page)||1}" title="${esc(r.doc_name)}">${index}</button>`:all})).join('');
    const trace=renderProcess(refs,steps,status,modelInput)||(reasoning?`<details class="reasoning-box"><summary>查看检索说明</summary><div class="reasoning-body">${esc(reasoning)}</div></details>`:'');
    const pending=`<div class="answer-pending" role="status"><span class="pending-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>${status==='running'?'正在阅读证据，为你整理答案':'暂无回答内容'}</span></div>`;
    const legacy=refs.length&&!modelInput?'<p class="model-input-legacy">旧回答未记录模型输入，重新提问后可查看。</p>':'';
    return trace+(cited?`<div class="msg-b answer-content">${cited}</div>`:pending)+legacy+(refs.length?`<div class="citation-cards">${refs.map((r,i)=>`<button class="citation-card" ${r.doc_id?`data-reader-kb="${esc(r.kb_id)}" data-reader-doc="${esc(r.doc_id)}" data-cite-page="${Number(r.page)||1}"`:`data-source-name="${esc(r.doc_name)}" data-cite-page="${Number((r.pages||'1').match(/\d+/)?.[0])||1}"`}><b>${i+1}</b><span><strong>${esc(r.doc_name||r.title)}</strong><small>${esc(r.title||'')} · ${esc(r.pages||'')}</small></span>${icon('doc')}</button>`).join('')}</div>`:'')+(usage||status==='stopped'?`<div class="answer-usage">${status==='stopped'?'已停止 · ':''}${usage?(usage.reported===false?'服务未返回用量':number(usage.total_tokens)+' Token'):'已保留部分回答'} <button data-open-control="usage">查看用量 ↗</button></div>`:'');
  }
  function updateInputTrace(ev){
    const id=ev.trace?.trace_id||ev.trace_id;let t=inputTraces.get(id);
    if(!t&&ev.trace){t={id,conv_id:ev.trace.conv_id,retrieval_mode:ev.trace.retrieval_mode,status:'running',calls:[],context:null};inputTraces.set(id,t)}
    if(!t)return;
    if(ev.call&&!t.calls.some(c=>c.id===ev.call.id))t.calls.push(ev.call);
    if(ev.context)t.context=ev.context;
    if(ev.type==='model_input_status'){const c=t.calls.find(c=>c.id===ev.call_id);if(c)Object.assign(c,{status:ev.status,duration_ms:ev.duration_ms})}
    if(inputViewer.open&&inputView?.id===id)renderInputView();
  }
  const inputStage=c=>({retrieval:'目录与章节筛选',embedding_query:'问题向量编码',embedding_documents:'文档向量编码',answer:'生成回答'})[c.stage]||'模型调用';
  const inputStatus=c=>({calling:'正在调用',returned:c.request?.stream?'已返回响应流':'接口已返回',failed:'调用失败'})[c.status]||c.status;
  async function openInputTrace(id,cid,refresh=false){
    if(!refresh)inputView={id,cid,tab:'context',call:null,wrap:false,format:'messages'};
    const cached=inputTraces.get(id);if(!cached)body(inputViewer).innerHTML=empty('正在读取模型输入');open(inputViewer);
    if(cached){renderInputView();if(cached.status==='running'&&!refresh)return}
    try{const t=await request(api+'/conversations/'+encodeURIComponent(cid)+'/model-inputs/'+encodeURIComponent(id));inputTraces.set(id,t);if(inputViewer.open&&inputView?.id===id)renderInputView()}catch(e){if(inputView?.id!==id)return;if(cached){cached.pending_save=true;renderInputView();if(refresh)toast('已接收的输入仍可查看；历史快照尚不可读取，可稍后刷新')}else error(inputViewer,e)}
  }
  function renderInputView(reset=false){
    const v=inputView,t=inputTraces.get(v?.id);if(!t)return;
    const previous=reset?0:body(inputViewer).querySelector('.model-input-content')?.scrollTop||0;
    const context=t.context,calls=t.calls||[],answerCall=calls.find(c=>c.stage==='answer');
    const current=calls.find(c=>c.id===v.call)||answerCall||calls.at(-1);if(current)v.call=current.id;
    const mode=({tree:'PageIndex 树检索',vector:'向量检索',hybrid:'混合检索'})[t.retrieval_mode]||'检索';
    const roleName=role=>({system:'系统提示',user:'用户消息',assistant:'历史回答',tool:'工具结果'})[role]||role;
    let content;
    if(v.tab==='context'){
      content=context?`<div class="input-context-summary"><div><span>实际原文</span><strong>${number(context.sent_chars)} <small>字符</small></strong></div><div><span>进入上下文的来源</span><strong>${number(context.included_count)} <small>/ ${number(context.retrieved_count)}</small></strong></div><div><span>完整性</span><strong>${context.truncated?'已截断':context.refs.some(r=>r.page_limited)?'有页数限制':'保留完整'}<small>${context.truncated?'原文 '+number(context.original_chars)+' 字符':''}</small></strong></div></div><p class="input-explanation">${answerCall?'下方内容逐字来自本次回答请求的「原文证据」，没有再次提取或概括。':'已准备下方检索上下文；尚无回答模型调用记录。'}上限 ${number(context.char_limit)} 字符，每个命中章节最多读取 ${context.node_page_limit} 页。${context.truncated?'超出上限的尾部已截去，以下展示截断后实际使用的内容。':''}</p>${context.refs.length?`<div class="input-source-list">${context.refs.map((r,i)=>`<button data-reader-kb="${esc(r.kb_id)}" data-reader-doc="${esc(r.doc_id)}" data-cite-page="${Number(r.page)||1}"><b>${i+1}</b><span>${esc(r.doc_name)}<small>${esc(r.pages)} · ${number(r.included_chars)} 字符${r.truncated?' · 此来源部分截断':''}${r.page_limited?' · 章节页数已限制':''}</small></span>${icon('doc')}</button>`).join('')}</div>`:''}<pre class="model-input-pre" aria-label="实际检索上下文">${esc(context.text||'没有可用原文证据，本次未调用回答模型。')}</pre>`:empty('检索尚未完成','可切换“完整调用”，查看已经提交给模型的目录、摘要或向量输入。');
    }else if(current){
      const request=current.request,parameters=Object.fromEntries(Object.entries(request).filter(([k])=>!['messages','input','model'].includes(k)));
      const messages=Array.isArray(request.messages)?request.messages.map((m,i)=>`<section class="input-message"><header><strong>${esc(roleName(m.role))}</strong><span>${esc(m.role)} · #${i+1}</span></header><pre class="model-input-pre">${esc(typeof m.content==='string'?m.content:JSON.stringify(m.content,null,2))}</pre></section>`).join(''):'';
      const inputs=Array.isArray(request.input)?request.input:[request.input];
      content=`<div class="model-call-layout"><nav class="model-call-list" aria-label="本次模型调用">${calls.map(c=>`<button data-input-call="${esc(c.id)}" class="${c.id===current.id?'active':''}"><small>CALL ${String(c.sequence).padStart(2,'0')}</small><strong>${esc(inputStage(c))}</strong><span>${esc(c.request.model)}</span><em>${esc(inputStatus(c))}</em></button>`).join('')}</nav><div class="model-call-detail"><div class="input-call-heading"><div><span class="studio-kicker">CALL ${current.sequence} · ${esc(current.transport)}</span><h3>${esc(inputStage(current))}</h3><p>${esc(request.model)} · ${esc(inputStatus(current))}${current.duration_ms!=null?' · '+number(current.duration_ms)+' ms':''}</p></div><div class="input-call-actions"><button class="btn" data-input-format>${v.format==='json'?'按消息查看':'显示 JSON'}</button><button class="btn" data-input-copy-call>复制请求 JSON</button></div></div>${v.format==='json'?`<pre class="model-input-pre" aria-label="完整请求 JSON">${esc(JSON.stringify(request,null,2))}</pre>`:`<details class="input-parameters"><summary>调用参数</summary><pre class="model-input-pre">${esc(JSON.stringify(parameters,null,2))}</pre></details>${messages}${request.input!==undefined?inputs.map((text,i)=>`<section class="input-message"><header><strong>向量输入 ${i+1}</strong><span>${number([...String(text)].length)} 字符</span></header><pre class="model-input-pre">${esc(typeof text==='string'?text:JSON.stringify(text,null,2))}</pre></section>`).join(''):''}`}</div></div>`;
    }else content=empty('尚未发起模型调用','这次请求还未提交内容，或未找到可检索的文档。');
    body(inputViewer).innerHTML=`<div class="model-input-heading"><div><span class="studio-kicker">MODEL INPUT · CAPTURED AT CALL TIME</span><h3>模型看到了什么</h3><p>${esc(mode)} · ${calls.length} 次调用 · ${statusName(t.status)}</p></div><div><button class="btn" data-input-reload>刷新记录</button><button class="btn" data-input-wrap aria-pressed="${v.wrap}">${v.wrap?'关闭换行':'自动换行'}</button><button class="btn" data-input-copy-context${!context?' disabled':''}>复制检索原文</button><button class="btn" data-input-download>下载完整 JSON</button></div></div><div class="model-input-tabs" role="tablist" aria-label="模型输入视图"><button role="tab" aria-selected="${v.tab==='context'}" data-input-tab="context">检索原文 <small>${context?number(context.sent_chars)+' 字符':'等待检索'}</small></button><button role="tab" aria-selected="${v.tab==='calls'}" data-input-tab="calls">完整调用 <small>${calls.length}</small></button></div><div class="model-input-content${v.wrap?' wrap-text':''}">${content}</div><footer class="model-input-footnote">${t.pending_save?'历史快照尚不可读取，当前展示本页已接收的实时输入；停止后可稍后刷新。 ' : ''}调用时采集应用提交给 SDK 的原始输入，包含系统提示、历史消息与问题。记录不含连接密钥；服务商内部的处理不在此展示。</footer>`;
    body(inputViewer).querySelector('.model-input-content').scrollTop=previous;
  }
  inputViewer.addEventListener('click',async e=>{
    const v=inputView,t=inputTraces.get(v?.id);if(!t)return;
    const tab=e.target.closest('[data-input-tab]'),call=e.target.closest('[data-input-call]');
    if(tab){v.tab=tab.dataset.inputTab;renderInputView(true)}else if(call){v.call=call.dataset.inputCall;renderInputView(true)}
    else if(e.target.closest('[data-input-reload]'))openInputTrace(v.id,v.cid,true)
    else if(e.target.closest('[data-input-wrap]')){v.wrap=!v.wrap;renderInputView()}
    else if(e.target.closest('[data-input-format]')){v.format=v.format==='json'?'messages':'json';renderInputView(true)}
    else if(e.target.closest('[data-input-download]')){const url=URL.createObjectURL(new Blob([JSON.stringify(t,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='PageIndex-模型输入-'+t.id.slice(0,8)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
    else if(e.target.closest('[data-input-copy-context],[data-input-copy-call]')){const request=t.calls.find(c=>c.id===v.call)?.request,text=e.target.closest('[data-input-copy-context]')?t.context?.text:JSON.stringify(request,null,2);try{await navigator.clipboard.writeText(text||'');toast('已复制实际提交内容')}catch{toast('复制未成功，可下载完整 JSON')}}
  });
  document.addEventListener('click',e=>{const button=e.target.closest('[data-model-input]');if(button)openInputTrace(button.dataset.modelInput,button.dataset.inputConv)});

  async function send(){
    const question=$('chatInput').value.trim(),kid=activeKbId;if(!question||!kid||sending)return;
    const ids=state.scope.get(kid)||[],mode=$('studioRetrieval').value;const selected=window.Models.selection();
    let mid,answer='',refs=[],steps=[],usage=null,status='running',modelInput=null;
    const controller=new AbortController();state.controller=controller;sending=true;syncSelection();$('studioStop').hidden=false;$('chatInput').value='';resizeInput();$('placeholder')?.remove();addMsg('user',question);mid=addMsg('assistant','');
    const paint=()=>{const el=document.getElementById(mid);if(el){const expanded=el.querySelector('.retrieval-trace')?.open;el.querySelector('.msg-content').innerHTML=renderAnswer(answer,refs,steps,usage,status,'',modelInput);const trace=el.querySelector('.retrieval-trace');if(trace&&expanded!==undefined)trace.open=expanded}$('chatMsgs').scrollTop=$('chatMsgs').scrollHeight};paint();
    try{
      if(!activeConvId){const c=await request('/api/conversations',json({kb_id:kid}));activeConvId=c.conv_id}
      const response=await fetch(api+'/chat/stream',{...json({kb_id:kid,conv_id:activeConvId,question,doc_ids:ids,retrieval_mode:mode,...selected}),signal:controller.signal});
      if(!response.ok){const e=await response.json();throw new Error(e.detail||'问答请求失败')}
      const stream=response.body.getReader(),decoder=new TextDecoder();let pending='';
      while(true){const {value,done}=await stream.read();if(done)break;pending+=decoder.decode(value,{stream:true});const blocks=pending.split('\n\n');pending=blocks.pop();for(const block of blocks){if(!block.startsWith('data: '))continue;const ev=JSON.parse(block.slice(6));if(ev.type==='error')throw new Error(ev.message);if(ev.type==='step')steps.push(ev);if(ev.type==='sources')refs=ev.refs;if(ev.type==='delta')answer+=ev.text;if(ev.trace){modelInput=ev.trace;updateInputTrace(ev)}else if(ev.type==='model_input_status')updateInputTrace(ev);if(ev.type==='done'){usage=ev.usage;status=ev.status;modelInput=ev.model_input||modelInput}paint()}}
      if(status==='running')status='completed';
    }catch(e){if(e.name==='AbortError'){status='stopped';if(!answer)answer='已停止本次生成。'}else{status='failed';answer+=(answer?'\n\n':'')+'请求未完成：'+e.message}}
    finally{if(modelInput){modelInput.status=status;const t=inputTraces.get(modelInput.trace_id);if(t)t.status=status;if(inputViewer.open&&inputView?.id===modelInput.trace_id)renderInputView()}paint();sending=false;state.controller=null;$('studioStop').hidden=true;syncSelection();loadConversations();if(!inputViewer.open)$('chatInput').focus()}
  }
  document.addEventListener('click',async e=>{
    const cited=e.target.closest('[data-reader-doc]'),old=e.target.closest('[data-source-name]'),panel=e.target.closest('[data-open-control]');
    if(cited){if(control.contains(cited))control.close();openReader(cited.dataset.readerKb,cited.dataset.readerDoc,Number(cited.dataset.citePage)||1)}
    else if(old&&activeKbId){try{const {docs}=await request('/api/kb/'+encodeURIComponent(activeKbId)+'/docs');const doc=docs.find(d=>d.doc_name===old.dataset.sourceName);if(doc)openReader(activeKbId,doc.doc_id,Number(old.dataset.citePage)||1);else toast('来源文档已移动或重命名，请从知识库重新打开')}catch(e){toast(e.message)}}
    else if(panel)openControl(panel.dataset.openControl);
  });

  async function prepareUpload(files,kid,reindex=null){
    if(!kid)return toast('先选择知识库');if(uploading||sending)return toast('请等待当前任务完成');
    await refreshRoles();$('studioUploadTitle').textContent=reindex?'重建文档索引':'添加知识文档';const old=reindex?.doc.index_options||{};
    body(uploader).innerHTML=`<form class="studio-form" id="studioUploadForm"><div class="upload-selection">${icon('doc')}<div><strong>${reindex?'重建索引':files.length+' 份待索引文档'}</strong><p>${esc(reindex?reindex.doc.doc_name:files.map(f=>f.name).join('、'))}</p></div></div><div class="studio-form-grid"><label class="studio-field"><span>索引模式</span><select name="mode"><option value="flash"${old.mode==='standard'?'':' selected'}>Flash · 文本 PDF 快速索引</option><option value="standard"${old.mode==='standard'?' selected':''}>标准 · 模型分析目录</option></select></label><label class="studio-field"><span>扫描页面识别</span><select name="ocr"><option value="auto">自动识别低文本页</option><option value="off">关闭视觉识别</option><option value="force">所有页面使用视觉 OCR</option></select></label><label class="studio-field"><span>索引模型</span><select name="index_model_id">${modelOptions('index',old.index_model_id)}</select></label><label class="studio-field"><span>摘要模型</span><select name="summary_model_id">${modelOptions('summary',old.summary_model_id)}</select></label></div><p class="studio-help">Word 将先在本地转换为 PDF，页码与引用按转换后的 PDF 计算；Markdown 按标题生成目录；Flash 使用 PDF 排版。扫描页将保留 OCR 原文，无法识别时可在任务中心调整设置重试。</p><div class="studio-check-row"><label><input type="checkbox" name="summary"${old.summary===false?'':' checked'}>生成章节摘要</label><label><input type="checkbox" name="description"${old.description===false?'':' checked'}>生成文档简介</label></div><details class="advanced-index"><summary>高级索引设置 <span>ADVANCED</span></summary><div class="studio-form-grid"><label class="studio-field"><span>视觉 OCR 模型</span><select name="vision_model_id">${modelOptions('vision',old.vision_model_id)}</select></label><label class="studio-field"><span>Flash 树优化</span><select name="optimize"><option value="full">完整优化</option><option value="merge">仅合并短章节</option><option value="off">关闭</option></select></label>${field('Flash 摘要长度上限','summary_max_words',old.summary_max_words||150,'number','min="30" max="1000"')}${field('Flash 摘要并发','summary_concurrency',old.summary_concurrency||8,'number','min="1" max="32"')}<label class="studio-field"><span>摘要推理强度</span><select name="summary_reasoning_effort"><option value="">模型默认</option><option value="none">关闭</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>${field('标准模式目录检查页数','toc_pages',old.toc_pages||20,'number','min="1" max="100"')}${field('标准模式每节点页数上限','max_pages',old.max_pages||10,'number','min="1" max="100"')}${field('标准模式每节点 Token 上限','max_tokens',old.max_tokens||20000,'number','min="1000" max="100000"')}<label class="studio-check"><input type="checkbox" name="use_embedded_toc"${old.use_embedded_toc===false?'':' checked'}>优先利用 PDF 书签</label></div></details><p class="studio-form-error" role="alert" hidden></p><footer><button type="button" class="btn" data-close-upload>取消</button><button type="submit" class="btn btn-primary">${reindex?'提交重建任务':'开始索引'}</button></footer></form>`;
    const f=$('studioUploadForm');const updateMode=()=>{const flash=f.elements.mode.value==='flash';for(const name of ['summary_max_words','summary_concurrency','optimize','summary_reasoning_effort','use_embedded_toc'])f.elements[name].disabled=!flash;for(const name of ['max_pages','max_tokens','toc_pages'])f.elements[name].disabled=flash};f.elements.mode.onchange=updateMode;updateMode();for(const key of ['ocr','optimize','summary_reasoning_effort'])if(old[key]!=null)f.elements[key].value=old[key];f.querySelector('[data-close-upload]').onclick=()=>uploader.close();
    f.onsubmit=async e=>{e.preventDefault();const button=f.querySelector('[type=submit]'),error=f.querySelector('[role=alert]');button.disabled=true;error.hidden=true;uploading=true;syncSelection();try{
      const fd=new FormData(f),options=Object.fromEntries(fd);for(const key of ['summary','description','use_embedded_toc'])options[key]=f.elements[key].checked;for(const key of ['mode','ocr','optimize','summary_reasoning_effort'])options[key]=f.elements[key].value;for(const key of ['summary_max_words','summary_concurrency','max_pages','max_tokens','toc_pages'])options[key]=Number(f.elements[key].value);for(const key of ['index_model_id','summary_model_id','vision_model_id'])options[key]=options[key]||null;
      if(reindex)await request(base(kid,reindex.id)+'/reindex',json(options));else{while(files.length){const file=files[0];const data=new FormData();data.append('file',file);data.append('options',JSON.stringify(options));await request(api+'/kb/'+encodeURIComponent(kid)+'/uploads',{method:'POST',body:data});files.shift()}}
      uploader.close();openControl('tasks');toast('索引任务已提交，可继续使用已有知识库');
    }catch(e){error.textContent=e.message;error.hidden=false}finally{button.disabled=false;uploading=false;syncSelection()}};open(uploader);
  }

  async function refreshRoles(){
    try{state.models=await request('/api/models');const data=state.models;let el=$('studioRoles');if(!el){el=document.createElement('section');el.id='studioRoles';el.className='studio-role-panel';$('modelOverview').after(el)}
      const roles=[['index','索引模型','构建文档目录'],['summary','摘要模型','生成章节与文档概览'],['vision','视觉 OCR','识别扫描页与图片文字']];
      el.innerHTML=`<div class="studio-section-heading"><h3>为每一步，选择合适的模型。</h3><p>职责独立配置，服务连接继续共用。</p></div><div class="role-grid">${roles.map(([key,name,hint])=>`<label class="role-card"><span>${name}</span><small>${hint}</small><select data-role-default="${key}">${modelOptions(key,data.defaults[key])}</select></label>`).join('')}</div><button class="model-action" data-open-control="settings">设置模型价格与云端连接 ↗</button>`;
      el.querySelectorAll('[data-role-default]').forEach(select=>{select.value=data.defaults[select.dataset.roleDefault]||'';select.onchange=async()=>{try{await request('/api/models/defaults/'+select.dataset.roleDefault,{...json({model_id:select.value||null}),method:'PUT'});toast('模型职责配置已更新')}catch(e){toast(e.message);refreshRoles()}}});
    }catch(e){toast(e.message)}
  }
  function panelFrame(){body(control).innerHTML=`<nav class="control-tabs" aria-label="控制中心页面">${[['tasks','索引任务'],['usage','用量统计'],['cloud','云端空间'],['settings','服务设置']].map(([id,name])=>`<button data-control-tab="${id}" class="${state.tab===id?'active':''}">${name}</button>`).join('')}</nav><div class="control-content" id="studioControlContent"></div>`}
  async function openControl(tab='tasks'){state.tab=tab;panelFrame();open(control);await renderControl()}
  async function renderControl(){
    const token=++state.panelToken;const el=$('studioControlContent');if(!el)return;el.innerHTML=empty('正在读取工作室状态');
    try{if(state.tab==='tasks'){await pollJobs(false);if(token!==state.panelToken)return;renderJobs()}
      else if(state.tab==='usage'){const data=await request(api+'/usage');if(token!==state.panelToken)return;el.innerHTML=`<div class="studio-panel-heading"><div><span class="studio-kicker">USAGE & INSIGHTS</span><h3>每一次阅读，都有迹可循。</h3><p>仅累计接口已返回的用量；历史调用不反推，费用按已记录 Token 估算。</p></div><button class="btn" data-control-tab="settings">配置价格</button></div><div class="usage-metrics"><article><span>累计 Token</span><strong>${data.entries.some(e=>e.reported!==false)?number(data.total_tokens):'—'}</strong></article><article><span>已记录操作</span><strong>${number(data.entries.length)}</strong></article><article><span>已配置价格的估算费用 · USD</span><strong>${data.priced_calls?'$'+data.total_cost.toFixed(4):'—'}</strong></article></div>${data.entries.length?`<div class="studio-table-wrap"><table class="studio-table"><thead><tr><th>操作与模型</th><th>输入 / 输出 Token</th><th>耗时</th><th>估算费用</th></tr></thead><tbody>${data.entries.map(e=>`<tr><td><strong>${e.kind==='index'?'索引':'问答'} · ${esc(e.name)}</strong><small>${esc(e.model)} · ${date(e.created_at)} · ${statusName(e.status)}</small>${e.breakdown?.length?`<details class="usage-breakdown"><summary>按模型查看</summary>${e.breakdown.map(p=>`<p><b>${({index:'索引',summary:'摘要',vision:'视觉 OCR',chat:'对话与检索',embedding:'向量'})[p.role]||p.role}</b>${esc(p.model)}<span>${number(p.prompt_tokens)} 输入 / ${number(p.completion_tokens)} 输出 Token</span></p>`).join('')}</details>`:''}</td><td>${e.reported===false?'未返回用量':number(e.prompt_tokens)+' / '+number(e.completion_tokens)}</td><td>${e.seconds}s</td><td>${e.cost==null?'未设置价格':'$'+e.cost.toFixed(5)}</td></tr>`).join('')}</tbody></table></div>`:empty('还没有用量记录','完成一次索引或问答后，会在这里显示真实 Token 用量。')}`}
      else if(state.tab==='settings')await renderSettings(token);
      else await renderCloud(token);
    }catch(e){if(token===state.panelToken)el.innerHTML=empty('暂时无法读取',e.message)}
  }
  const activeJob = j => ['queued','running','cancelling'].includes(j.status);
  function elapsedLabel(seconds){
    const total=Math.max(0,Math.floor(seconds)),h=Math.floor(total/3600),m=Math.floor(total%3600/60),sec=total%60;
    return (h?h+'时 ':'')+(h||m?m+'分 ':'')+sec+'秒';
  }
  function jobError(j){
    if(!j.error)return '';
    let title=j.error,advice='';
    if(/max_output_reached|finish.reason.{0,8}(length|max_tokens)/i.test(j.error)){title='模型返回被长度限制截断，目录结果不完整。';advice='建议重新上传时选择 Flash 模式，并在高级设置中关闭树优化；或更换索引模型。直接重试会沿用原来的设置。'}
    else if(/reordered or modified TOC|different number of TOC entries/i.test(j.error)){title='模型返回的目录条目被改写、重排或遗漏，目录校验未通过。';advice='建议重新上传时选择 Flash 模式，或更换索引模型；已有索引会继续保留。'}
    else if(/^Processing failed\.?$/i.test(j.error.trim())){title='目录页码定位多次校验未通过，标准索引未能完成。';advice='建议重新上传时选择 Flash 模式，并关闭树优化；已有文件与索引会继续保留。'}
    return `<p class="job-error">${esc(title)}</p>${advice?`<p class="job-advice">${esc(advice)}</p><details class="job-error-raw"><summary>原始错误</summary><p>${esc(j.error)}</p></details>`:''}`;
  }
  function jobTimes(j){
    return `<div class="job-times"><span>累计耗时 <b data-job-clock="total">—</b></span>${j.started_at?'<span>处理耗时 <b data-job-clock="processing">—</b></span>':''}${j.status==='queued'?'<span>排队 <b data-job-clock="queue">—</b></span>':''}${activeJob(j)?`<span>${j.phase_started_at?'本阶段':'距阶段更新'} <b data-job-clock="stage">—</b></span>`:''}<span class="job-last-update">最近更新 ${date(j.updated_at)}</span></div><p class="job-wait-hint" data-job-wait hidden></p>`;
  }
  function tickJobTimes(){
    if(!control.open||state.tab!=='tasks')return;
    const now=Date.now()/1000,jobs=new Map(state.jobs.map(j=>[j.id,j]));
    control.querySelectorAll('[data-timed-job]').forEach(card=>{
      const j=jobs.get(card.dataset.timedJob);if(!j)return;
      const end=activeJob(j)?now:(j.finished_at||j.updated_at||j.created_at),values={total:end-j.created_at,processing:end-(j.started_at||j.created_at),queue:(j.started_at||end)-j.created_at,stage:end-(j.phase_started_at||j.updated_at||j.created_at)};
      card.querySelectorAll('[data-job-clock]').forEach(el=>el.textContent=elapsedLabel(values[el.dataset.jobClock]));
      const hint=card.querySelector('[data-job-wait]'),quiet=now-(j.updated_at||j.created_at);
      hint.hidden=!activeJob(j)||j.status==='queued'||quiet<180;
      if(!hint.hidden)hint.textContent='已 '+elapsedLabel(quiet)+' 未上报新进展，可能在等待模型返回；仅凭耗时不能判断任务已卡死。';
    });
  }
  function renderJobs(){
    if(state.tab!=='tasks'||!control.open)return;const el=$('studioControlContent');
    const expanded=new Set([...el.querySelectorAll('.job-card details[open]')].map(d=>d.closest('[data-timed-job]')?.dataset.timedJob+':'+d.className));
    el.innerHTML=`<div class="studio-panel-heading"><div><span class="studio-kicker">INDEXING OPERATIONS</span><h3>让知识，在后台生长。</h3><p>耗时实时更新；进度条按处理阶段显示，不代表精确完成比例。</p></div><button class="btn" data-refresh-jobs>${icon('refresh')}刷新</button></div><div class="job-list">${state.jobs.map(j=>`<article class="job-card ${j.status}" data-timed-job="${esc(j.id)}"><div class="job-icon">${icon('doc')}</div><div class="job-main"><div class="job-title"><strong>${esc(j.name)}</strong><span class="job-status">${statusName(j.status)}</span></div><p>${esc(j.phase)} <span>· 提交于 ${date(j.created_at)}</span></p>${jobTimes(j)}<div class="job-progress" aria-label="处理阶段指示"><i style="width:${j.progress||0}%"></i></div>${jobError(j)}${j.warnings?.length?`<details class="job-warning"><summary>${j.warnings.length} 条识别提示</summary><p>${j.warnings.map(esc).join('<br>')}</p></details>`:''}</div><div class="job-actions">${activeJob(j)?`<button class="model-action" data-job-action="cancel" data-job-id="${j.id}"${j.status==='cancelling'?' disabled':''}>取消</button>`:['failed','cancelled','interrupted'].includes(j.status)?`<button class="btn" data-job-action="retry" data-job-id="${j.id}">重试</button>`:`<button class="model-action" data-reader-kb="${esc(j.kb_id)}" data-reader-doc="${esc(j.doc_id)}">阅读 ↗</button>`}</div></article>`).join('')||empty('还没有索引任务','在知识库中添加文档，或打开文档管理重新建立索引。')}</div>`;
    el.querySelectorAll('.job-card details').forEach(d=>{if(expanded.has(d.closest('[data-timed-job]').dataset.timedJob+':'+d.className))d.open=true});
    tickJobTimes();
  }
  async function pollJobs(silent=true){
    try{const {jobs}=await request(api+'/jobs');const redraw=JSON.stringify(state.jobs)!==JSON.stringify(jobs);let changed=false;for(const j of jobs){const previous=state.jobs.find(old=>old.id===j.id);if(state.jobsInitialized&&(!previous||previous.status!=='completed')&&j.status==='completed')changed=true}state.jobs=jobs;state.jobsInitialized=true;const active=jobs.filter(j=>['queued','running','cancelling'].includes(j.status)).length;$('studioJobBadge').textContent=active;$('studioJobBadge').hidden=!active;if(changed){loadKBs();loadDocs();toast('文档索引已就绪')}if(redraw&&control.open&&state.tab==='tasks')renderJobs()}catch(e){if(!silent)throw e};
  }
  control.addEventListener('click',async e=>{
    const tab=e.target.closest('[data-control-tab]'),job=e.target.closest('[data-job-action]');
    if(tab){state.tab=tab.dataset.controlTab;panelFrame();renderControl()}
    else if(job){job.disabled=true;try{await request(api+'/jobs/'+job.dataset.jobId+'/'+job.dataset.jobAction,{method:'POST'});await pollJobs()}catch(e){toast(e.message);job.disabled=false}}
    else if(e.target.closest('[data-refresh-jobs]')){await pollJobs()}
  });
  control.addEventListener('close',()=>state.panelToken++);
  async function renderSettings(token){
    const [settings,models]=await Promise.all([request(api+'/settings'),request('/api/models')]);if(token!==state.panelToken)return;state.settings=settings;state.models=models;
    $('studioControlContent').innerHTML=`<form id="studioSettingsForm" class="studio-form"><div class="studio-panel-heading"><div><span class="studio-kicker">CONNECTIONS & METERING</span><h3>清晰的连接，独立的成本。</h3><p>模型服务继续在“模型”页面管理，这里设置用量价格和 PageIndex Cloud。</p></div></div><section class="settings-section"><h4>模型价格 <small>每百万 Token · USD</small></h4><p class="studio-help">留空不估算费用；按调用时配置的价格估算，后续改价不影响历史记录。用量按接口实际返回记录。</p><div class="price-table">${models.models.map(m=>`<div><span><strong>${esc(m.name)}</strong><small>${esc(m.provider_name+' / '+m.model)}</small></span><label><span>输入</span><input type="number" min="0" step="any" name="price_input_${m.id}" placeholder="未设置" value="${settings.prices?.[m.id]?.input??''}"></label><label><span>输出</span><input type="number" min="0" step="any" name="price_output_${m.id}" placeholder="未设置" value="${settings.prices?.[m.id]?.output??''}"></label></div>`).join('')||'<p class="studio-help">先在模型页面添加服务与模型。</p>'}</div></section><section class="settings-section"><h4>PageIndex Cloud</h4><p class="studio-help">这是独立的 PageIndex 云端密钥，区别于模型厂商密钥。本地资料仅在明确选择上传时外发。</p><div class="studio-form-grid">${field('服务根地址','cloud_url',settings.cloud?.base_url||'https://api.pageindex.ai','url','required')}${field('PageIndex API Key','cloud_key','','password',`autocomplete="off" placeholder="${settings.cloud?.has_key?'已保存，留空保持原值':'填写云端密钥'}"`)}</div>${settings.cloud?.has_key?'<label class="studio-check" style="margin-top:14px"><input type="checkbox" name="cloud_disconnect">移除已保存的云端密钥，断开此连接</label>':''}</section><p class="studio-form-error" role="alert" hidden></p><footer><button type="submit" class="btn btn-primary">保存设置</button></footer></form>`;
    const f=$('studioSettingsForm');f.addEventListener('input',()=>{for(const row of f.querySelectorAll('.price-table>div')){const inputs=[...row.querySelectorAll('input')],required=inputs.some(i=>i.value!=='');inputs.forEach(i=>i.required=required)}});f.onsubmit=async e=>{e.preventDefault();const data=new FormData(f),prices={};for(const m of models.models){const i=data.get('price_input_'+m.id),o=data.get('price_output_'+m.id);if(i!==null&&i!==''&&o!==null&&o!=='')prices[m.id]={input:Number(i),output:Number(o)}}const button=f.querySelector('[type=submit]');button.disabled=true;try{await request(api+'/settings',{...json({prices,cloud:{base_url:data.get('cloud_url'),api_key:data.get('cloud_key'),clear_key:data.has('cloud_disconnect')}}),method:'PUT'});toast('服务设置已保存');renderControl()}catch(e){const err=f.querySelector('[role=alert]');err.textContent=e.message;err.hidden=false}finally{button.disabled=false}};
  }

  async function renderCloud(token){
    const settings=await request(api+'/settings');state.settings=settings;if(token!==state.panelToken)return;
    const el=$('studioControlContent');if(!settings.cloud?.has_key){el.innerHTML=`<div class="cloud-welcome"><span class="studio-kicker">PAGEINDEX CLOUD</span><h3>为更大的知识空间，连接云端。</h3><p>多级目录、结构化元数据、页面图片与块级引用。连接配置完成后再读取云端内容；本地资料不会自动上传。</p><button class="btn btn-primary" data-control-tab="settings">配置云端连接 ↗</button></div>`;return}
    const data=await request(api+'/cloud/browse',json({folder_id:state.folder,offset:state.offset}));if(token!==state.panelToken)return;state.cloudDocs=data.documents||[];state.folders=data.folders||[];
    el.innerHTML=`<div class="studio-panel-heading"><div><span class="studio-kicker">CLOUD KNOWLEDGE SPACE</span><h3>云端空间</h3><p>${esc(settings.cloud.base_url||'https://api.pageindex.ai')} · ${state.cloudDocs.length} 份文档</p></div><div class="cloud-toolbar"><button class="btn" data-cloud-refresh>刷新</button><button class="btn" data-cloud-create-folder>新建目录</button><button class="btn" data-cloud-schema>元数据规则</button><button class="btn btn-primary" data-cloud-upload>上传本地 PDF</button></div></div><nav class="cloud-breadcrumbs"><button data-cloud-root>根目录</button>${state.cloudTrail.map((f,i)=>`<span>/</span><button data-cloud-trail="${i}">${esc(f.name)}</button>`).join('')}</nav><div class="cloud-folders">${state.folders.map(f=>`<button data-cloud-folder="${esc(f.id)}">${icon('book')}<strong>${esc(f.name)}</strong><small>${f.file_count??'—'} 份文档</small></button>`).join('')}</div><div class="cloud-documents">${state.cloudDocs.map(d=>`<button data-cloud-document="${esc(d.id)}">${icon('doc')}<span><strong>${esc(d.name)}</strong><small>${esc(d.status||'')} · ${d.pageNum||'—'} 页${d.metadata?' · '+esc(JSON.stringify(d.metadata)):''}</small></span><span>阅读 ↗</span></button>`).join('')||empty('当前目录暂无文档','可上传一份明确选择的本地 PDF，或进入其他目录。')}</div><footer class="cloud-list-pagination"><span>${state.offset+1}–${state.offset+state.cloudDocs.length} / ${data.total||0} 份文档</span><button class="btn" data-cloud-prev${state.offset?'':' disabled'}>上一页</button><button class="btn" data-cloud-next${state.offset+state.cloudDocs.length<(data.total||0)?'':' disabled'}>下一页</button></footer>`;
  }
  control.addEventListener('click',async e=>{
    const folder=e.target.closest('[data-cloud-folder]'),doc=e.target.closest('[data-cloud-document]'),trail=e.target.closest('[data-cloud-trail]');
    try{
      if(folder){const f=state.folders.find(f=>f.id===folder.dataset.cloudFolder);state.folder=f.id;state.offset=0;state.cloudTrail.push(f);renderControl()}
      else if(trail){state.cloudTrail=state.cloudTrail.slice(0,Number(trail.dataset.cloudTrail)+1);state.folder=state.cloudTrail.at(-1).id;state.offset=0;renderControl()}
      else if(e.target.closest('[data-cloud-root]')){state.folder='root';state.offset=0;state.cloudTrail=[];renderControl()}
      else if(e.target.closest('[data-cloud-refresh]'))renderControl();
      else if(e.target.closest('[data-cloud-next]')){state.offset+=100;renderControl()}
      else if(e.target.closest('[data-cloud-prev]')){state.offset=Math.max(0,state.offset-100);renderControl()}
      else if(e.target.closest('[data-cloud-create-folder]'))form('新建云端目录',field('目录名称','name','','text','required maxlength="100"'),async fd=>{await request(api+'/cloud/folder',json({name:fd.get('name'),parent_folder_id:state.folder==='root'?null:state.folder}));renderControl()});
      else if(e.target.closest('[data-cloud-schema]'))cloudSchema();
      else if(e.target.closest('[data-cloud-upload]'))cloudUpload();
      else if(doc)cloudRead(doc.dataset.cloudDocument);
    }catch(e){toast(e.message)}
  });
  async function cloudSchema(){try{const data=await request(api+'/cloud/schema-get',json({folder_id:state.folder}));await form('云端元数据规则',`<p class="studio-help">为当前空间声明可筛选的字段。字段类型支持 string、number、boolean。已有规则需要先删除，再重新声明。</p><label class="studio-field"><span>字段定义 · JSON</span><textarea name="fields" rows="10" spellcheck="false" required>${esc(JSON.stringify(data.schema?.fields||data.schema||{year:{type:'number',description:'文档年份'},category:{type:'string',description:'文档分类'}},null,2))}</textarea></label>${data.schema?'<button type="button" class="library-delete" id="deleteCloudSchema">删除已有规则</button>':''}`,async fd=>{await request(api+'/cloud/schema-save',json({folder_id:state.folder,fields:JSON.parse(fd.get('fields'))}));toast('云端元数据规则已保存')});if($('deleteCloudSchema'))$('deleteCloudSchema').onclick=async()=>{if(!confirm('删除当前云端元数据规则？之后可重新声明字段。'))return;try{await request(api+'/cloud/schema-delete',json({folder_id:state.folder}));editor.close();toast('规则已删除')}catch(e){toast(e.message)}}}catch(e){toast(e.message)}}
  async function cloudUpload(){
    try{const kbs=await request('/api/kb');const docs=[];for(const k of kbs.knowledge_bases){const d=await request('/api/kb/'+k.kb_id+'/docs');docs.push(...d.docs.filter(d=>/\.pdf$/i.test(d.doc_name)).map(d=>({...d,kid:k.kb_id,kname:k.name})))}
      await form('上传到 PageIndex Cloud',`<p class="studio-help">将所选 PDF 原文件发送至 ${esc(state.settings.cloud.base_url||'https://api.pageindex.ai')} 的当前目录，由云端处理。此操作不会替换本地索引。</p><label class="studio-field"><span>选择本地 PDF</span><select name="doc" required>${docs.map((d,i)=>`<option value="${i}">${esc(d.kname+' / '+d.doc_name)}</option>`).join('')}</select></label><label class="studio-field"><span>文档元数据 · 可选 JSON</span><textarea name="metadata" rows="3" placeholder='{"year":2024}'></textarea></label><label class="studio-check"><input type="checkbox" name="confirmed" required>我确认将所选 PDF 原文件上传到上述 PageIndex Cloud 服务</label>`,async fd=>{const doc=docs[Number(fd.get('doc'))];if(!doc)throw new Error('没有可上传的 PDF');await request(api+'/cloud/upload',json({kb_id:doc.kid,doc_id:doc.doc_id,folder_id:state.folder==='root'?null:state.folder,metadata:fd.get('metadata')?JSON.parse(fd.get('metadata')):{},confirmed:fd.has('confirmed')}));toast('文件已发送云端，处理状态可在目录刷新查看');renderControl()});
    }catch(e){toast(e.message)}
  }
  async function cloudRead(id){
    const doc=state.cloudDocs.find(d=>d.id===id);const view=dialog('cloudRead'+Date.now(),doc?.name||'云端文档','cloud-reader-dialog');open(view);body(view).innerHTML=empty('读取云端结构');
    view.addEventListener('close',()=>view.remove(),{once:true});
    try{const tree=await request(api+'/cloud/tree',json({doc_id:id}));
      if(!view.open)return;const nodes=tree.result||[];
      const render=nodes=>Array.isArray(nodes)?nodes.map(n=>`<details class="cloud-section"><summary>${esc(n.title||'章节')}<small>${n.page_index||n.start_index||''}</small></summary><p>${esc(n.summary||n.text||'')}</p>${render(n.nodes||[])}</details>`).join(''):empty('云端仍在处理',tree.status||'请稍后刷新');
      body(view).innerHTML=`<div class="cloud-inspector"><aside><span class="studio-kicker">DOCUMENT STRUCTURE</span>${render(nodes)}<details class="cloud-reference-tools"><summary>引用与图片定位</summary><label class="studio-field"><span>块级引用 ID</span><input id="cloudBlockId" placeholder="从引用结果复制 block_id"></label><button class="btn" data-load-block>定位引用块</button><label class="studio-field"><span>文档图片 ID</span><input id="cloudImageId" placeholder="从原文内容复制 image_id"></label><button class="btn" data-load-image>查看图片</button></details></aside><main><div class="cloud-page-tools"><label>第 <input id="cloudPageNumber" type="number" value="1" min="1"> 页</label><button class="btn" data-load-page>查看页图</button></div><div class="cloud-page-view" id="cloudImageView">${empty('阅读云端原文','选择页码，查看原始页面；块级引用支持高亮定位。')}</div></main></div>`;
      view.addEventListener('click',async e=>{let action,params;if(e.target.closest('[data-load-page]')){action='page';params={page:Number($('cloudPageNumber').value)}}if(e.target.closest('[data-load-block]')){action='block';params={block_id:$('cloudBlockId').value.trim()}}if(e.target.closest('[data-load-image]')){action='image';params={image_id:$('cloudImageId').value.trim()}}if(!action)return;const target=$('cloudImageView');target.innerHTML=empty('读取云端图片');try{const d=await request(api+'/cloud/'+action,json({doc_id:id,...params}));const url=d.page_url||d.url;const safe=new URL(url);if(!['https:','http:'].includes(safe.protocol))throw new Error('云端图片地址无效');target.innerHTML=`<div class="cloud-image-frame"><img src="${esc(url)}" alt="云端文档原文">${Array.isArray(d.bbox)&&d.bbox.length===4?`<i class="cloud-block-highlight" style="left:${d.bbox[0]/10}%;top:${d.bbox[1]/10}%;width:${(d.bbox[2]-d.bbox[0])/10}%;height:${(d.bbox[3]-d.bbox[1])/10}%"></i>`:''}</div>${d.text?`<p class="cloud-block-text">${esc(d.text)}</p>`:''}`}catch(e){target.innerHTML=empty('读取失败',e.message)}});
    }catch(e){error(view,e)}
  }
  const filters=$('modelFilters');if(filters&&!filters.querySelector('[data-model-kind="vision"]')){const b=document.createElement('button');b.dataset.modelKind='vision';b.textContent='视觉 OCR';filters.appendChild(b)}
  syncKB();refreshRoles();pollJobs();
  setInterval(()=>{if(!document.hidden)tickJobTimes()},1000);
  setInterval(()=>{if(!document.hidden&&(control.open||state.jobs.some(j=>['queued','running','cancelling'].includes(j.status))))pollJobs()},2500);
  return {openReader,closeReader,closeDeletedReader,manageLibrary,prepareUpload,syncKB,send,renderAnswer,refreshRoles,openControl};
})();
