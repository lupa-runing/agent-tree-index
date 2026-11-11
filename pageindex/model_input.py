"""按请求观察应用提交给模型 SDK 的输入，不采集连接凭据。"""
import copy
from contextlib import contextmanager
from contextvars import ContextVar


model_input_observer = ContextVar('pageindex_model_input_observer', default=None)
_INPUT_FIELDS = {'model', 'messages', 'input', 'stream', 'stream_options', 'temperature',
                 'max_tokens', 'max_completion_tokens', 'reasoning_effort', 'thinking',
                 'encoding_format', 'response_format', 'drop_params', 'max_retries'}


@contextmanager
def observed_model_call(params, transport, stage=None):
    observer = model_input_observer.get()
    call = observer('start', copy.deepcopy({k: v for k, v in params.items() if k in _INPUT_FIELDS}), {'transport': transport, 'stage': stage}) if observer else None
    try:
        yield
    except BaseException:
        if observer:
            observer('finish', call, 'failed')
        raise
    else:
        if observer:
            observer('finish', call, 'returned')
