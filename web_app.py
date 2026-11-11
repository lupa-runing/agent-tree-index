import os, sys, json, uuid, asyncio, argparse, concurrent.futures, re, base64, time, logging
from datetime import datetime
from io import BytesIO
from pathlib import Path
from contextlib import asynccontextmanager
from contextvars import copy_context

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
import uvicorn
from openai import OpenAI

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pageindex import page_index_main, md_to_tree
from pageindex.utils import ConfigLoader, llm_completion
from pageindex.model_settings import ModelRegistry, model_context
import PyPDF2
import pymupdf
import threading
from studio_service import atomic_json, register_studio
from model_input_trace import remove_traces
from pageindex.word_conversion import WORD_SUFFIXES, convert_word_to_pdf, find_soffice

from dotenv import load_dotenv
load_dotenv()

VISION_API_KEY = os.getenv("VISION_API_KEY", os.getenv("OPENAI_API_KEY", ""))
VISION_BASE_URL = os.getenv("VISION_BASE_URL", "https://api.openai.com/v1")
VISION_MODEL_NAME = os.getenv("VISION_MODEL_NAME", "gpt-4o")

UPLOAD_DIR = Path("./uploads"); UPLOAD_DIR.mkdir(exist_ok=True)
STORE_FILE = Path("./store.json")
store_lock = threading.RLock()

TREE_SEARCH_PROMPT = """You are a document retrieval assistant. Given a user question and documents' tree structures, find the most relevant leaf sections.

Think about what the question needs, examine each candidate, select 1-3 most relevant.

Respond with raw JSON (no markdown):
{{"reasoning": "step-by-step", "node_ids": ["doc_id::node_id", ...]}}

Document sections:
{structure_json}

Question: {question}"""

QA_PROMPT = """Answer based ONLY on the provided document content.

Document context (pages {page_ranges}):
{page_content}

Conversation history:
{chat_history}

Question: {question}

Answer concisely, cite pages. If not found, say so. Always reply in the same language as the user's question."""

# ── Store ────────────────────────────────────────────────────────────────────

def _load_store() -> dict:
    if STORE_FILE.exists():
        with open(STORE_FILE) as f: return json.load(f)
    return {}
def _save_store(s: dict):
    with store_lock:
        atomic_json(STORE_FILE, s)


def _document_files(doc):
    return {Path(doc[key]) for key in ('file_path', 'source_file_path') if doc.get(key)}

store = _load_store()
store.setdefault("knowledge_bases", {})
store.setdefault("conversations", {})
model_registry = ModelRegistry(Path(__file__).resolve().parent / "models.json")

# ── Vision Helpers ───────────────────────────────────────────────────────────

def _render_page_to_base64(fp: str, page_num: int, dpi: int = 150) -> str:
    """Render a single PDF page to base64 PNG. Returns empty string on failure."""
    try:
        doc = pymupdf.open(fp)
        if page_num < 1 or page_num > len(doc):
            return ""
        pix = doc[page_num - 1].get_pixmap(dpi=dpi)
        return base64.b64encode(pix.tobytes("png")).decode()
    except Exception:
        return ""

def _vision_ocr(fp: str, page_nums: list[int]) -> dict[int, str]:
    """Use vision model to OCR specific pages. Returns {page_num: text}."""
    if not VISION_API_KEY:
        return {}
    client = OpenAI(base_url=VISION_BASE_URL, api_key=VISION_API_KEY)
    results = {}
    for p in page_nums:
        img_b64 = _render_page_to_base64(fp, p)
        if not img_b64:
            continue
        try:
            resp = client.chat.completions.create(
                model=VISION_MODEL_NAME,
                messages=[{"role": "user", "content": [
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64," + img_b64}},
                    {"type": "text", "text": "OCR this page. Extract all visible text exactly as it appears. Return ONLY the extracted text, nothing else."}
                ]}],
                max_tokens=81920,
            )
            results[p] = resp.choices[0].message.content.strip()
        except Exception as e:
            logging.warning(f"Vision OCR error for page {p}: {e}")
    return results

def _collect_pages_text_hybrid(doc: dict, nodes: list[dict], use_vision: bool = True) -> tuple[str, str]:
    """优先使用保留表格语义的页面内容，再尝试纯文本和视觉识别。"""
    if doc.get("type") != "pdf": return "", ""
    fp = doc.get("file_path", "")
    if not fp or not os.path.isfile(fp): return "", ""
    pages_text = {}
    all_page_nums = set()
    ranges = []

    for n in nodes:
        s, e = n.get("start_index"), n.get("end_index", n.get("start_index"))
        if s is None: continue
        ranges.append(f"p{s}" if s == e else f"p{s}-{e}")
        for p in range(s, e + 1):
            all_page_nums.add(p)

    # 统一使用结构化内容，旧文档也可按页恢复表格，无需重建索引。
    for p in all_page_nums:
        ct = studio.page_text(doc, p)
        if ct:
            pages_text[p] = ct

    # Step 1: PyPDF2 for pages not in cache
    try:
        reader = PyPDF2.PdfReader(fp)
        for p in all_page_nums:
            if p not in pages_text and 1 <= p <= len(reader.pages):
                txt = reader.pages[p - 1].extract_text() or ""
                if txt.strip():
                    pages_text[p] = txt
    except Exception:
        pass

    # Step 2: For pages with too little text or no text, try vision OCR
    if use_vision and VISION_API_KEY:
        low_text_pages = [p for p in all_page_nums if p not in pages_text or len(pages_text[p].strip()) < 50]
        if low_text_pages and VISION_API_KEY:
            try:
                vision_results = _vision_ocr(fp, low_text_pages)
                for p, txt in vision_results.items():
                    if txt:
                        pages_text[p] = txt
            except Exception:
                pass

    combined = "\n\n".join(f"[Page {p}]\n{t}" for p, t in sorted(pages_text.items()) if t.strip())
    return ", ".join(ranges), combined

# ── Helpers ──────────────────────────────────────────────────────────────────

def _get_leaf_nodes(structure: list) -> list[dict]:
    leaves = []
    def walk(nodes):
        for n in nodes:
            if n.get("nodes"): walk(n["nodes"])
            else:
                leaves.append(dict(node_id=n.get("node_id",""), title=n.get("title",""),
                                   start_index=n.get("start_index"), end_index=n.get("end_index"),
                                   summary=n.get("summary","")))
    walk(structure)
    return leaves

def _tree_search(kb: dict, question: str, model: str) -> dict:
    all_leaves = []
    for did, doc in kb.get("docs", {}).items():
        for n in _get_leaf_nodes(doc.get("structure", [])):
            n["_doc_id"] = did; n["_doc_name"] = doc.get("doc_name", "")
            n['summary'] = n.get('summary') or doc.get('page_texts', {}).get(str(n.get('start_index') or 1), '')[:400]
            all_leaves.append(n)
    if not all_leaves: return {"reasoning": "知识库中没有文档", "nodes": []}
    preview = json.dumps(
        [{"doc": n["_doc_name"], "title": n['title'], "node_id": n["_doc_id"] + "::" + n["node_id"], "pages": str(n["start_index"]) + "-" + str(n["end_index"]),
          "summary": (n.get("summary") or "")[:120]} for n in all_leaves],
        ensure_ascii=False, indent=2)
    prompt = TREE_SEARCH_PROMPT.format(structure_json=preview, question=question)
    try:
        raw = llm_completion(model, prompt)
        if not raw: return {"reasoning": "检索模型返回为空，请检查模型服务", "nodes": [], "error": True}
        cleaned = re.sub(r'```(?:json)?\s*', '', raw); cleaned = re.sub(r'\s*```', '', cleaned).strip()
        m = re.search(r'\{.*\}', cleaned, re.DOTALL)
        if not m: return {"reasoning": "检索模型返回格式异常，请确认模型支持 JSON 指令", "nodes": [], "error": True}
        parsed = json.loads(m.group())
        reasoning = parsed.get("reasoning", "") or ""
        node_keys = parsed.get("node_ids", [])
        if not isinstance(node_keys, list): node_keys = []
        nodes = []
        for key in node_keys:
            parts = key.split("::", 1)
            if len(parts) == 2:
                did, nid = parts
                doc = kb["docs"].get(did)
                if doc:
                    for n in _get_leaf_nodes(doc.get("structure",[])):
                        if n["node_id"] == nid:
                            nodes.append({**n, "doc_id": did, "doc_name": doc.get("doc_name","")})
                            break
        return {"reasoning": reasoning.strip(), "nodes": nodes}
    except Exception as e:
        return {"reasoning": f"检索出错: {str(e)}", "nodes": [], "error": True}

# ── FastAPI ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    studio.recover_interrupted()
    try:
        yield
    finally:
        studio.shutdown()

app = FastAPI(title="PageIndex", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=Path(__file__).resolve().parent / "static"), name="static")

def _model_action(action, *args, **kwargs):
    try:
        return action(*args, **kwargs)
    except KeyError as exc:
        raise HTTPException(404, '服务或模型配置不存在') from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post('/api/model-providers')
async def create_model_provider(body: dict):
    return _model_action(model_registry.save_provider, body)


