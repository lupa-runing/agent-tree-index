# PageIndex 项目规则

## 持久化原则（最重要）

- **绝对禁止**删除 `results/` 和 `uploads/` 目录中的任何文件
- 每次修改代码后重启服务器，**只执行 `kill` 进程 + 重新启动**，不要 `rm -rf results/*`
- `results/` 中存的是用户索引过的文档（含对话历史），`uploads/` 中存的是原始 PDF/Markdown 文件
- 服务启动时 `load_existing_docs()` 会自动从 `results/*.json` 恢复所有文档和对话

## 语言

- **始终用中文回复用户**，不要用英文

## 项目结构

- `web_app.py` — FastAPI Web 服务（索引 + 对话检索 + 历史记录）
- `pageindex/` — PageIndex 核心库
- `run_pageindex.py` — CLI 入口
- `requirements.txt` — Python 依赖
- 虚拟环境：`.venv/`（uv 管理，Python 3.11）

## 重启服务命令

```bash
lsof -ti:8080 | xargs kill -9 2>/dev/null; sleep 1
/Users/outside/project/pageIndex/.venv/bin/python /Users/outside/project/pageIndex/web_app.py --port 8080 &
```

**不要**在重启前执行 `rm -rf results/*` 或 `rm -rf uploads/*`。

## 数据持久化架构

- `store.json` — 知识库 + 文档索引 + 会话历史（单一持久化文件）
- `uploads/` — 原始上传的 PDF/Markdown 文件
- 上传文档时，`page_count` 从 `pymupdf.page_count` 获取（`page_index_main` 不返回此字段）
- 上传时自动预提取每页文本存到 `page_texts`（pymupdf 提取，< 50 字符的页面触发视觉 OCR）

## 视觉模型配置

- 在 `.env` 中设置：`VISION_API_KEY`, `VISION_BASE_URL`, `VISION_MODEL_NAME`
- 使用 OpenAI 兼容协议的视觉模型 API（⚠️ DeepSeek API 不支持 vision/image_url）
- 视觉 OCR 在上传时自动触发（pymupdf 文本 < 50 字符的页面），结果缓存到 `page_texts`
- 检索时优先用缓存的 `page_texts`，不再重复调用视觉 API
- 页面已配置 `Cache-Control: no-cache`，浏览器不会缓存旧 HTML
