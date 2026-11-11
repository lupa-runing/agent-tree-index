"""旧导入路径兼容入口；新代码请使用 pageindex.page_index_classic。"""
import warnings as _warnings
from .page_index_classic import *
from . import page_index_classic as _classic

_warnings.warn('pageindex.page_index 已弃用，请改用 pageindex.page_index_classic',
               DeprecationWarning, stacklevel=2)


def __getattr__(name):
    return getattr(_classic, name)
