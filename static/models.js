/* 服务保存共享连接，模型只保存名称、用途和标识。 */
window.Models = (() => {
  const state = {data: null, filter: 'all', query: '', selected: null, pending: null, visible: false, results: new Map(), testing: new Set(), editingProvider: null, editingModel: null, targetProvider: null};
  const kindName = kind => ({chat:'对话模型',embedding:'向量模型',vision:'视觉模型'})[kind];
  const current = kind => state.data?.models.find(m => m.id === state.data.defaults[kind]);
  const modelLabel = m => `${m.provider_name} / ${m.name === m.provider_name ? m.model : m.name}`;
  const identifiers = text => text.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
  const dialog = (labelId, content) => {
    const el = document.createElement('dialog'); el.className = 'document-dialog model-editor'; el.setAttribute('aria-labelledby', labelId);
    el.innerHTML = `<div class="document-modal-frame"><header class="document-modal-top"><span>${icon('spark')}模型服务 <small>MODEL CONNECTION</small></span><button type="button" class="btn-ghost" data-close-editor aria-label="关闭配置">${icon('close')}</button></header>${content}</div>`;
    document.body.appendChild(el);
    el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-close-editor]')) el.close(); });
    return el;
  };
  const providerEditor = dialog('providerEditorTitle', `<form class="model-form" id="providerForm"><h2 id="providerEditorTitle">添加模型服务</h2><p class="model-form-sub">连接只配一次，同一服务可以添加多个对话或向量模型。</p><div class="model-form-grid"><div class="model-field full"><label for="providerName">服务名称</label><input id="providerName" name="name" maxlength="80" placeholder="例如：火山 / 本地模型服务" required autocomplete="off"></div><div class="model-field full"><label>接入协议</label><div class="model-protocol"><i class="status-dot"></i>OpenAI-compatible</div></div><div class="model-field full"><label for="providerBaseUrl">Base URL <small>base_url</small></label><input id="providerBaseUrl" name="base_url" type="url" placeholder="https://api.example.com/v1" required autocomplete="off" spellcheck="false"><small>填写服务根地址，无需附加 /chat/completions 或 /embeddings。</small></div><div class="model-field full"><label for="providerApiKey">API Key <small>api_key</small></label><div class="model-key-wrap"><input id="providerApiKey" name="api_key" type="password" placeholder="无需鉴权的本地服务可留空" autocomplete="off" spellcheck="false"><button type="button" id="toggleProviderKey" aria-pressed="false" aria-label="显示 API Key">显示</button></div><small id="providerKeyHint">密钥在本地明文保存，由该服务下的模型共用。</small></div><section class="initial-models" id="initialModels"><div class="model-field"><label for="initialModelIds">首批模型 <small>可选，一行一个标识</small></label><textarea id="initialModelIds" rows="3" placeholder="model-a&#10;model-b" spellcheck="false"></textarea></div><div class="model-field"><label for="initialModelKind">这批模型的用途</label><select id="initialModelKind"><option value="chat">对话模型</option><option value="embedding">向量模型</option><option value="vision">视觉 OCR 模型</option></select><small>服务创建后，可继续添加其他用途的模型。</small></div></section></div><p class="model-form-error" id="providerFormError" role="alert" hidden></p><div class="model-form-actions"><button type="button" class="btn" data-close-editor>取消</button><button type="submit" class="btn btn-primary" id="saveProviderBtn">保存服务</button></div></form>`);
  const modelEditor = dialog('modelEditorTitle', `<form class="model-form" id="modelForm"><h2 id="modelEditorTitle">添加模型</h2><p class="model-form-sub">复用服务连接，无需重复填写地址或密钥。</p><div class="model-provider-context" id="modelProviderContext"></div><div class="model-form-grid"><div class="model-field full" id="modelNameField"><label for="modelName">显示名称</label><input id="modelName" name="name" maxlength="80" placeholder="方便识别的模型名称" autocomplete="off"></div><div class="model-field full"><label for="modelKind">模型用途</label><select id="modelKind" name="kind"><option value="chat">对话模型</option><option value="embedding">向量模型</option><option value="vision">视觉 OCR 模型</option></select></div><div class="model-field full"><label for="modelIdentifiers" id="modelIdentifierLabel">模型标识 <small>一行一个，支持批量添加</small></label><textarea id="modelIdentifiers" rows="4" placeholder="model-a&#10;model-b" required spellcheck="false"></textarea><small id="modelIdentifierHint">填写服务实际提供的模型标识，每次最多添加 100 个。</small></div></div><p class="model-form-error" id="modelFormError" role="alert" hidden></p><div class="model-form-actions"><button type="button" class="btn" data-close-editor>取消</button><button type="submit" class="btn btn-primary" id="saveModelBtn">添加模型</button></div></form>`);
  providerEditor.addEventListener('close', () => { $('providerForm').reset(); $('providerApiKey').type = 'password'; $('toggleProviderKey').textContent = '显示'; $('toggleProviderKey').setAttribute('aria-pressed','false'); $('toggleProviderKey').setAttribute('aria-label','显示 API Key'); state.editingProvider = null; });
  modelEditor.addEventListener('close', () => { $('modelForm').reset(); state.editingModel = null; state.targetProvider = null; });
  $('toggleProviderKey').addEventListener('click', () => { const show = $('providerApiKey').type === 'password'; $('providerApiKey').type = show ? 'text' : 'password'; $('toggleProviderKey').textContent = show ? '隐藏' : '显示'; $('toggleProviderKey').setAttribute('aria-pressed',String(show)); $('toggleProviderKey').setAttribute('aria-label',show?'隐藏 API Key':'显示 API Key'); });

  function selection() { return {model_id: $('chatModelSelect').value || 'environment', model: state.data?.environment_model || 'deepseek/deepseek-chat'}; }
  function updateSelector(forceDefault = false) {
    const models = state.data.models.filter(m => m.kind === 'chat');
    if (forceDefault || state.selected === null || (state.selected !== 'environment' && !models.some(m => m.id === state.selected))) state.selected = state.data.defaults.chat || 'environment';
    $('chatModelSelect').innerHTML = `<option value="environment">环境默认 · ${esc(state.data.environment_model)}</option>` + models.map(m => `<option value="${esc(m.id)}">${esc(modelLabel(m))}</option>`).join('');
    $('chatModelSelect').value = state.selected;
  }
  async function refresh(forceDefault = false) {
    try {
      if (!state.pending) state.pending = request('/api/models').finally(() => { state.pending = null; });
      state.data = await state.pending; updateSelector(forceDefault); if (state.visible) render();window.Studio?.refreshRoles();
    } catch (e) { if (state.visible) $('modelGrid').innerHTML = `<div class="model-empty"><div class="library-empty">${icon('spark')}<h2>暂时无法读取模型配置</h2><p>${esc(e.message)}</p><button class="btn" data-retry-models>重新加载</button></div></div>`; toast(e.message); }
  }
  function show(visible) { state.visible = visible; if (visible) { if (state.data) render(); refresh(); } else { if (providerEditor.open) providerEditor.close(); if (modelEditor.open) modelEditor.close(); } }
  function defaultCard(kind) {
    const model = current(kind), models = state.data.models.filter(m => m.kind === kind);
    const title = model?.model || (kind === 'chat' ? '环境默认' : '尚未配置');
    const identifier = model ? modelLabel(model) : kind === 'chat' ? state.data.environment_model : '在服务下添加一个向量模型';
    return `<article class="model-summary ${kind}"><div class="summary-heading">${icon(kind === 'chat' ? 'chat' : 'tree')}默认${kindName(kind)}</div><h2 title="${esc(title)}">${esc(title)}</h2><p title="${esc(identifier)}">${esc(identifier)}</p><select data-default-kind="${kind}" aria-label="切换默认${kindName(kind)}"><option value=""${!model?' selected':''}>${kind === 'chat' ? '使用环境默认' : '不设置默认向量模型'}</option>${models.map(m=>`<option value="${esc(m.id)}"${m.id===model?.id?' selected':''}>${esc(modelLabel(m))}</option>`).join('')}</select></article>`;
  }
  function modelRow(m) {
    const isDefault = state.data.defaults[m.kind] === m.id, result = state.results.get(m.id), testing = state.testing.has(m.id);
    return `<div class="provider-model-row"><span class="model-type-icon ${m.kind}">${icon(m.kind==='chat'?'chat':'tree')}</span><div class="provider-model-name"><strong>${esc(m.model)}</strong>${m.name !== m.model ? `<small>${esc(m.name)}</small>` : ''}<p class="model-test-result${result?(result.ok?' success':' error'):''}" role="status">${testing?'正在检查服务连接…':result?esc(result.message):'尚未测试连接'}</p></div><span class="model-kind-tag ${m.kind}">${({chat:'对话',embedding:'向量',vision:'视觉'})[m.kind]}</span>${isDefault?'<span class="model-default-badge">默认使用</span>':''}<div class="provider-model-actions"><button class="model-action" data-test-model="${esc(m.id)}"${testing?' disabled':''}>${testing?'测试中…':'测试连接'}</button><button class="model-action" data-default-model="${esc(m.id)}"${isDefault?' disabled':''}>${isDefault?'当前默认':'设为默认'}</button><button class="model-action" data-edit-model="${esc(m.id)}"${testing?' disabled':''}>编辑</button><button class="model-action danger" data-delete-model="${esc(m.id)}"${testing?' disabled':''}>删除</button></div></div>`;
  }
  function render() {
    if (!state.data || !state.visible) return;
    const models = state.data.models, chat = models.filter(m => m.kind === 'chat').length, providers = state.data.providers;
    $('modelOverview').innerHTML = defaultCard('chat') + defaultCard('embedding') + `<article class="model-summary count"><div class="summary-heading">${icon('grid')}服务连接</div><strong>${providers.length}</strong><small>${models.length} 个模型 · ${chat} 对话 / ${models.filter(m=>m.kind==='embedding').length} 向量 / ${models.filter(m=>m.kind==='vision').length} 视觉</small></article>`;
    for (const b of $('modelFilters').querySelectorAll('[data-model-kind]')) { const active = b.dataset.modelKind === state.filter; b.classList.toggle('active', active); b.setAttribute('aria-pressed',String(active)); }
    const q = state.query.trim().toLocaleLowerCase();
    const cards = providers.map(p => {
      const all = models.filter(m=>m.provider_id===p.id), matches = [p.name,p.base_url].some(v=>v.toLocaleLowerCase().includes(q));
      const shown = all.filter(m=>(state.filter==='all'||m.kind===state.filter)&&(matches||[m.name,m.model].some(v=>v.toLocaleLowerCase().includes(q))));
      if (!matches && !shown.length) return '';
      const busy = all.some(m=>state.testing.has(m.id));
      return `<article class="provider-card"><header class="provider-heading"><span class="library-monogram">${icon('link')}</span><div class="provider-title"><h3>${esc(p.name)}<span>OpenAI-compatible</span></h3><p title="${esc(p.base_url)}">${esc(p.base_url)}</p><small>${all.length} 个模型 · ${p.has_key?'已配置共享密钥':'无需密钥鉴权'}</small></div><div class="provider-actions"><button class="btn" data-add-provider-models="${esc(p.id)}">${icon('plus')}添加模型</button><button class="model-action" data-edit-provider="${esc(p.id)}"${busy?' disabled':''}>编辑服务</button>${!all.length?`<button class="model-action danger" data-delete-provider="${esc(p.id)}">删除服务</button>`:''}</div></header><div class="provider-models">${shown.length?shown.map(modelRow).join(''):`<div class="provider-no-models">${all.length?'该服务下没有匹配当前条件的模型。':'服务已保存，添加第一个模型即可使用。'}<button class="model-action" data-add-provider-models="${esc(p.id)}">添加模型 ↗</button></div>`}</div></article>`;
    }).filter(Boolean);
    $('modelGrid').innerHTML = cards.length ? cards.join('') : `<div class="model-empty"><div class="library-empty">${icon('spark')}<h2>${providers.length?'没有匹配的服务或模型':'一个服务，连接多个模型。'}</h2><p>${providers.length?'尝试其他关键词。':'先配置地址和密钥，再按需添加对话、向量与视觉模型。'}</p><button class="btn btn-primary" data-add-provider>${icon('plus')}添加服务</button></div></div>`;
  }
  async function openProvider(id = null) {
    try {
      const config = id ? await request('/api/model-providers/'+encodeURIComponent(id)) : {name:'',base_url:'',api_key:''};
      state.editingProvider = id; $('providerForm').reset();
      for (const key of ['name','base_url','api_key']) $('providerForm').elements.namedItem(key).value = config[key];
      $('providerEditorTitle').textContent = id ? '编辑服务连接' : '添加模型服务';
      $('initialModels').hidden = !!id;
      $('initialModelKind').value = state.filter==='embedding'?'embedding':'chat';
      $('providerKeyHint').textContent = id ? `地址和密钥变更会同步作用于该服务下的 ${state.data.models.filter(m=>m.provider_id===id).length} 个模型。` : '密钥在本地明文保存，由该服务下的模型共用。';
      $('providerFormError').hidden = true; $('saveProviderBtn').disabled = false;
      providerEditor.showModal(); $('providerName').focus();
    } catch (e) { toast(e.message); }
  }
  function openModel(providerId, modelId = null) {
    const provider = state.data.providers.find(p=>p.id===providerId), model = modelId ? state.data.models.find(m=>m.id===modelId) : null;
    if (!provider) return;
    state.targetProvider = providerId; state.editingModel = modelId; $('modelForm').reset();
    $('modelProviderContext').innerHTML = `${icon('link')}<div><strong>${esc(provider.name)}</strong><span>${esc(provider.base_url)}</span></div><small>共用服务连接</small>`;
    $('modelEditorTitle').textContent = model ? '编辑模型' : '添加模型到服务';
    $('modelNameField').hidden = !model; $('modelName').value = model?.name || '';
    $('modelKind').value = model?.kind || (state.filter==='embedding'?'embedding':'chat');
    $('modelIdentifiers').value = model?.model || ''; $('modelIdentifiers').rows = model ? 1 : 4;
    $('modelIdentifierLabel').innerHTML = model ? '模型标识' : '模型标识 <small>一行一个，支持批量添加</small>';
    $('modelIdentifierHint').textContent = model ? '修改标识不会创建新的服务连接。' : '填写服务实际提供的模型标识，每次最多添加 100 个。';
    $('saveModelBtn').textContent = model ? '保存模型' : '添加模型'; $('saveModelBtn').disabled = false; $('modelFormError').hidden = true;
    modelEditor.showModal(); $('modelIdentifiers').focus();
  }
  function clearProviderResults(id) { for (const m of state.data.models) if (m.provider_id===id) state.results.delete(m.id); }
  $('providerForm').addEventListener('submit',async e=>{
    e.preventDefault(); const id=state.editingProvider, body=Object.fromEntries(new FormData(e.currentTarget)); body.protocol='openai-compatible';
    const batch=identifiers($('initialModelIds').value);
    if (!id && batch.length) body.models=batch.map(model=>({model,kind:$('initialModelKind').value}));
    $('saveProviderBtn').disabled=true; $('providerFormError').hidden=true;
    try { await request('/api/model-providers'+(id?'/'+encodeURIComponent(id):''),{method:id?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); if(id)clearProviderResults(id); providerEditor.close(); await refresh(true); toast(id?'共享服务配置已更新':'服务及模型配置已保存'); }
    catch(error){$('providerFormError').textContent=error.message;$('providerFormError').hidden=false;}
    finally{$('saveProviderBtn').disabled=false;}
  });
  $('modelForm').addEventListener('submit',async e=>{
    e.preventDefault(); const id=state.editingModel,pid=state.targetProvider,ids=identifiers($('modelIdentifiers').value),kind=$('modelKind').value;
    if(!ids.length || (id&&ids.length!==1)){$('modelFormError').textContent=id?'编辑时只能填写一个模型标识':'请填写至少一个模型标识';$('modelFormError').hidden=false;return;}
    $('saveModelBtn').disabled=true; $('modelFormError').hidden=true;
    const body=id?{provider_id:pid,name:$('modelName').value,kind,model:ids[0]}:{models:ids.map(model=>({kind,model}))};
    try{await request(id?'/api/models/'+encodeURIComponent(id):'/api/model-providers/'+encodeURIComponent(pid)+'/models',{method:id?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(id)state.results.delete(id);modelEditor.close();await refresh(true);toast(id?'模型配置已更新':`已添加 ${ids.length} 个模型，共用原有服务连接`);}
    catch(error){$('modelFormError').textContent=error.message;$('modelFormError').hidden=false;}
    finally{$('saveModelBtn').disabled=false;}
  });
  async function setDefault(kind,id){try{await request('/api/models/defaults/'+kind,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({model_id:id||null})});await refresh(true);toast('默认'+kindName(kind)+'已更新');}catch(e){toast(e.message);render();}}
  async function test(id){if(state.testing.has(id))return;state.testing.add(id);render();try{const d=await request('/api/models/'+encodeURIComponent(id)+'/test',{method:'POST'});state.results.set(id,{ok:true,message:`连接正常 · ${d.elapsed_ms} ms${d.dimensions?' · '+d.dimensions+' 维向量':''}`});}catch(e){state.results.set(id,{ok:false,message:e.message});}finally{state.testing.delete(id);render();}}
  async function removeModel(id){const m=state.data.models.find(m=>m.id===id);if(!m||!confirm('删除模型“'+m.model+'”？共享服务及其下其他模型会保留。'))return;try{await request('/api/models/'+encodeURIComponent(id),{method:'DELETE'});state.results.delete(id);await refresh(true);toast('模型已删除，共享服务保留');}catch(e){toast(e.message);}}
  async function removeProvider(id){const p=state.data.providers.find(p=>p.id===id);if(!p||!confirm('删除空服务“'+p.name+'”？'))return;try{await request('/api/model-providers/'+encodeURIComponent(id),{method:'DELETE'});await refresh(true);toast('空服务已删除');}catch(e){toast(e.message);}}
  $('addModelBtn').addEventListener('click',()=>openProvider());
  $('modelSearch').addEventListener('input',e=>{state.query=e.target.value;render();});
  $('modelFilters').addEventListener('click',e=>{const b=e.target.closest('[data-model-kind]');if(b){state.filter=b.dataset.modelKind;render();}});
  $('modelOverview').addEventListener('change',e=>{const s=e.target.closest('[data-default-kind]');if(s)setDefault(s.dataset.defaultKind,s.value);});
  $('modelGrid').addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b)return;
    if(b.hasAttribute('data-add-provider'))openProvider();
    else if(b.hasAttribute('data-retry-models'))refresh();
    else if(b.dataset.addProviderModels)openModel(b.dataset.addProviderModels);
    else if(b.dataset.editProvider)openProvider(b.dataset.editProvider);
    else if(b.dataset.deleteProvider)removeProvider(b.dataset.deleteProvider);
    else if(b.dataset.editModel){const m=state.data.models.find(m=>m.id===b.dataset.editModel);if(m)openModel(m.provider_id,m.id);}
    else if(b.dataset.testModel)test(b.dataset.testModel);
    else if(b.dataset.deleteModel)removeModel(b.dataset.deleteModel);
    else if(b.dataset.defaultModel){const m=state.data.models.find(m=>m.id===b.dataset.defaultModel);if(m)setDefault(m.kind,m.id);}
  });
  $('chatModelSelect').addEventListener('change',e=>{state.selected=e.target.value;});
  state.visible=location.hash==='#models';refresh();
  return {show,selection,refresh};
})();