@app.get('/api/model-providers/{provider_id}')
async def get_model_provider(provider_id: str):
    return _model_action(model_registry.get_provider, provider_id)


@app.put('/api/model-providers/{provider_id}')
async def update_model_provider(provider_id: str, body: dict):
    return _model_action(model_registry.save_provider, body, provider_id)


@app.delete('/api/model-providers/{provider_id}')
async def delete_model_provider(provider_id: str):
    return _model_action(model_registry.delete_provider, provider_id)


@app.post('/api/model-providers/{provider_id}/models')
async def add_provider_models(provider_id: str, body: dict):
    return _model_action(model_registry.add_models, provider_id, body.get('models'))


@app.get('/api/models')
async def list_models():
    return {**_model_action(model_registry.list), 'environment_model': ConfigLoader().load().model}


@app.post('/api/models')
async def create_model(body: dict):
    return _model_action(model_registry.save, body)


@app.put('/api/models/defaults/{kind}')
async def set_default_model(kind: str, body: dict):
    return _model_action(model_registry.set_default, kind, body.get('model_id'))


@app.get('/api/models/{model_id}')
async def get_model(model_id: str):
    return _model_action(model_registry.get, model_id)


@app.put('/api/models/{model_id}')
async def update_model(model_id: str, body: dict):
    return _model_action(model_registry.save, body, model_id)


@app.delete('/api/models/{model_id}')
async def delete_model(model_id: str):
    return _model_action(model_registry.delete, model_id)


@app.post('/api/models/{model_id}/test')
def test_model(model_id: str):
    config = _model_action(model_registry.get, model_id)
    started = time.perf_counter()
    try:
        with OpenAI(base_url=config['base_url'], api_key=config['api_key'] or 'not-required', timeout=15, max_retries=0) as client:
            if config['kind'] == 'embedding':
                result = client.embeddings.create(model=config['model'], input=['connection test'], encoding_format='float')
                if not result.data or not result.data[0].embedding:
                    raise ValueError('向量服务未返回有效数据')
                extra = {'dimensions': len(result.data[0].embedding)}
            elif config['kind'] == 'vision':
                pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1Z0AAAAASUVORK5CYII='
                result = client.chat.completions.create(model=config['model'], messages=[{'role': 'user', 'content': [
                    {'type': 'text', 'text': 'Reply OK if you can see this image.'},
                    {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + pixel}}]}], max_tokens=8)
                if not result.choices:
                    raise ValueError('视觉服务未返回有效内容')
                extra = {}
            else:
                result = client.chat.completions.create(model=config['model'], messages=[{'role': 'user', 'content': 'Reply OK.'}], max_tokens=8)
                if not result.choices:
                    raise ValueError('对话服务未返回有效内容')
                extra = {}
        return {'ok': True, 'elapsed_ms': round((time.perf_counter()-started)*1000), **extra}
    except Exception as exc:
        status = getattr(exc, 'status_code', None)
        message = {401: '鉴权失败，请检查 API Key', 403: '服务拒绝访问，请检查权限',
                   404: '接口或模型不存在，请检查 Base URL 和模型标识', 429: '服务限流或额度不足'}.get(status, '连接失败，请检查服务地址、模型标识和网络，或确认服务返回兼容格式')
        raise HTTPException(400, message) from None


_KB_STOP_WORDS = set("preface foreword abstract glossary acknowledgments acknowledgement about after before chapter content contents document documents introduction overview summary guide manual index page pages section table using user based general information report annual system data test guidebook truncated appendix references conclusion contributions evaluation results language large model models training performance approach method methods with from that this these into have been more also their than which through without between under over part including used use the and for are not pdf markdown readme".split())


def _kb_keywords(kb: dict) -> set[str]:
    """仅从名称和章节标题提取关联词，不读取正文或调用模型。"""
    titles = [kb.get("name", "")]

    def collect(nodes):
        for node in nodes:
            titles.append(node.get("title", ""))
            collect(node.get("nodes") or [])

    for doc in kb.get("docs", {}).values():
        titles.append(Path(doc.get("doc_name", "")).stem)
        collect(doc.get("structure") or [])
    words = set()
    for title in titles:
        title = re.sub(r"使用指南|用户手册|操作手册|测试知识库|我的知识库|知识库|第[一二三四五六七八九十百\d]+章|目录|简介|概述|总结|介绍|附录|参考文献", " ", str(title).lower())
        for word in re.findall(r"[a-z][a-z0-9_-]{3,}|[\u4e00-\u9fff]{2,}", title):
            if word not in _KB_STOP_WORDS:
                words.add(word)
    return words


def _knowledge_graph(knowledge_bases: dict) -> dict:
    nodes, links, keywords, documents = [], [], {}, {}
    for kid, kb in knowledge_bases.items():
        docs = list(kb.get("docs", {}).values())
        keywords[kid] = _kb_keywords(kb)
        documents[kid] = {re.sub(r"\s+", " ", d.get("doc_name", "")).strip().casefold(): d.get("doc_name", "") for d in docs if d.get("doc_name")}
        nodes.append({"kb_id": kid, "name": kb.get("name", ""), "doc_count": len(docs),
                      "page_count": sum(d.get("page_count") or 0 for d in docs),
                      "doc_names": [d.get("doc_name", "") for d in docs[:3]]})
    for i, source in enumerate(nodes):
        sid = source["kb_id"]
        for target in nodes[i + 1:]:
            tid = target["kb_id"]
            shared_docs = [documents[sid][name] for name in sorted(documents[sid].keys() & documents[tid].keys())]
            shared_topics = sorted(keywords[sid] & keywords[tid])
            if shared_docs or len(shared_topics) >= 2:
                links.append({"source": sid, "target": tid, "shared_documents": shared_docs,
                              "shared_topics": shared_topics[:8]})
    return {"nodes": nodes, "links": links}


@app.get("/api/kb/graph")
async def knowledge_graph():
    return _knowledge_graph(store["knowledge_bases"])

@app.get("/api/kb")
async def list_kbs():
    return {"knowledge_bases": [
        {"kb_id": kid, "name": kb.get("name",""), "doc_count": len(kb.get("docs",{}))}
        for kid, kb in store["knowledge_bases"].items()]}

@app.post("/api/kb")
async def create_kb(body: dict):
    kb_id = str(uuid.uuid4())[:8]
    kb = {"kb_id": kb_id, "name": body.get("name", "新知识库"), "docs": {}}
    store["knowledge_bases"][kb_id] = kb
    _save_store(store)
    return kb

@app.delete("/api/kb/{kb_id}")
async def delete_kb(kb_id: str):
    with store_lock:
        kb = store["knowledge_bases"].pop(kb_id, None)
        if kb:
            for doc in kb.get("docs", {}).values():
                for path in _document_files(doc):
                    if path.is_file(): path.unlink()
        _save_store(store)
    return {"ok": True}

@app.get("/api/kb/{kb_id}/docs")
async def list_docs(kb_id: str):
    kb = store["knowledge_bases"].get(kb_id)
    if not kb: raise HTTPException(404, "知识库未找到")
    return {"docs": [{"doc_id": did, "doc_name": d.get("doc_name",""), "page_count": d.get("page_count"),
                     "type": d.get("type"), "source_type": d.get("source_type")}
                     for did, d in kb.get("docs", {}).items()]}


@app.get("/api/kb/{kb_id}/docs/{doc_id}")
async def get_doc(kb_id: str, doc_id: str):
    kb = store["knowledge_bases"].get(kb_id)
    if not kb: raise HTTPException(404, "知识库未找到")
    doc = kb.get("docs", {}).get(doc_id)
    if not doc: raise HTTPException(404, "文档未找到")

    def sections(nodes):
        return [{**{key: n.get(key) for key in ("node_id", "title", "start_index", "end_index", "summary")},
                 "nodes": sections(n.get("nodes") or [])} for n in nodes]

    return {"doc_id": doc_id, "doc_name": doc.get("doc_name", ""), "kb_name": kb.get("name", ""),
            "type": doc.get("type", ""), "source_type": doc.get("source_type"), "page_count": studio.page_count(doc),
            "description": doc.get("doc_description", ""), "structure": sections(doc.get("structure") or []),
            "index_options": doc.get("index_options", {}), "indexed_at": doc.get("indexed_at"), "ocr_pages": doc.get("ocr_pages", [])}


