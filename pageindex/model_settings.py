"""本地模型配置与单次调用上下文，不更改 CLI 的环境变量行为。"""
import json
import os
import tempfile
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from threading import RLock
from urllib.parse import urlsplit


_active_model = ContextVar('pageindex_active_model', default=None)


@contextmanager
def model_context(config):
    from .utils import _llm_backend
    token = _active_model.set(config)
    backend_token = _llm_backend.set(completion_options(config['model']) if config else None)
    try:
        yield
    finally:
        _llm_backend.reset(backend_token)
        _active_model.reset(token)


def completion_options(model):
    config = _active_model.get()
    if config:
        return {'model': 'openai/' + config['model'], 'api_base': config['base_url'],
                'api_key': config['api_key'] or 'not-required'}
    return {'model': model.removeprefix('litellm/') if model else model}


class ModelRegistry:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = RLock()

    def _read(self):
        if not self.path.exists():
            return {'version': 2, 'providers': [], 'models': [], 'defaults': {'chat': None, 'embedding': None}}
        try:
            data = json.loads(self.path.read_text(encoding='utf-8'))
        except (OSError, ValueError) as exc:
            raise ValueError('模型配置文件读取失败，请检查本地 models.json') from exc
        if 'providers' not in data:
            # 兼容旧的单模型连接配置：仅合并地址、协议、密钥完全一致的连接，保留模型 ID 和默认项。
            providers, models, known = [], [], {}
            for old in data.get('models', []):
                connection = (old.get('protocol', 'openai-compatible'), old['base_url'].rstrip('/'), old.get('api_key', ''))
                if connection not in known:
                    pid = 'svc_' + old['id']
                    known[connection] = pid
                    providers.append({'id': pid, 'name': old['name'], 'protocol': connection[0],
                                      'base_url': connection[1], 'api_key': connection[2]})
                models.append({**{key: old[key] for key in ('id', 'name', 'kind', 'model')}, 'provider_id': known[connection]})
            data = {'version': 2, 'providers': providers, 'models': models,
                    'defaults': data.get('defaults', {'chat': None, 'embedding': None})}
            self._write(data)
        return data

    def _write(self, data):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.path.parent, prefix='.models-', suffix='.tmp', delete=False) as f:
            tmp = Path(f.name)
            try:
                json.dump(data, f, ensure_ascii=False, indent=2)
                f.flush()
                os.fsync(f.fileno())
            except Exception:
                tmp.unlink(missing_ok=True)
                raise
        try:
            tmp.replace(self.path)
        finally:
            tmp.unlink(missing_ok=True)

    @staticmethod
    def _find(data, item_id, collection='models'):
        item = next((m for m in data[collection] if m['id'] == item_id), None)
        if item is None:
            raise KeyError('服务或模型配置不存在')
        return item

    @staticmethod
    def public(item):
        return {**{k: v for k, v in item.items() if k != 'api_key'}, 'has_key': bool(item.get('api_key'))}

    def _resolved(self, data, model):
        provider = self._find(data, model['provider_id'], 'providers')
        return {**model, 'provider_name': provider['name'],
                **{key: provider[key] for key in ('base_url', 'api_key', 'protocol')}}

    @staticmethod
    def _fields(body, previous, fields):
        result = {}
        for field, limit in fields:
            value = body.get(field, (previous or {}).get(field, ''))
            if not isinstance(value, str):
                raise ValueError(f'{field} 必须是字符串')
            value = value.strip()
            if len(value) > limit:
                raise ValueError(f'{field} 长度超出限制')
            result[field] = value
        return result

    def _validate_provider(self, body, previous=None):
        result = self._fields(body, previous, [('name', 80), ('base_url', 2000), ('api_key', 16384)])
        if not result['name']:
            raise ValueError('请填写服务名称')
        try:
            url = urlsplit(result['base_url'])
            valid = url.scheme in {'http', 'https'} and url.hostname and not (url.username or url.password or url.query or url.fragment)
            url.port
        except ValueError:
            valid = False
        if not valid:
            raise ValueError('base_url 必须是有效的 HTTP(S) 服务根地址，不含用户名、密码、查询参数或片段')
        if body.get('protocol', 'openai-compatible') != 'openai-compatible':
            raise ValueError('当前仅支持 OpenAI-compatible 协议')
        return {**result, 'base_url': result['base_url'].rstrip('/'), 'protocol': 'openai-compatible'}

    def _save_model(self, data, body, model_id=None):
        old = self._find(data, model_id) if model_id is not None else None
        values = self._fields(body, old, [('name', 80), ('kind', 20), ('model', 200)])
        if not values['model']:
            raise ValueError('请填写模型标识')
        values['name'] = values['name'] or values['model'][:80]
        if values['kind'] not in {'chat', 'embedding', 'vision'}:
            raise ValueError('模型用途必须为对话、向量或视觉')
        pid = body.get('provider_id', old['provider_id'] if old else None)
        if pid:
            provider = self._find(data, pid, 'providers')
            # 兼容旧模型更新入口；共享连接字段的更新同步到该服务下所有模型。
            connection = {key: body[key] for key in ('base_url', 'api_key', 'protocol') if key in body}
            if connection:
                provider.update(self._validate_provider(connection, provider))
        else:
            connection = self._validate_provider({**body, 'name': body.get('provider_name') or values['name']})
            provider = next((p for p in data['providers'] if all(p[key] == connection[key] for key in ('base_url', 'api_key', 'protocol'))), None)
            if provider is None:
                provider = {'id': uuid.uuid4().hex[:12], **connection}
                data['providers'].append(provider)
            pid = provider['id']
        model = {'id': model_id or uuid.uuid4().hex[:12], 'provider_id': pid, **values}
        others = [m for m in data['models'] if m['id'] != model['id']]
        identity = (pid, model['kind'], model['model'])
        if (old is None or identity != (old['provider_id'], old['kind'], old['model'])) and any((m['provider_id'], m['kind'], m['model']) == identity for m in others):
            raise ValueError('该服务下已存在相同用途和标识的模型')
        if old:
            data['models'][data['models'].index(old)] = model
            if old['kind'] != model['kind']:
                for role in ('index', 'summary', 'vision'):
                    if data['defaults'].get(role) == model_id:
                        data['defaults'][role] = None
            if old['kind'] != model['kind'] and data['defaults'].get(old['kind']) == model_id:
                data['defaults'][old['kind']] = next((m['id'] for m in others if m['kind'] == old['kind']), None)
        else:
            data['models'].append(model)
        if (old is None or old['kind'] != model['kind']) and not any(m['kind'] == model['kind'] for m in others) and not data['defaults'].get(model['kind']):
            data['defaults'][model['kind']] = model['id']
        return self.public(self._resolved(data, model))

    def list(self):
        with self.lock:
            data = self._read()
            providers = [{**self.public(p), 'model_count': sum(m['provider_id'] == p['id'] for m in data['models'])} for p in data['providers']]
            return {'providers': providers, 'models': [self.public(self._resolved(data, m)) for m in data['models']], 'defaults': data['defaults']}

    def get(self, model_id):
        with self.lock:
            data = self._read()
            return self._resolved(data, self._find(data, model_id))

    def get_provider(self, provider_id):
        with self.lock:
            return dict(self._find(self._read(), provider_id, 'providers'))

    def save_provider(self, body, provider_id=None):
        with self.lock:
            data = self._read()
            old = self._find(data, provider_id, 'providers') if provider_id is not None else None
            provider = {'id': provider_id or uuid.uuid4().hex[:12], **self._validate_provider(body, old)}
            if old:
                data['providers'][data['providers'].index(old)] = provider
            else:
                data['providers'].append(provider)
            if 'models' in body:
                self._add_models(data, provider['id'], body['models'])
            self._write(data)
            return self.public(provider)

    def _add_models(self, data, provider_id, items):
        self._find(data, provider_id, 'providers')
        if not isinstance(items, list) or not 1 <= len(items) <= 100 or not all(isinstance(item, dict) for item in items):
            raise ValueError('请提供 1–100 个模型配置')
        return [self._save_model(data, {**{key: item[key] for key in ('name', 'kind', 'model') if key in item}, 'provider_id': provider_id}) for item in items]

    def add_models(self, provider_id, items):
        with self.lock:
            data = self._read()
            models = self._add_models(data, provider_id, items)
            self._write(data)
            return {'models': models}

    def delete_provider(self, provider_id):
        with self.lock:
            data = self._read()
            provider = self._find(data, provider_id, 'providers')
            if any(m['provider_id'] == provider_id for m in data['models']):
                raise ValueError('请先删除该服务下的模型，再删除服务')
            data['providers'].remove(provider)
            self._write(data)
            return {'ok': True}

    def save(self, body, model_id=None):
        with self.lock:
            data = self._read()
            model = self._save_model(data, body, model_id)
            self._write(data)
            return model

    def delete(self, model_id):
        with self.lock:
            data = self._read()
            model = self._find(data, model_id)
            data['models'].remove(model)
            for role in ('index', 'summary', 'vision'):
                if data['defaults'].get(role) == model_id:
                    data['defaults'][role] = None
            if data['defaults'].get(model['kind']) == model_id:
                data['defaults'][model['kind']] = next((m['id'] for m in data['models'] if m['kind'] == model['kind']), None)
            self._write(data)
            return {'ok': True}

    def set_default(self, kind, model_id):
        if kind not in {'chat', 'embedding', 'index', 'summary', 'vision'}:
            raise ValueError('未知模型用途')
        with self.lock:
            data = self._read()
            expected = 'chat' if kind in {'index', 'summary'} else kind
            if model_id not in (None, 'environment') and self._find(data, model_id)['kind'] != expected:
                raise ValueError('模型用途不匹配')
            data['defaults'][kind] = model_id
            self._write(data)
            return {'defaults': data['defaults']}

    def resolve(self, model_id=None, kind='chat', legacy_model=None):
        if model_id == 'environment' or (model_id is None and legacy_model):
            return None
        with self.lock:
            data = self._read()
            selected = model_id if model_id is not None else data['defaults'].get(kind)
            if not selected and kind in {'index', 'summary'}:
                selected = data['defaults'].get('index') if kind == 'summary' else None
                selected = selected or data['defaults'].get('chat')
            if not selected:
                return None
            if selected == 'environment':
                return None
            model = self._resolved(data, self._find(data, selected))
            if model['kind'] != ('chat' if kind in {'index', 'summary'} else kind):
                raise ValueError('所选模型用途不匹配')
            return model
