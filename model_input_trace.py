"""问答模型输入快照：独立保存正文，历史消息仅保留关联与概要。"""
import copy
import threading
import time
import uuid
from pathlib import Path


TRACE_DIR = Path('model-input-traces')
_TRACE_LOCK = threading.RLock()


class ModelInputTrace:
    def __init__(self, conv_id, mode, emit, stop):
        self.emit, self.stop = emit, stop
        self.stage = 'retrieval'
        self.started = {}
        self.data = {'version': 1, 'id': uuid.uuid4().hex, 'conv_id': conv_id, 'retrieval_mode': mode,
                     'created_at': time.time(), 'status': 'running', 'calls': [], 'context': None}

    def summary(self):
        context = self.data.get('context') or {}
        return {'trace_id': self.data['id'], 'conv_id': self.data['conv_id'], 'retrieval_mode': self.data['retrieval_mode'], 'call_count': len(self.data['calls']),
                'context_chars': context.get('sent_chars', 0), 'truncated': context.get('truncated', False),
                'status': self.data['status']}

    def observe(self, action, value, detail):
        if action == 'start':
            if self.stop.is_set():
                raise InterruptedError('已停止生成')
            call = {'id': uuid.uuid4().hex[:12], 'sequence': len(self.data['calls']) + 1,
                    'stage': detail['stage'] or self.stage, 'transport': detail['transport'], 'request': value,
                    'created_at': time.time(), 'status': 'calling', 'duration_ms': None}
            self.started[call['id']] = time.perf_counter()
            self.data['calls'].append(call)
            self.emit({'type': 'model_input', 'trace': self.summary(), 'call': copy.deepcopy(call)})
            return call
        value.update(status=detail, duration_ms=round((time.perf_counter() - self.started.pop(value['id'])) * 1000))
        self.emit({'type': 'model_input_status', 'trace_id': self.data['id'], 'call_id': value['id'],
                   'status': value['status'], 'duration_ms': value['duration_ms']})

    def set_context(self, context):
        self.data['context'] = context
        self.emit({'type': 'retrieval_context', 'trace': self.summary(), 'context': context})

    def save(self, status, atomic_json):
        self.data.update(status=status, finished_at=time.time())
        with _TRACE_LOCK:
            TRACE_DIR.mkdir(mode=0o700, exist_ok=True)
            atomic_json(TRACE_DIR / (self.data['id'] + '.json'), self.data)


def remove_traces(messages):
    with _TRACE_LOCK:
        for message in messages:
            tid = (message.get('model_input') or {}).get('trace_id', '')
            if len(tid) == 32 and all(c in '0123456789abcdef' for c in tid):
                (TRACE_DIR / (tid + '.json')).unlink(missing_ok=True)