@app.post("/api/kb/{kb_id}/docs")
async def upload_doc(kb_id: str, file: UploadFile = File(...), model: str = Form(""), model_id: str | None = Form(None)):
    kb = store["knowledge_bases"].get(kb_id)
    if not kb: raise HTTPException(404, "知识库未找到")
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in (".pdf", ".md", ".markdown", *WORD_SUFFIXES): raise HTTPException(400, "支持 PDF、Word（DOCX／DOC）和 Markdown")
    if ext in WORD_SUFFIXES:
        try:
            find_soffice()
        except ValueError as exc:
            raise HTTPException(503, str(exc)) from None
    selected_model = _model_action(model_registry.resolve, model_id, legacy_model=model)
    model = selected_model['model'] if selected_model else model or 'deepseek/deepseek-chat'
    orig = str(uuid.uuid4()); fp = UPLOAD_DIR / f"{orig}{ext}"
    with open(fp, "wb") as f:
        os.fchmod(f.fileno(), 0o600)
        f.write(await file.read())
    source, conversion = fp, None
    try:
        if ext in WORD_SUFFIXES:
            fp = UPLOAD_DIR / (str(uuid.uuid4()) + '.pdf')
            conversion = await asyncio.to_thread(convert_word_to_pdf, source, fp)
            ext = '.pdf'
        with model_context(selected_model):
            opt = ConfigLoader().load({"model": model})
            loop = asyncio.get_running_loop()
            if ext == ".pdf":
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    result = await loop.run_in_executor(pool, copy_context().run, lambda: page_index_main(doc=str(fp), opt=opt))
            else:
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    result = await loop.run_in_executor(pool, copy_context().run, lambda: asyncio.run(md_to_tree(
                        md_path=str(fp), if_thinning=False, if_add_node_summary="yes",
                        summary_token_threshold=200, model=opt.model,
                        if_add_doc_description="yes", if_add_node_text="no", if_add_node_id="yes")))
        doc_id = str(uuid.uuid4())[:8]
        doc_info = {"doc_id": doc_id, "doc_name": file.filename,
                    "doc_description": result.get("doc_description",""),
                    "structure": result.get("structure",[]), "type": "pdf" if ext==".pdf" else "md",
                    "file_path": str(fp), "orig_file": orig}
        if conversion:
            doc_info.update(source_type=source.suffix.lower().lstrip('.'), source_file_path=str(source), conversion=conversion)
        if ext == ".pdf":
            doc_info["page_count"] = result.get("page_count", 0) or pymupdf.open(str(fp)).page_count

        # ── Pre-extract page texts (pymupdf + vision for image/scanned pages) ──
        if ext == ".pdf" and doc_info["page_count"] > 0:
            page_texts = {}
            try:
                mu_doc = pymupdf.open(str(fp))
                low_text_pages = []
                for i in range(len(mu_doc)):
                    txt = mu_doc[i].get_text().strip()
                    page_texts[str(i + 1)] = txt
                    if len(txt) < 50:
                        low_text_pages.append(i + 1)
                if low_text_pages and VISION_API_KEY:
                    try:
                        vision_results = _vision_ocr(str(fp), low_text_pages)
                        for p, txt in vision_results.items():
                            if txt:
                                page_texts[str(p)] = txt
                    except Exception:
                        pass
            except Exception as e:
                pass
            if page_texts:
                doc_info["page_texts"] = page_texts

        kb.setdefault("docs", {})[doc_id] = doc_info
        _save_store(store)
        return doc_info
    except Exception as e:
        raise HTTPException(500, f"处理失败: {str(e)}")

@app.delete("/api/kb/{kb_id}/docs/{doc_id}")
async def delete_doc(kb_id: str, doc_id: str):
    with store_lock:
        kb = store["knowledge_bases"].get(kb_id)
        if not kb: raise HTTPException(404, "知识库未找到")
        doc = kb.get("docs", {}).pop(doc_id, None)
        if doc:
            for path in _document_files(doc):
                if path.is_file(): path.unlink()
        _save_store(store)
    return {"ok": True}

@app.get("/api/conversations")
async def list_convs():
    convs = sorted(store.get("conversations", {}).values(), key=lambda c: c.get("created_at",""), reverse=True)
    return {"conversations": [{"conv_id": c["conv_id"], "title": c.get("title",""),
            "kb_id": c.get("kb_id",""), "created_at": c.get("created_at",""),
            "msg_count": len(c.get("messages",[]))} for c in convs]}

@app.get("/api/conversations/{conv_id}")
async def get_conv(conv_id: str):
    conv = store.get("conversations", {}).get(conv_id)
    if not conv: raise HTTPException(404, "对话未找到")
    return conv

@app.post("/api/conversations")
async def create_conv(body: dict):
    kb_id = body.get("kb_id", ""); conv_id = str(uuid.uuid4())[:8]
    conv = {"conv_id": conv_id, "title": "新对话", "kb_id": kb_id,
            "created_at": datetime.now().isoformat(), "messages": []}
    store.setdefault("conversations", {})[conv_id] = conv
    _save_store(store)
    return conv

@app.delete("/api/conversations/{conv_id}")
async def delete_conv(conv_id: str):
    with store_lock:
        conv = store.setdefault("conversations", {}).pop(conv_id, None)
        _save_store(store)
        if conv:
            remove_traces(conv.get('messages', []))
    return {"ok": True}

@app.post("/api/chat")
async def api_chat(body: dict):
    conv_id = body.get("conv_id", ""); kb_id = body.get("kb_id", "")
    question = body.get("question", "").strip(); model = body.get("model", "deepseek/deepseek-chat")
    if not kb_id or not question: raise HTTPException(400, "缺少 kb_id 或 question")
    kb = store["knowledge_bases"].get(kb_id)
    if not kb: raise HTTPException(404, "知识库未找到")
    selected_model = _model_action(model_registry.resolve, body.get('model_id'), legacy_model=body.get('model'))
    try:
        with model_context(selected_model):
            trace = _tree_search(kb, question, model)
            relevant, reasoning = trace.get("nodes",[]), trace.get("reasoning","")
            refs = []; pages_by_doc = {}
            for n in relevant:
                ref = {"title": n.get("title",""), "doc_name": n.get("doc_name","")}
                s, e = n.get("start_index"), n.get("end_index", n.get("start_index"))
                if s is not None: ref["pages"] = f"p{s}" + (f"-{e}" if e!=s else "")
                refs.append(ref)
                did = n.get("doc_id")
                if did and did not in pages_by_doc: pages_by_doc[did] = n
            if pages_by_doc:
                all_text = []; all_ranges = []
                for did, nn in pages_by_doc.items():
                    doc = kb["docs"].get(did)
                    if doc and doc.get("type")=="pdf":
                        rs, txt = _collect_pages_text_hybrid(doc, [nn])
                        if rs: all_ranges.append(f"[{doc.get('doc_name','')}] {rs}")
                        if txt: all_text.append(f"[{doc.get('doc_name','')}]\n{txt}")
                page_ranges = "; ".join(all_ranges); page_content = "\n\n".join(all_text)
            else:
                page_ranges, page_content = "", ""
            chat_history = ""
            if conv_id:
                conv = store.setdefault("conversations", {}).get(conv_id, {})
                for m in conv.get("messages", []):
                    chat_history += f"{'User' if m['role']=='user' else 'Assistant'}: {m['content']}\n"
            if page_content.strip():
                answer = llm_completion(model, QA_PROMPT.format(page_ranges=page_ranges, page_content=page_content, chat_history=chat_history, question=question))
            else:
                all_struct = json.dumps({did: d.get("structure",[]) for did,d in kb.get("docs",{}).items()}, ensure_ascii=False, indent=2)
                answer = llm_completion(model, f"Based on document structures below, answer. If not possible, say so.\n\n{all_struct}\n\nChat history:\n{chat_history}\n\nQuestion: {question}\nAnswer:")
            answer = answer.strip()
            if conv_id:
                convs = store.setdefault("conversations", {})
                conv = convs.setdefault(conv_id, {"conv_id": conv_id, "title": "新对话", "kb_id": kb_id,
                        "created_at": datetime.now().isoformat(), "messages": []})
                conv["messages"].append({"role": "user", "content": question})
                conv["messages"].append({"role": "assistant", "content": answer, "refs": refs, "reasoning": reasoning})
                if conv["title"] == "新对话": conv["title"] = question[:40] + ("..." if len(question)>40 else "")
                _save_store(store)
            return {"answer": answer, "refs": refs, "reasoning": reasoning}
    except Exception as e:
        raise HTTPException(500, f"检索失败: {str(e)}")

# ── HTML ─────────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def root():
    from fastapi.responses import Response
    html = HTML_TEMPLATE
    for asset in ("knowledge.css", "knowledge.js", "models.css", "models.js", "neural-scene.js", "neural-scene.css", "studio.js", "studio.css"):
        version = (Path(__file__).resolve().parent / "static" / asset).stat().st_mtime_ns
        html = html.replace(f"/static/{asset}", f"/static/{asset}?v={version}")
    return Response(content=html, media_type="text/html", headers={"Cache-Control": "no-cache, no-store, must-revalidate"})

HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="color-scheme" content="dark">
<title>PageIndex · 知识工作台</title>
<link rel="stylesheet" href="/static/knowledge.css">
<link rel="stylesheet" href="/static/neural-scene.css">
<link rel="stylesheet" href="/static/models.css">
<style>
:root{--bg:#0d0f10;--panel:#141718;--surface:rgba(255,255,255,.035);--line:rgba(230,233,230,.09);--line-strong:rgba(230,233,230,.18);--text:#e8ebe7;--secondary:#a5ada8;--muted:#747e79;--gold:#decba0;--mint:#a7d4c2;--danger:#ef9b9b;--radius:16px;color-scheme:dark}
*{margin:0;padding:0;box-sizing:border-box}
body{font:13px/1.6 -apple-system,BlinkMacSystemFont,'SF Pro Text','PingFang SC','Microsoft YaHei',sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}
button,input,textarea{font:inherit;color:inherit}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.35}button,a,input,textarea{ -webkit-tap-highlight-color:transparent}button{transition:background .18s,border-color .18s,color .18s,box-shadow .18s}button:focus-visible,summary:focus-visible{outline:2px solid var(--gold);outline-offset:4px}input:focus-visible,textarea:focus-visible{outline:none}button:disabled:hover{box-shadow:none}
svg.icon{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0;vertical-align:middle}.sprite{position:absolute;width:0;height:0;overflow:hidden}
.app{display:grid;grid-template-columns:280px minmax(0,1fr) auto;grid-template-rows:72px minmax(0,1fr);height:100vh;height:100dvh;overflow:hidden}
.topbar{grid-column:1/-1;display:flex;align-items:center;gap:24px;padding:0 26px;border-bottom:1px solid var(--line);background:rgba(16,19,20,.9);z-index:20}
.brand{display:flex;align-items:center;gap:12px;text-decoration:none;color:var(--text);min-width:230px}.brand-mark{display:grid;place-items:center;width:35px;height:38px;background:linear-gradient(140deg,rgba(229,234,221,.16),rgba(255,255,255,.02));border:1px solid var(--line-strong);border-radius:11px;box-shadow:0 0 20px #dbe1d20b}.brand-mark svg{width:21px;height:23px}.brand-name{font-size:17px;font-weight:600;letter-spacing:-.5px}.brand-name span{color:var(--gold)}.brand-sub{font-size:9px;letter-spacing:2.2px;color:var(--muted);line-height:1.1;margin-top:1px}
.top-nav{display:flex;align-items:center;gap:8px;padding:5px 14px;border:1px solid var(--line-strong);border-radius:24px;background:linear-gradient(180deg,#ffffff0a,#ffffff02);font-size:12px;box-shadow:inset 0 1px #ffffff08}.top-nav .icon{width:14px;height:14px;color:var(--gold)}.top-nav small{color:var(--muted);font-size:9px;letter-spacing:1px;margin-left:5px}.top-meta{margin-left:auto;color:var(--muted);font-size:11px;display:flex;align-items:center;gap:16px}.local-status{display:flex;align-items:center;gap:7px}.status-dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--mint);box-shadow:0 0 8px #a7d4c24d}.avatar{width:30px;height:30px;display:grid;place-items:center;border:1px solid var(--line-strong);border-radius:50%;background:radial-gradient(circle at 35% 30%,#5b6259,#1c2422 55%,#0c1110);font-size:10px;color:var(--gold)}
.sidebar{grid-column:1;grid-row:2;min-height:0;background:linear-gradient(145deg,#16191a,#101314);border-right:1px solid var(--line);display:flex;flex-direction:column;z-index:15}.sidebar-intro{padding:25px 22px 18px}.eyebrow{font-size:9px;letter-spacing:2px;color:var(--gold);font-weight:500}.sidebar-intro h1{font-size:18px;font-weight:500;margin-top:7px;letter-spacing:.5px}.sidebar-intro p{font-size:11px;color:var(--muted);margin-top:4px}
.sb-block{padding:15px 14px;border-top:1px solid var(--line)}.sb-block h2{font-size:11px;font-weight:500;color:var(--secondary);display:flex;align-items:center;gap:8px;padding:0 8px;margin-bottom:12px}.section-en{font-size:9px;color:var(--muted);font-weight:400;letter-spacing:1px}.section-count{font-size:10px;color:var(--muted);margin-left:auto;font-variant-numeric:tabular-nums}.add{width:24px;height:24px;border:1px solid var(--line);border-radius:7px;background:var(--surface);color:var(--secondary);display:grid;place-items:center;margin-left:auto}.add .icon{width:13px;height:13px}.add:hover{color:var(--gold);border-color:var(--line-strong)}
.kb-list{max-height:26vh;overflow-y:auto}.kb-item,.doc-item{display:flex;align-items:center;gap:8px;border:1px solid transparent;border-radius:10px;margin:3px 0;min-width:0;transition:background .18s,border-color .18s}.kb-item:hover,.doc-item:hover,.h-item:hover{background:var(--surface)}.kb-item.active{background:linear-gradient(100deg,#d8e1d80d,#ffffff03);border-color:#cdd9d323;box-shadow:inset 2px 0 var(--gold)}.kb-select{border:0;background:none;display:flex;align-items:center;gap:10px;text-align:left;min-width:0;flex:1;padding:11px 4px 11px 12px}.kb-select .icon{width:17px;height:17px;color:var(--muted)}.active .kb-select .icon{color:var(--gold)}.name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.meta{font-size:10px;color:var(--muted);white-space:nowrap}.del{border:0;background:none;color:var(--muted);padding:6px;font-size:16px;line-height:1;border-radius:5px;flex-shrink:0;margin-right:4px;opacity:0}.kb-item:hover .del,.doc-item:hover .del,.h-item:hover .del,.del:focus-visible{opacity:1}.del:hover{color:var(--danger);background:#ef9b9b10}
#docBlock{flex:1;min-height:0;display:flex;flex-direction:column}.doc-list{flex:1;min-height:90px;overflow:auto;margin-bottom:13px}.doc-item{padding:9px 0 9px 9px}.file-mark{display:grid;place-items:center;width:28px;height:32px;background:#a7d4c20a;border:1px solid #a7d4c21a;color:var(--mint);border-radius:7px;flex-shrink:0}.file-mark .icon{width:14px;height:14px}.doc-info{flex:1;min-width:0}.doc-info .meta{font-size:9px;margin-top:2px}.doc-info .meta::before{content:'';display:inline-block;width:4px;height:4px;margin-right:5px;background:var(--mint);border-radius:50%;vertical-align:2px}
.upload-row{padding:0 6px}.upload-row input[type=file]{display:none}.upload-button{display:flex;align-items:center;justify-content:center;gap:8px;min-height:42px;width:100%;border:1px dashed #bbc9bf33;border-radius:10px;background:#cedbc604;color:var(--secondary);font-size:11px}.upload-button:not(:disabled):hover{border-color:var(--gold);background:#decba009;color:var(--gold)}.upload-button .icon{width:15px;height:15px}.upload-caption{font-size:9px;color:var(--muted);text-align:center;margin-top:7px;letter-spacing:.2px}.sidebar-foot{padding:17px 22px;border-top:1px solid var(--line);margin-top:auto;display:flex;align-items:center;justify-content:space-between;color:var(--muted);font-size:10px}.sidebar-foot span:last-child{font-size:9px;letter-spacing:1px}.empty-hint{padding:22px 12px;text-align:center;color:var(--muted);font-size:11px}
.main{grid-column:2;grid-row:2;min-width:0;min-height:0;display:flex;flex-direction:column;position:relative;background:radial-gradient(ellipse at 50% 30%,#26312a38,transparent 63%),var(--bg)}.main::before{content:'';position:absolute;inset:0;pointer-events:none;background-image:radial-gradient(#bac9bb18 .65px,transparent .65px);background-size:24px 24px;mask-image:radial-gradient(ellipse at 50% 35%,#000,transparent 70%)}.main>*{position:relative}.chat-header{display:flex;align-items:center;gap:12px;padding:0 32px;min-height:66px;flex-shrink:0;border-bottom:1px solid #ffffff05}.header-title{display:flex;align-items:center;gap:9px;color:var(--secondary);font-size:12px;min-width:0}.header-title>.icon{width:15px;height:15px;color:var(--gold)}.kb-badge{color:var(--text);max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.no-kb{color:var(--muted);font-size:12px}.header-divider{width:1px;height:13px;background:var(--line-strong)}.spacer{flex:1}.header-state{display:flex;align-items:center;gap:6px;font-size:10px;color:var(--muted);white-space:nowrap}.header-state .status-dot{width:4px;height:4px}.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:32px;padding:6px 13px;border-radius:22px;font-size:11px;font-weight:500;border:1px solid var(--line-strong);background:#ffffff04;white-space:nowrap}.btn:hover{background:#ffffff0b;border-color:#dde6d837}.btn .icon{width:14px;height:14px}.btn-primary{background:linear-gradient(140deg,#ebeee8,#bdc7bd);border-color:transparent;color:#1b211e;box-shadow:0 3px 17px #dce9d015}.btn-primary:not(:disabled):hover{background:linear-gradient(140deg,#f9fbf6,#d0dace);box-shadow:0 3px 22px #dce9d028}.btn-ghost{display:grid;place-items:center;border:1px solid transparent;background:none;color:var(--secondary);width:31px;height:31px;border-radius:9px}.btn-ghost:hover{background:var(--surface);border-color:var(--line)}.mobile-only{display:none}
.chat-msgs{flex:1;min-height:0;overflow-y:auto;padding:25px max(30px,calc((100% - 800px)/2));scroll-behavior:smooth;overscroll-behavior:contain}.placeholder{display:flex;align-items:center;justify-content:center;flex-direction:column;min-height:100%;max-width:760px;margin:auto;padding:10px 0 20px;text-align:center;animation:arrive .6s ease both}.welcome-eyebrow{color:var(--gold);font-size:10px;letter-spacing:3px;margin-bottom:12px}.placeholder h2{font-size:clamp(26px,3.2vw,42px);line-height:1.45;font-weight:500;letter-spacing:1px;background:linear-gradient(120deg,#f5f6f1 20%,#cdd5cb 65%,#decba0);background-clip:text;-webkit-background-clip:text;color:transparent}.welcome-desc{color:var(--muted);font-size:12px;margin-top:12px;line-height:1.9}.welcome-desc strong{font-weight:400;color:var(--secondary)}
.knowledge-orb{width:235px;height:160px;position:relative;flex-shrink:0;margin:0 auto 20px;isolation:isolate}.orb-glow{position:absolute;inset:-30px;background:radial-gradient(ellipse,#b8d1b51f,transparent 65%);filter:blur(10px)}.orb-core{position:absolute;width:92px;height:92px;left:calc(50% - 46px);top:34px;border-radius:50%;background:radial-gradient(circle at 31% 26%,#e1e8d976,#abb9a324 30%,#131b1799 65%,#a5b8a53b 98%);box-shadow:inset -8px -9px 18px #000a,inset 1px 1px 10px #e6e9d14d,0 0 30px #dae9c912,0 0 70px #bed6b50b;animation:breathe 6s ease-in-out infinite}.orb-core::before,.orb-core::after{content:'';position:absolute;inset:8px;border:1px solid #d0ddc92e;border-radius:50%;transform:rotate(-32deg) scaleX(.46)}.orb-core::after{inset:18px -1px;transform:rotate(-32deg) scaleY(.48);border-color:#d0ddc945}.orb-lines{position:absolute;inset:0;width:100%;height:100%;overflow:visible}.orb-lines path,.orb-lines ellipse{fill:none;stroke:#d9e6d726;stroke-width:.7}.orb-lines .gold-line{stroke:#decba04a}.orb-lines circle{fill:var(--mint);filter:drop-shadow(0 0 4px #a7d4c2)}.orb-lines .gold-dot{fill:var(--gold)}.orbit-label{position:absolute;font-size:8px;color:#8c9c91;letter-spacing:1px}.orbit-label.first{top:14px;left:38px}.orbit-label.second{right:7px;top:112px}.orb-dot{position:absolute;left:30px;top:88px;width:4px;height:4px;background:var(--gold);border-radius:50%;box-shadow:0 0 12px var(--gold);animation:drift 7s ease-in-out infinite}
.feature-strip{display:flex;align-items:center;justify-content:center;gap:20px;margin-top:22px;color:var(--secondary);font-size:10px}.feature-strip span{display:flex;align-items:center;gap:6px}.feature-strip .icon{width:13px;height:13px;color:var(--gold)}.feature-strip span+span{padding-left:20px;border-left:1px solid var(--line-strong)}.suggestion-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px;width:100%;max-width:550px;margin-top:35px}.suggestion{padding:13px 15px;display:flex;align-items:center;gap:11px;text-align:left;border:1px solid var(--line);border-radius:12px;background:linear-gradient(130deg,#e4f1dd06,#ffffff02);color:var(--secondary)}.suggestion:hover{background:#cad8c509;border-color:#d5dfcf30;color:var(--text);transform:translateY(-1px)}.suggestion .icon{width:16px;height:16px;color:var(--muted)}.suggestion span{flex:1;font-size:11px}.suggestion .arrow{flex:0;font-size:14px;color:var(--muted)}.welcome-hint{font-size:10px;color:var(--muted);margin-top:14px}
.chat-input{padding:15px 30px 22px;flex-shrink:0}.composer{max-width:800px;margin:auto;border:1px solid #d9e2d526;border-radius:19px;background:linear-gradient(125deg,#30372e6e,#1b211d80);box-shadow:inset 0 1px #ffffff06,0 12px 45px #0004;backdrop-filter:blur(20px);transition:border-color .2s,box-shadow .2s}.composer:focus-within{border-color:#decba066;box-shadow:0 0 0 3px #decba008,0 12px 45px #0004}.chat-input textarea{display:block;width:100%;min-height:49px;max-height:150px;border:0;background:none;padding:15px 19px 8px;resize:none;line-height:1.65;font-size:12px}.chat-input textarea::placeholder{color:#8b968e}.chat-input textarea:disabled{opacity:.55}.composer-bottom{display:flex;align-items:center;gap:10px;padding:6px 10px 10px 17px;min-height:40px}.composer-source{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--muted);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.composer-source .icon{width:12px;height:12px}.composer-bottom .spacer{min-width:4px}.shortcut{font-size:9px;color:var(--muted)}.send-btn{height:30px;min-width:30px;border-radius:50%;padding:0;flex-shrink:0}.send-btn .icon{width:15px;height:15px}.input-footnote{max-width:800px;display:flex;justify-content:space-between;gap:12px;margin:10px auto 0;color:var(--muted);font-size:9px;letter-spacing:.2px}.input-footnote span:last-child{letter-spacing:1px}
.msg{max-width:94%;margin-bottom:24px;animation:arrive .25s ease both;min-width:0}.msg.user{margin-left:auto;max-width:85%}.msg.assistant{margin-right:auto}.msg-label{display:flex;align-items:center;gap:7px;font-size:10px;color:var(--muted);margin-bottom:8px;letter-spacing:.5px}.msg.user .msg-label{justify-content:flex-end}.msg-label .icon{width:13px;height:13px;color:var(--gold)}.msg-b{font-size:13px;line-height:1.9;white-space:pre-wrap;overflow-wrap:anywhere;padding:17px 20px;border-radius:15px;border:1px solid var(--line)}.msg.user .msg-b{background:linear-gradient(130deg,#d7e3d416,#c6d5c209);border-bottom-right-radius:4px;color:#e3eadd;border-color:#d7e3d41a}.msg.assistant .msg-b{background:linear-gradient(130deg,#2d342c45,#161c183d);border-bottom-left-radius:4px}.msg-refs{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.ref-tag{display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:4px 9px;border:1px solid #a7d4c224;border-radius:7px;background:#a7d4c207;color:var(--mint);font-size:10px;overflow-wrap:anywhere}.ref-tag .icon{width:11px;height:11px}.reasoning-box{border:1px solid var(--line);border-radius:11px;margin-bottom:9px;background:#ffffff02;font-size:11px}.reasoning-box summary{padding:9px 13px;cursor:pointer;color:var(--secondary)}.reasoning-box summary::marker{color:var(--gold)}.reasoning-body{padding:12px 15px;border-top:1px solid var(--line);white-space:pre-wrap;color:var(--muted);line-height:1.8;overflow-wrap:anywhere}
.history-panel{grid-column:3;grid-row:2;width:0;overflow:hidden;border-left:0 solid var(--line);transition:width .25s;background:linear-gradient(160deg,#171b1a,#101414);z-index:25}.history-panel.open{width:270px;border-left-width:1px}.history-inner{width:270px;height:100%;display:flex;flex-direction:column}.h-head{display:flex;align-items:center;gap:7px;padding:21px 16px;border-bottom:1px solid var(--line)}.h-head h2{font-size:12px;font-weight:500;flex:1}.h-head h2 small{display:block;color:var(--muted);font-size:9px;letter-spacing:1.5px;font-weight:400;margin-top:2px}.h-list{flex:1;overflow-y:auto;padding:12px}.h-item{display:flex;align-items:center;border:1px solid transparent;border-radius:10px;margin-bottom:5px}.h-item.active{background:#cbdac309;border-color:var(--line-strong)}.h-select{border:0;background:none;padding:11px;text-align:left;flex:1;min-width:0}.h-item .title{font-size:11px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.h-item .time{font-size:9px;color:var(--muted);margin-top:5px}.backdrop{display:none}.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:calc(100vw - 32px);padding:11px 20px;background:#222a24;border:1px solid var(--line-strong);border-radius:12px;box-shadow:0 12px 40px #0008;color:var(--text);font-size:12px;z-index:100}.toast[hidden]{display:none}
::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-thumb{background:#899d8130;border-radius:5px}::-webkit-scrollbar-thumb:hover{background:#899d8150}::selection{background:#decba035;color:#fff}
@keyframes arrive{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}@keyframes breathe{50%{transform:translateY(-5px);box-shadow:inset -8px -9px 18px #000a,inset 1px 1px 10px #e6e9d14d,0 0 40px #dae9c91c,0 0 80px #bed6b510}}@keyframes drift{50%{transform:translate(9px,-5px);opacity:.45}}
@media(min-width:1600px){.app{grid-template-columns:300px minmax(0,1fr) auto}.sidebar-intro{padding-top:30px}.chat-header{padding-inline:40px}.knowledge-orb{margin-bottom:27px}.suggestion-grid{margin-top:40px}}
@media(max-width:1150px){.history-panel{position:absolute;right:0;top:72px;bottom:0;box-shadow:-20px 0 60px #0005}.chat-header{padding-inline:24px}.top-meta>span:first-child{display:none}}
@media(max-width:800px){.app{grid-template-columns:minmax(0,1fr);grid-template-rows:60px minmax(0,1fr)}.topbar{padding:0 17px;gap:14px}.brand{min-width:0;gap:9px}.brand-name{font-size:16px}.brand-sub{font-size:8px}.brand-mark{width:30px;height:33px}.top-nav{margin-left:auto;padding:5px 10px}.top-nav small,.top-meta,.brand-sub{display:none}.main{grid-column:1}.sidebar{position:fixed;top:60px;bottom:0;left:0;width:280px;transform:translateX(-100%);transition:transform .25s;box-shadow:15px 0 60px #0007;z-index:40}.sidebar.open{transform:translateX(0)}.mobile-only{display:grid}.chat-header{padding:0 16px;min-height:60px;gap:8px}.chat-header .header-state{display:none}.chat-msgs{padding:18px 22px}.chat-input{padding:12px 18px 16px}.placeholder h2{font-size:32px}.knowledge-orb{width:215px;height:146px;margin-bottom:16px}.suggestion-grid{margin-top:27px}.history-panel{top:60px;z-index:40}.backdrop.visible{display:block;position:fixed;inset:60px 0 0;background:#0008;backdrop-filter:blur(3px);z-index:35;border:0;width:100%}.del{opacity:.7}}
@media(max-width:430px){.chat-msgs{padding:12px 18px}.placeholder{padding-top:0}.placeholder h2{font-size:27px}.welcome-desc{font-size:11px}.knowledge-orb{height:132px;margin-bottom:12px;transform:scale(.9)}.welcome-eyebrow{font-size:8px;margin-bottom:10px}.feature-strip{gap:10px;font-size:9px;margin-top:17px}.feature-strip span+span{padding-left:10px}.suggestion-grid{gap:7px;margin-top:24px}.suggestion{padding:11px 10px;gap:6px}.suggestion span{font-size:10px}.suggestion .icon{width:13px;height:13px}.suggestion .arrow{display:none}.header-title>.icon,.header-divider,.shortcut{display:none}.chat-header .btn{font-size:10px;padding:6px 10px}.input-footnote{font-size:8px}.composer-bottom{padding-left:13px}.chat-input{padding-inline:14px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
</style>
<link rel="stylesheet" href="/static/studio.css">
</head>
<body>
<svg class="sprite" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><defs>
<symbol id="i-grid" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></symbol>
<symbol id="i-book" viewBox="0 0 24 24"><path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Z"/><path d="M12 5v15"/></symbol>
<symbol id="i-doc" viewBox="0 0 24 24"><path d="M14 3H5v18h14V8Z"/><path d="M14 3v5h5M8 12h8M8 16h6"/></symbol>
<symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
<symbol id="i-upload" viewBox="0 0 24 24"><path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/></symbol>
<symbol id="i-chat" viewBox="0 0 24 24"><path d="M21 11a8 8 0 0 1-8 8H6l-4 3V11a9 9 0 0 1 19 0Z"/><path d="M7 9h9M7 13h6"/></symbol>
<symbol id="i-history" viewBox="0 0 24 24"><path d="M3 11a9 9 0 1 1 2.5 7M3 4v7h7M12 7v5l3 2"/></symbol>
<symbol id="i-arrow" viewBox="0 0 24 24"><path d="M12 19V5m-5 5 5-5 5 5"/></symbol>
<symbol id="i-spark" viewBox="0 0 24 24"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4m-2-2h4"/></symbol>
<symbol id="i-tree" viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="5" rx="1"/><path d="M12 7v5M5 16v-4h14v4"/><rect x="2" y="16" width="6" height="5" rx="1"/><rect x="16" y="16" width="6" height="5" rx="1"/></symbol>
<symbol id="i-link" viewBox="0 0 24 24"><path d="m10 14 4-4m-6 6-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 12a4 4 0 0 0 6 0l5-5a4 4 0 0 0-6-6l-1 1" transform="translate(1 0) scale(.9)"/></symbol>
<symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></symbol>
<symbol id="i-close" viewBox="0 0 24 24"><path d="m6 6 12 12M6 18 18 6"/></symbol>
<symbol id="i-trash" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></symbol>
<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2 7M20 4v7h-7"/></symbol>
<symbol id="i-search" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></symbol>
<symbol id="i-list" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.1M3 12h.1M3 18h.1"/></symbol>
<symbol id="i-stars" viewBox="0 0 24 24"><path d="m12 4 2 6 6 2-6 2-2 6-2-6-6-2 6-2ZM20 2v4m-2-2h4M4 18v4m-2-2h4"/></symbol>
</defs></svg>
<div class="app">
<header class="topbar">
  <a class="brand" href="#workspace" aria-label="PageIndex 首页"><span class="brand-mark"><svg viewBox="0 0 24 28" aria-hidden="true"><path d="m12 1 10 6v14l-10 6L2 21V7Z" fill="#d8ddcf18" stroke="#dce4d59c"/><path d="m12 5 6 4v9l-6 4-6-4V9Z" fill="none" stroke="#decba0" stroke-width="1.2"/><path d="M12 5v17M6 9l12 9M18 9 6 18" stroke="#dce4d580" stroke-width=".7"/></svg></span><span><span class="brand-name">Page<span>Index</span></span><span class="brand-sub" style="display:block">KNOWLEDGE STUDIO</span></span></a>
  <nav class="top-nav" aria-label="主导航"><button class="nav-tab active" id="navWorkspace" data-route="workspace" aria-current="page"><svg class="icon" aria-hidden="true"><use href="#i-grid"/></svg>知识工作台 <small>WORKSPACE</small></button><button class="nav-tab" id="navKnowledge" data-route="knowledge"><svg class="icon" aria-hidden="true"><use href="#i-book"/></svg>知识库 <small>LIBRARIES</small></button><button class="nav-tab" id="navModels" data-route="models"><svg class="icon" aria-hidden="true"><use href="#i-spark"/></svg>模型 <small>MODELS</small></button></nav>
  <div class="top-meta"><span>让每一页知识，都有迹可循</span><span class="local-status"><i class="status-dot"></i>本地运行</span><span class="avatar" aria-hidden="true">PI</span></div>
</header>
<aside class="sidebar" id="sidebar" aria-label="知识库与文档">
  <div class="sidebar-intro"><div class="eyebrow">YOUR KNOWLEDGE, CONNECTED</div><h1>我的知识空间</h1><p>汇集文档，连接想法，找到答案。</p></div>
  <section class="sb-block"><h2>知识库 <span class="section-en">LIBRARIES</span><button class="add" onclick="createKB()" title="新建知识库" aria-label="新建知识库"><svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg></button></h2><div class="kb-list" id="kbList"><div class="empty-hint">正在加载知识库…</div></div></section>
  <section class="sb-block" id="docBlock" style="display:none">
    <h2>知识文档 <span class="section-en">DOCUMENTS</span><span class="section-count" id="docCount">0</span></h2>
    <div class="doc-list" id="docList"></div>
    <div class="upload-row"><input type="file" id="fileInput" accept=".pdf,.docx,.doc,.md,.markdown" multiple aria-label="选择上传文档"><button class="upload-button" id="uploadBtn" disabled><svg class="icon" aria-hidden="true"><use href="#i-upload"/></svg><span>添加文档</span></button><p class="upload-caption">支持 PDF / Word / Markdown · 可多选</p>
    <div class="workspace-model"><label for="chatModelSelect">对话模型</label><select id="chatModelSelect" aria-label="选择对话模型"><option value="environment">环境默认</option></select><a href="#models">管理模型 <span>↗</span></a></div></div>
  </section>
  <div class="sidebar-foot"><span class="local-status"><i class="status-dot"></i>知识，从这里生长</span><span>PAGE / INDEX</span></div>
</aside>
<main class="main">
  <div class="chat-header"><button class="btn-ghost mobile-only" onclick="toggleSidebar()" aria-label="打开知识库侧栏" aria-controls="sidebar" aria-expanded="false" id="sidebarToggle"><svg class="icon" aria-hidden="true"><use href="#i-menu"/></svg></button><div class="header-title"><svg class="icon" aria-hidden="true"><use href="#i-chat"/></svg><span>文档问答</span><i class="header-divider"></i><span id="kbLabel" class="no-kb">选择知识库开始</span></div><span class="spacer"></span><span class="header-state"><i class="status-dot"></i><span id="headerState">等待连接知识</span></span><button class="btn" id="newConvBtn" onclick="newConv()" disabled><svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg>新对话</button><button class="btn-ghost" id="toggleHistBtn" title="对话历史" aria-label="展开对话历史" aria-controls="histPanel" aria-expanded="false" onclick="toggleHistory()" disabled><svg class="icon" aria-hidden="true"><use href="#i-history"/></svg></button></div>
  <div class="chat-msgs" id="chatMsgs" role="region" aria-label="问答内容"></div>
  <div class="chat-input"><div class="composer"><textarea id="chatInput" rows="1" aria-label="输入问题" placeholder="选择知识库，让答案从文档中浮现…" disabled></textarea><div class="composer-bottom"><span class="composer-source" id="composerSource"><svg class="icon" aria-hidden="true"><use href="#i-book"/></svg>基于你的文档，寻找有据可循的答案</span><span class="spacer"></span><span class="shortcut">Enter 发送 · Shift + Enter 换行</span><button class="btn btn-primary send-btn" id="sendBtn" title="发送问题" aria-label="发送问题" disabled><svg class="icon" aria-hidden="true"><use href="#i-arrow"/></svg></button></div></div><div class="input-footnote"><span>答案由模型生成，请结合引用文档核实。</span><span>POWERED BY PAGEINDEX</span></div></div>
</main>
<section class="knowledge-page" id="knowledgePage" aria-label="知识库" hidden>
  <div class="library-shell" id="libraryHome">
    <header class="library-heading"><div><p class="eyebrow">A UNIVERSE OF YOUR KNOWLEDGE</p><h1>让知识，汇聚成星。</h1><p class="library-subtitle">每一份积累，都在连接更大的世界。</p></div><button class="btn btn-primary" onclick="createKB()"><svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg>新建知识库</button></header>
    <div class="library-stats" id="libraryStats" aria-live="polite"></div>
    <div class="library-toolbar"><label class="library-search"><svg class="icon" aria-hidden="true"><use href="#i-search"/></svg><input id="librarySearch" type="search" placeholder="搜索知识库…" aria-label="搜索知识库" autocomplete="off"></label><span class="spacer"></span><span class="view-label">观察你的知识</span><div class="view-switch" role="group" aria-label="知识库显示样式"><button id="viewList" data-view="list" aria-pressed="false"><svg class="icon" aria-hidden="true"><use href="#i-list"/></svg>列表</button><button class="active" id="viewGalaxy" data-view="galaxy" aria-pressed="true"><svg class="icon" aria-hidden="true"><use href="#i-stars"/></svg>星团</button></div></div>
    <div id="libraryContent" aria-busy="true"><div class="library-empty">正在连接你的知识空间…</div></div>
    <div class="library-bottom"><span><i class="status-dot"></i>知识相连，灵感生长</span><button class="relation-toggle" id="relationToggle" aria-expanded="false" aria-controls="relationPanel">查看关联依据 <span>↗</span></button></div>
    <section class="relation-panel" id="relationPanel" aria-label="知识库关联依据" hidden></section>
  </div>
  <div class="library-shell detail-shell" id="libraryDetail" hidden></div>
</section>
<section class="models-page" id="modelsPage" aria-label="模型管理" hidden>
  <div class="library-shell models-shell"><header class="library-heading"><div><p class="eyebrow">INTELLIGENCE, YOUR WAY</p><h1>为知识，选择引擎。</h1><p class="library-subtitle">连接你的模型，让每一次探索都有合适的力量。</p></div><button class="btn btn-primary" id="addModelBtn"><svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg>添加服务</button></header>
  <div class="model-overview" id="modelOverview"></div>
  <div class="library-toolbar model-toolbar"><label class="library-search"><svg class="icon" aria-hidden="true"><use href="#i-search"/></svg><input type="search" id="modelSearch" placeholder="搜索服务、模型或地址…" aria-label="搜索模型"></label><span class="spacer"></span><div class="view-switch" id="modelFilters" role="group" aria-label="模型用途筛选"><button class="active" data-model-kind="all" aria-pressed="true">全部模型</button><button data-model-kind="chat" aria-pressed="false">对话</button><button data-model-kind="embedding" aria-pressed="false">向量</button></div></div>
  <div class="model-grid provider-grid" id="modelGrid" aria-live="polite"></div><p class="model-page-note"><svg class="icon" aria-hidden="true"><use href="#i-link"/></svg>同一服务的多个模型共用 Base URL 和 API Key。对话、索引与摘要可分别指定模型；向量模型用于向量和混合检索，视觉模型用于扫描页面识别。</p>
  </div>
</section>
<aside class="history-panel" id="histPanel" aria-label="对话历史" inert><div class="history-inner"><div class="h-head"><h2>对话历史 <small>CONVERSATIONS</small></h2><button class="btn-ghost" onclick="toggleHistory()" aria-label="关闭对话历史"><svg class="icon" aria-hidden="true"><use href="#i-close"/></svg></button></div><div class="h-list" id="histList"><div class="empty-hint">暂无对话</div></div></div></aside>
</div>
<button class="backdrop" id="backdrop" aria-label="关闭侧栏" onclick="closePanels()" tabindex="-1"></button>
<div class="toast" id="toast" role="status" hidden></div>
<template id="welcomeTemplate">
<div class="placeholder" id="placeholder">
  <div class="knowledge-orb" aria-hidden="true"><div class="orb-glow"></div><svg class="orb-lines" viewBox="0 0 235 160"><ellipse cx="117" cy="82" rx="110" ry="31" transform="rotate(-18 117 82)"/><ellipse cx="117" cy="82" rx="91" ry="44" transform="rotate(23 117 82)"/><path d="M16 103 81 55 157 117 219 60M39 37 103 99 194 129"/><path class="gold-line" d="M16 103 117 82 194 129M81 55 219 60"/><circle cx="16" cy="103" r="2.5"/><circle cx="39" cy="37" r="2"/><circle cx="219" cy="60" r="3"/><circle cx="194" cy="129" r="2" class="gold-dot"/><circle cx="81" cy="55" r="1.5" class="gold-dot"/><circle cx="157" cy="117" r="1.5"/></svg><div class="orb-core"></div><span class="orbit-label first">DOCUMENTS</span><span class="orbit-label second">INSIGHTS</span><span class="orb-dot"></span></div>
  <div class="welcome-eyebrow">A LITTLE CURIOSITY. A WORLD OF KNOWLEDGE.</div><h2>让知识连接，<br>让答案浮现。</h2><p class="welcome-desc" id="welcomeDesc">从一份文档，到一个清晰的答案。<br>选择左侧知识库，开启你的探索。</p>
  <div class="feature-strip"><span><svg class="icon" aria-hidden="true"><use href="#i-tree"/></svg>理解文档结构</span><span><svg class="icon" aria-hidden="true"><use href="#i-spark"/></svg>推理式检索</span><span><svg class="icon" aria-hidden="true"><use href="#i-link"/></svg>追溯引用来源</span></div>
  <div class="suggestion-grid"><button class="suggestion" data-question="请总结知识库文档的核心内容。"><svg class="icon" aria-hidden="true"><use href="#i-doc"/></svg><span>总结文档的核心内容</span><span class="arrow">↗</span></button><button class="suggestion" data-question="请梳理文档中的关键概念及其关系。"><svg class="icon" aria-hidden="true"><use href="#i-tree"/></svg><span>梳理关键概念与关系</span><span class="arrow">↗</span></button><button class="suggestion" data-question="这些文档有哪些共同主题和不同观点？"><svg class="icon" aria-hidden="true"><use href="#i-link"/></svg><span>比较文档中的不同观点</span><span class="arrow">↗</span></button><button class="suggestion" data-question="请找出文档中的重要结论，并给出出处。"><svg class="icon" aria-hidden="true"><use href="#i-spark"/></svg><span>寻找重要结论与出处</span><span class="arrow">↗</span></button></div><p class="welcome-hint">一个好问题，是发现的开始。</p>
</div>
</template>
<script>
let activeKbId=null,activeKbName='',activeConvId=null,knowledgeBases=[],conversations=[],sending=false,uploading=false,toastTimer;
const $=id=>document.getElementById(id);
const icon=name=>`<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
function esc(s){const d=document.createElement('div');d.textContent=String(s??'');return d.innerHTML.replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function toast(text){clearTimeout(toastTimer);$('toast').textContent=text;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,4000)}
async function request(url,options){const r=await fetch(url,options);const d=await r.json();if(!r.ok)throw new Error(typeof d.detail==='string'?d.detail:'操作失败，请重试');return d}
function showWelcome(){const view=$('welcomeTemplate').content.cloneNode(true);if(activeKbId)view.querySelector('#welcomeDesc').innerHTML=`已连接 <strong>${esc(activeKbName)}</strong>。<br>从一个问题出发，发现文档之间的联系。`;$('chatMsgs').replaceChildren(view)}
function syncSelection(){const selected=!!activeKbId;$('docBlock').style.display=selected?'':'none';$('kbLabel').className=selected?'kb-badge':'no-kb';$('kbLabel').textContent=selected?activeKbName:'选择知识库开始';$('chatInput').disabled=!selected||sending;$('sendBtn').disabled=!selected||sending;$('uploadBtn').disabled=!selected||uploading;$('newConvBtn').disabled=!selected||sending;$('toggleHistBtn').disabled=!selected;$('headerState').textContent=sending?'正在检索文档':selected?'知识库已连接':'等待连接知识';$('chatInput').placeholder=selected?'向知识库提问，探索你的文档…':'选择知识库，让答案从文档中浮现…';$('composerSource').innerHTML=icon('book')+esc(selected?activeKbName:'基于你的文档，寻找有据可循的答案')}
async function loadKBs(refreshKnowledge=true){try{const d=await request('/api/kb');knowledgeBases=d.knowledge_bases||[];$('kbList').innerHTML=knowledgeBases.length?knowledgeBases.map(k=>`<div class="kb-item${k.kb_id===activeKbId?' active':''}"><button class="kb-select" data-select-kb="${esc(k.kb_id)}" aria-pressed="${k.kb_id===activeKbId}">${icon('book')}<span class="name">${esc(k.name)}</span><span class="meta">${k.doc_count} 文档</span></button><button class="del" data-delete-kb="${esc(k.kb_id)}" aria-label="删除知识库 ${esc(k.name)}" title="删除知识库">×</button></div>`).join(''):'<div class="empty-hint">还没有知识库<br>点击 + 创建你的知识空间</div>';if(refreshKnowledge)window.Knowledge?.refresh();}catch(e){$('kbList').innerHTML='<div class="empty-hint">知识库加载失败<br>请刷新页面重试</div>';toast(e.message)}}
$('kbList').addEventListener('click',e=>{const select=e.target.closest('[data-select-kb]'),del=e.target.closest('[data-delete-kb]');if(select){if(sending)return toast('请等待当前回答完成');const kb=knowledgeBases.find(k=>k.kb_id===select.dataset.selectKb);if(kb)selectKB(kb.kb_id,kb.name)}else if(del)deleteKB(del.dataset.deleteKb)});
async function createKB(){if(sending)return;const name=prompt('知识库名称：','我的知识库');if(!name?.trim())return;try{const kb=await request('/api/kb',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name.trim()})});await loadKBs();if(window.Knowledge?.isOpen())window.Knowledge.open(kb.kb_id);else selectKB(kb.kb_id,kb.name)}catch(e){toast(e.message)}}
async function deleteKB(kid){return window.Knowledge.remove(kid)}
function selectKB(kid,name,navigate=true){if(uploading)return toast('请等待文档上传完成');activeKbId=kid;activeKbName=name;activeConvId=null;syncSelection();showWelcome();loadKBs();loadDocs();loadConversations();closePanels();if(navigate)window.Knowledge?.navigate('workspace');window.Studio?.syncKB();if(navigate&&!window.matchMedia('(max-width:800px)').matches)$('chatInput').focus()}
async function loadDocs(){if(!activeKbId)return;const kid=activeKbId;$('docList').innerHTML='<div class="empty-hint">正在加载文档…</div>';try{const d=await request('/api/kb/'+encodeURIComponent(kid)+'/docs');if(activeKbId!==kid)return;$('docCount').textContent=String(d.docs.length);$('docList').innerHTML=d.docs.length?d.docs.map(doc=>`<div class="doc-item"><span class="file-mark">${icon('doc')}</span><button class="doc-info doc-read-button" data-read-doc="${esc(doc.doc_id)}" aria-label="阅读 ${esc(doc.doc_name)}"><div class="name" title="${esc(doc.doc_name)}">${esc(doc.doc_name)}</div><div class="meta">${doc.page_count?doc.page_count+' 页 · ':''}已索引</div></button><button class="del" data-delete-doc="${esc(doc.doc_id)}" aria-label="删除文档 ${esc(doc.doc_name)}" title="删除文档">×</button></div>`).join(''):'<div class="empty-hint">还没有文档<br>添加文档，开始积累知识</div>'}catch(e){$('docList').innerHTML='<div class="empty-hint">文档加载失败</div>';toast(e.message)}}
$('docList').addEventListener('click',e=>{const b=e.target.closest('[data-delete-doc]'),read=e.target.closest('[data-read-doc]');if(b)deleteDoc(b.dataset.deleteDoc);else if(read)window.Studio.openReader(activeKbId,read.dataset.readDoc)});
async function deleteDoc(did){return window.Knowledge.remove(activeKbId,did)}
$('uploadBtn').addEventListener('click',()=>$('fileInput').click());
$('fileInput').addEventListener('change',e=>{const files=Array.from(e.target.files);e.target.value='';if(files.length)window.Studio.prepareUpload(files,activeKbId)});
async function loadConversations(){try{const d=await request('/api/conversations');conversations=(d.conversations||[]).filter(c=>c.kb_id===activeKbId);$('histList').innerHTML=conversations.length?conversations.map(c=>`<div class="h-item${c.conv_id===activeConvId?' active':''}"><button class="h-select" data-conv="${esc(c.conv_id)}"><div class="title">${esc(c.title)}</div><div class="time">${esc((c.created_at||'').slice(0,16).replace('T',' '))} · ${c.msg_count} 条消息</div></button><button class="del" data-delete-conv="${esc(c.conv_id)}" aria-label="删除对话 ${esc(c.title)}">×</button></div>`).join(''):'<div class="empty-hint">还没有对话记录<br>你的探索会保存在这里</div>'}catch(e){toast(e.message)}}
$('histList').addEventListener('click',e=>{const select=e.target.closest('[data-conv]'),del=e.target.closest('[data-delete-conv]');if(select)switchConv(select.dataset.conv);else if(del)deleteConv(del.dataset.deleteConv)});
async function newConv(){if(!activeKbId||sending)return;try{const c=await request('/api/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kb_id:activeKbId})});activeConvId=c.conv_id;showWelcome();loadConversations();closePanels();$('chatInput').focus()}catch(e){toast(e.message)}}
async function deleteConv(cid){if(sending)return;try{await request('/api/conversations/'+encodeURIComponent(cid),{method:'DELETE'});if(activeConvId===cid){activeConvId=null;showWelcome()}loadConversations()}catch(e){toast(e.message)}}
async function switchConv(cid){if(sending)return;try{const c=await request('/api/conversations/'+encodeURIComponent(cid));activeConvId=cid;const kb=knowledgeBases.find(k=>k.kb_id===c.kb_id);if(kb&&kb.kb_id!==activeKbId){activeKbId=kb.kb_id;activeKbName=kb.name;syncSelection();loadKBs();loadDocs()}if(c.messages?.length){$('chatMsgs').replaceChildren();c.messages.forEach(m=>addMsg(m.role,m.content,m.refs,m.reasoning,m))}else showWelcome();loadConversations();closePanels()}catch(e){toast(e.message)}}
$('chatMsgs').addEventListener('click',e=>{const b=e.target.closest('[data-question]');if(!b)return;if(!activeKbId){toast('先选择一个知识库，再开始探索');if(window.matchMedia('(max-width:800px)').matches)toggleSidebar();return}$('chatInput').value=b.dataset.question;resizeInput();$('chatInput').focus()});
$('chatInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();sendMsg()}});
function resizeInput(){$('chatInput').style.height='auto';$('chatInput').style.height=Math.min($('chatInput').scrollHeight,150)+'px'}
$('chatInput').addEventListener('input',resizeInput);$('sendBtn').addEventListener('click',sendMsg);
async function sendMsg(){return window.Studio.send()}
function messageBody(text,refs,reasoning,meta={}){return window.Studio.renderAnswer(text,refs,meta.steps||[],meta.usage||null,meta.status||'completed',reasoning,meta.model_input||null)}
function addMsg(role,text,refs,reasoning,meta={}){const id='m'+Date.now()+Math.random().toString(36).slice(2,6),d=document.createElement('div');d.className='msg '+(role==='user'?'user':'assistant');d.id=id;d.innerHTML='<div class="msg-label">'+(role==='user'?'你':icon('spark')+'PageIndex')+'</div><div class="msg-content">'+messageBody(text,refs,reasoning,meta)+'</div>';$('chatMsgs').appendChild(d);$('chatMsgs').scrollTop=$('chatMsgs').scrollHeight;return id}
function updMsg(id,text,refs,reasoning){const el=document.getElementById(id);if(!el)return;el.querySelector('.msg-content').innerHTML=messageBody(text,refs,reasoning);$('chatMsgs').scrollTop=$('chatMsgs').scrollHeight}
function syncPanels(){const side=$('sidebar').classList.contains('open'),hist=$('histPanel').classList.contains('open');$('sidebarToggle').setAttribute('aria-expanded',String(side));$('toggleHistBtn').setAttribute('aria-expanded',String(hist));$('toggleHistBtn').setAttribute('aria-label',hist?'收起对话历史':'展开对话历史');$('histPanel').inert=!hist;$('sidebar').inert=window.matchMedia('(max-width:800px)').matches&&!side;$('backdrop').classList.toggle('visible',window.matchMedia('(max-width:800px)').matches&&(side||hist))}
function toggleHistory(){$('sidebar').classList.remove('open');$('histPanel').classList.toggle('open');syncPanels()}
function toggleSidebar(){$('histPanel').classList.remove('open');$('sidebar').classList.toggle('open');syncPanels()}
function closePanels(){$('histPanel').classList.remove('open');$('sidebar').classList.remove('open');syncPanels()}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closePanels()});window.matchMedia('(max-width:800px)').addEventListener('change',syncPanels);
showWelcome();syncSelection();syncPanels();loadKBs();
</script>
<script src="/static/neural-scene.js"></script>
<script src="/static/knowledge.js"></script>
<script src="/static/models.js"></script>
<script src="/static/studio.js"></script>
</body>
</html>
"""

# Flash 的 PDF 解析子进程会重新导入入口，不在子进程恢复或改写主服务的任务状态。
if __name__ != '__mp_main__':
    studio = register_studio(app, sys.modules[__name__])

if __name__=="__main__":
    p=argparse.ArgumentParser(); p.add_argument("--port",type=int,default=8080); p.add_argument("--host",default="127.0.0.1")
    args=p.parse_args()
    uvicorn.run(app,host=args.host,port=args.port)
