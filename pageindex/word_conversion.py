"""本地 Word 转 PDF；保留原件，独立配置运行转换进程。"""
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

import pymupdf


WORD_SUFFIXES = {'.doc', '.docx'}


def find_soffice():
    configured = os.environ.get('PAGEINDEX_SOFFICE_PATH')
    candidates = [configured] if configured else [
        shutil.which('soffice'), shutil.which('libreoffice'),
        '/Applications/LibreOffice.app/Contents/MacOS/soffice',
        str(Path(os.environ.get('PROGRAMFILES', 'C:/Program Files')) / 'LibreOffice/program/soffice.exe'),
        str(Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/soffice'),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return str(Path(candidate).resolve())
    raise ValueError('Word 转换需要 LibreOffice。请安装 LibreOffice，或通过 PAGEINDEX_SOFFICE_PATH 配置 soffice 可执行文件路径，然后重试。')


def _check_word(path):
    if not path.is_file() or not path.stat().st_size:
        raise ValueError('Word 原始文件不存在或为空')
    with path.open('rb') as source:
        signature = source.read(8)
    if path.suffix.lower() == '.docx':
        if signature == b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1':
            raise ValueError('DOCX 文件可能已加密，请先在 Word 中取消密码保护后重新上传')
        try:
            with zipfile.ZipFile(path) as archive:
                if not {'[Content_Types].xml', 'word/document.xml'} <= set(archive.namelist()):
                    raise ValueError('文件不是有效的 DOCX 文档')
        except zipfile.BadZipFile:
            raise ValueError('DOCX 文件损坏或格式不正确，请用 Word 重新另存为 DOCX 后上传') from None
    elif path.suffix.lower() != '.doc' or not (signature == b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1' or signature.startswith(b'{\\rtf')):
        raise ValueError('文件不是有效的 DOC 文档，请用 Word 另存为 DOCX 后上传')


def _stop_process(process):
    if process.poll() is not None:
        return
    try:
        if os.name == 'posix':
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        if os.name == 'posix':
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
        process.wait(timeout=3)
    except ProcessLookupError:
        pass


def _font_environment(directory):
    env = os.environ.copy()
    if sys.platform == 'darwin' and not env.get('FONTCONFIG_FILE'):
        # 部分无界面构建只查找内置西文字体，需要显式启用 macOS 中文字体。
        config = directory / 'fonts.conf'
        fonts = [Path('/System/Library/Fonts'), Path('/Library/Fonts'), Path.home() / 'Library/Fonts']
        config.write_text('<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>'
                          + ''.join('<dir>' + escape(str(p)) + '</dir>' for p in fonts if p.is_dir())
                          + '<cachedir>' + escape(str(directory / 'font-cache')) + '</cachedir></fontconfig>', encoding='utf-8')
        env['FONTCONFIG_FILE'] = str(config)
    return env


def convert_word_to_pdf(source, destination, check_cancel=lambda: None, timeout=180):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    _check_word(source)
    executable = find_soffice()
    if destination.exists():
        raise ValueError('PDF 输出路径已存在，不能覆盖已有阅读文件')
    check_cancel()
    with tempfile.TemporaryDirectory(prefix='pageindex-word-') as directory:
        root = Path(directory)
        profile = root / 'profile'; profile.mkdir()
        # 不沿用用户桌面配置，也不允许文档中的宏执行。
        (profile / 'user').mkdir()
        (profile / 'user/registrymodifications.xcu').write_text(
            '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry">'
            '<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>', encoding='utf-8')
        input_path = root / ('source' + source.suffix.lower())
        shutil.copyfile(source, input_path)
        output = root / 'output'; output.mkdir()
        args = [executable, '-env:UserInstallation=' + profile.as_uri(), '--headless', '--nologo',
                '--nodefault', '--nofirststartwizard', '--norestore', '--convert-to', 'pdf:writer_pdf_Export',
                '--outdir', str(output), str(input_path)]
        with tempfile.TemporaryFile() as log:
            process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                       env=_font_environment(root), start_new_session=os.name == 'posix')
            try:
                deadline = time.monotonic() + timeout
                while process.poll() is None:
                    check_cancel()
                    if time.monotonic() >= deadline:
                        raise ValueError(f'Word 转 PDF 超时（{timeout:g} 秒），请检查文件是否受密码保护，或先拆分较大的文档')
                    time.sleep(.1)
                check_cancel()
                pdf_path = output / 'source.pdf'
                if process.returncode or not pdf_path.is_file():
                    raise ValueError('Word 转 PDF 失败，请确认文件未损坏、未加密且不受密码保护')
                try:
                    with pymupdf.open(pdf_path) as pdf:
                        if pdf.needs_pass or len(pdf) < 1:
                            raise ValueError('转换结果没有可解析的 PDF 页面')
                        pages = len(pdf)
                except (pymupdf.FileDataError, RuntimeError):
                    raise ValueError('转换结果不是有效 PDF，请用 Word 重新保存原件后重试') from None
                check_cancel()
                destination.parent.mkdir(parents=True, exist_ok=True)
                with destination.open('xb') as target, pdf_path.open('rb') as converted:
                    os.fchmod(target.fileno(), 0o600)
                    shutil.copyfileobj(converted, target)
                return {'engine': 'LibreOffice', 'converted_at': time.time(), 'page_count': pages}
            finally:
                _stop_process(process)
