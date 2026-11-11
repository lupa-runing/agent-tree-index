"""页面内容与表格结构；展示保留合并关系，检索展开完整的行列语义。"""
import csv
import io
import re
import threading
from html import escape
from html.parser import HTMLParser

import pymupdf


CONTENT_VERSION = 2
_TABLE_LOCK = threading.RLock()


def _edges(values):
    groups = []
    for value in sorted(values):
        if not groups or value - groups[-1][-1] > 1:
            groups.append([value])
        else:
            groups[-1].append(value)
    return [sum(g) / len(g) for g in groups]


def _header_rows(cells, rows):
    first = [c for c in cells if c['row'] == 0 and c['text'].strip()]
    numeric = sum(bool(re.fullmatch(r'[\d.,%+−-]+', c['text'].strip())) for c in first)
    if numeric >= max(2, len(first) / 2):
        return 0
    extent = max((c['rowspan'] for c in first), default=1)
    return min(extent, max(1, rows - 1), 6)


def expanded_grid(table):
    grid = [[''] * table['col_count'] for _ in range(table['row_count'])]
    for cell in table['cells']:
        for row in range(cell['row'], min(table['row_count'], cell['row'] + cell['rowspan'])):
            for col in range(cell['col'], min(table['col_count'], cell['col'] + cell['colspan'])):
                grid[row][col] = cell['text']
    return grid


def flat_rows(table):
    grid = expanded_grid(table)
    count = table['header_rows']
    headers = []
    for col in range(table['col_count']):
        values = []
        for row in range(count):
            text = ' '.join(grid[row][col].split())
            if text and text not in values:
                values.append(text)
        headers.append(' / '.join(values) or f'列 {col + 1}')
    return headers, grid[count:]


def table_html(table):
    rows = [[] for _ in range(table['row_count'])]
    for cell in table['cells']:
        rows[cell['row']].append(cell)
    html = ['<table>']
    header = table['header_rows']
    for row, cells in enumerate(rows):
        if row == 0 and header:
            html.append('<thead>')
        if row == header:
            if header:
                html.append('</thead>')
            html.append('<tbody>')
        html.append('<tr>')
        for cell in sorted(cells, key=lambda c: c['col']):
            tag = 'th' if row < header else 'td'
            span = (f' rowspan="{cell["rowspan"]}"' if cell['rowspan'] > 1 else '')
            span += f' colspan="{cell["colspan"]}"' if cell['colspan'] > 1 else ''
            scope = (' scope="colgroup"' if cell['colspan'] > 1 else ' scope="col"') if tag == 'th' else ''
            html.append(f'<{tag}{span}{scope}>' + escape(cell['text']).replace('\n', '<br>') + f'</{tag}>')
        html.append('</tr>')
    html.append(('</thead>' if header == len(rows) else '</tbody>') + '</table>')
    return '\n'.join(html)


def table_markdown(table, flatten=False):
    if not flatten and any(c['rowspan'] > 1 or c['colspan'] > 1 for c in table['cells']):
        return table_html(table)
    headers, rows = flat_rows(table)
    def line(values):
        return '| ' + ' | '.join(v.replace('\\', '\\\\').replace('|', r'\|').replace('\n', '<br>') for v in values) + ' |'
    return '\n'.join([line(headers), line(['---'] * len(headers)), *(line(row) for row in rows)])


def table_csv(table):
    headers, rows = flat_rows(table)
    output = io.StringIO(newline='')
    writer = csv.writer(output)
    for row in [headers, *rows]:
        # 在 Excel 中打开文档提供的数据时，将公式式文本作为字面量，保留普通负数。
        writer.writerow(["'" + value if re.match(r'^[=+@-]', value.lstrip()) and not re.fullmatch(r'[+-]?[\d,.]+%?', value.strip()) else value for value in row])
    return '\ufeff' + output.getvalue()


def _finish(blocks, source='pdf', notes=None):
    tables = [b for b in blocks if b['type'] == 'table']
    for i, table in enumerate(tables, 1):
        table['index'] = i
    return {'version': CONTENT_VERSION, 'source': source, 'blocks': blocks, 'table_count': len(tables), 'notes': notes or [],
            'text': '\n\n'.join(table_markdown(b) if b['type'] == 'table' else b['text'] for b in blocks),
            'model_text': '\n\n'.join(table_markdown(b, flatten=True) if b['type'] == 'table' else b['text'] for b in blocks)}


def _native_table(table, source):
    matrix = table.extract()
    boxes = [(box, matrix[r][c] or '') for r, row in enumerate(table.rows) for c, box in enumerate(row.cells) if box]
    if not boxes or not any(text.strip() for _, text in boxes):
        return None
    xs = _edges([v for box, _ in boxes for v in (box[0], box[2])])
    ys = _edges([v for box, _ in boxes for v in (box[1], box[3])])
    cols, rows = len(xs) - 1, len(ys) - 1
    if rows < 2 or cols < 2 or rows * cols > 12000:
        return None
    cells, occupied = [], set()
    for box, text in boxes:
        col = min(range(len(xs)), key=lambda i: abs(xs[i] - box[0]))
        row = min(range(len(ys)), key=lambda i: abs(ys[i] - box[1]))
        end_col = min(range(len(xs)), key=lambda i: abs(xs[i] - box[2]))
        end_row = min(range(len(ys)), key=lambda i: abs(ys[i] - box[3]))
        if col >= cols or row >= rows or end_col <= col or end_row <= row:
            continue
        positions = {(r, c) for r in range(row, end_row) for c in range(col, end_col)}
        if positions & occupied:
            continue
        occupied.update(positions)
        cells.append({'row': row, 'col': col, 'rowspan': end_row - row, 'colspan': end_col - col,
                      'text': text.strip(), 'bbox': [round(v, 2) for v in box]})
    for row in range(rows):
        for col in range(cols):
            if (row, col) not in occupied:
                cells.append({'row': row, 'col': col, 'rowspan': 1, 'colspan': 1, 'text': '', 'uncertain': True})
    return {'type': 'table', 'source': source, 'bbox': list(table.bbox), 'row_count': rows, 'col_count': cols,
            'header_rows': _header_rows(cells, rows), 'cells': cells}


def _join_text_lines(lines):
    """同一段落内，按几何位置拼回因字体回退拆开的同行片段。"""
    rows = []
    for text, box in sorted(lines, key=lambda v: (v[1][1], v[1][0])):
        for row in rows:
            bounds = row['bbox']
            overlap = min(bounds[3], box[3]) - max(bounds[1], box[1])
            gap = max(bounds[0], box[0]) - min(bounds[2], box[2])
            if overlap >= .6 * min(bounds[3] - bounds[1], box[3] - box[1]) and -1 <= gap <= .4 * max(bounds[3] - bounds[1], box[3] - box[1]):
                row['parts'].append((text, box))
                row['bbox'] = [min(bounds[0], box[0]), min(bounds[1], box[1]), max(bounds[2], box[2]), max(bounds[3], box[3])]
                break
        else:
            rows.append({'bbox': list(box), 'parts': [(text, box)]})
    return '\n'.join(''.join(text for text, box in sorted(row['parts'], key=lambda v: v[1][0])) for row in rows)


def extract_pdf_page(page):
    # find_tables 的结果使用当前调用的页面字符状态，必须在同一临界区消费完。
    with _TABLE_LOCK:
        notes = []
        try:
            tables = [t for raw in page.find_tables().tables if (t := _native_table(raw, 'pdf-lines'))]
            if not tables:
                candidates = [t for raw in page.find_tables(strategy='text').tables if (t := _native_table(raw, 'pdf-text'))]
                tables = []
                for table in candidates:
                    values = [c['text'] for c in table['cells'] if c['text']]
                    numeric = sum(bool(re.search(r'\d', v)) for v in values)
                    if table['row_count'] >= 4 and len(values) >= table['row_count'] * table['col_count'] * .55 and numeric >= len(values) * .25:
                        tables.append(table)
        except Exception:
            tables = []
            notes.append('表格结构未能完整识别，已保留页面文字，请结合原文核对。')
        blocks = list(tables)
        flags = pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES
        for block in page.get_text('dict', flags=flags, sort=True)['blocks']:
            if block.get('type') != 0:
                continue
            lines, rects = [], []
            for line in block.get('lines', []):
                spans, line_rects = [], []
                for span in line.get('spans', []):
                    x0, y0, x1, y1 = span['bbox']
                    if any(t['bbox'][0] - .5 <= (x0+x1)/2 <= t['bbox'][2] + .5 and t['bbox'][1] - .5 <= (y0+y1)/2 <= t['bbox'][3] + .5 for t in tables):
                        continue
                    spans.append(span['text']); rects.append(span['bbox']); line_rects.append(span['bbox'])
                if ''.join(spans).strip():
                    lines.append((''.join(spans), [min(r[0] for r in line_rects), min(r[1] for r in line_rects), max(r[2] for r in line_rects), max(r[3] for r in line_rects)]))
            if lines:
                horizontal = all(tuple(line.get('dir', (1, 0))) == (1, 0) for line in block.get('lines', []))
                text = _join_text_lines(lines) if horizontal else '\n'.join(text for text, _ in lines)
                blocks.append({'type': 'text', 'text': text, 'bbox': [min(r[0] for r in rects), min(r[1] for r in rects), max(r[2] for r in rects), max(r[3] for r in rects)]})
        blocks.sort(key=lambda b: (round(b['bbox'][1], 1), b['bbox'][0]))
        return _finish(blocks, 'pdf', notes)


class _HTMLTable(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows, self.current, self.cell, self.skip = [], None, None, 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.skip += 1
        if self.skip:
            return
        if tag == 'tr':
            self.current = []; self.rows.append(self.current)
        elif tag in ('th', 'td') and self.current is not None:
            attrs = dict(attrs)
            def span(name, limit):
                try:
                    return min(limit, max(1, int(attrs.get(name, 1))))
                except (ValueError, TypeError):
                    return 1
            self.cell = {'text': '', 'rowspan': span('rowspan', 200), 'colspan': span('colspan', 50), 'header': tag == 'th'}
            self.current.append(self.cell)
        elif tag == 'br' and self.cell is not None:
            self.cell['text'] += '\n'

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.skip = max(0, self.skip - 1)
        elif tag in ('th', 'td'):
            self.cell = None
        elif tag == 'tr':
            self.current = None

    def handle_data(self, text):
        if self.cell is not None and not self.skip:
            self.cell['text'] += text

    def table(self):
        if len(self.rows) < 2 or len(self.rows) > 500:
            return None
        cells, used, cols = [], set(), 0
        for r, row in enumerate(self.rows):
            c = 0
            for cell in row:
                while (r, c) in used:
                    c += 1
                if c + cell['colspan'] > 100:
                    return None
                rowspan = min(cell['rowspan'], len(self.rows) - r)
                positions = {(y, x) for y in range(r, r + rowspan) for x in range(c, c + cell['colspan'])}
                if positions & used:
                    return None
                used.update(positions)
                cells.append({'row': r, 'col': c, 'text': cell['text'].strip(), 'rowspan': rowspan, 'colspan': cell['colspan']})
                c += cell['colspan']; cols = max(cols, c)
        if cols < 2 or cols * len(self.rows) > 12000 or not any(c['text'] for c in cells):
            return None
        header = 0
        for row in self.rows:
            if row and all(c['header'] for c in row):
                header += 1
            else:
                break
        for r in range(len(self.rows)):
            for c in range(cols):
                if (r, c) not in used:
                    cells.append({'row': r, 'col': c, 'text': '', 'rowspan': 1, 'colspan': 1})
        return {'type': 'table', 'source': 'ocr-html', 'row_count': len(self.rows), 'col_count': cols,
                'header_rows': header or _header_rows(cells, len(self.rows)), 'cells': cells}


def _markdown_blocks(text):
    lines, blocks, pending, i = text.splitlines(), [], [], 0
    def split(line):
        return [re.sub(r'<br\s*/?>', '\n', c, flags=re.I).replace(r'\|', '|').strip() for c in re.split(r'(?<!\\)\|', line.strip().strip('|'))]
    while i < len(lines):
        if i + 1 < len(lines) and '|' in lines[i] and len(split(lines[i+1])) == len(split(lines[i])) and all(re.fullmatch(r':?-{3,}:?', c.strip()) for c in split(lines[i+1])) and len(split(lines[i])) >= 2:
            data = [split(lines[i])]; i += 2
            while i < len(lines) and '|' in lines[i] and lines[i].strip():
                values = split(lines[i])
                if len(values) != len(data[0]):
                    break
                data.append(values); i += 1
            if pending:
                blocks.append({'type': 'text', 'text': '\n'.join(pending).strip()}); pending = []
            if len(data) >= 2:
                blocks.append({'type': 'table', 'source': 'markdown', 'row_count': len(data), 'col_count': len(data[0]), 'header_rows': 1,
                    'cells': [{'row': r, 'col': c, 'rowspan': 1, 'colspan': 1, 'text': value} for r, row in enumerate(data) for c, value in enumerate(row)]})
            else:
                pending.append('| ' + ' | '.join(data[0]) + ' |')
        else:
            pending.append(lines[i]); i += 1
    if '\n'.join(pending).strip():
        blocks.append({'type': 'text', 'text': '\n'.join(pending).strip()})
    return blocks


def content_from_text(text):
    blocks, position = [], 0
    for match in re.finditer(r'<table\b[^>]*>.*?</table\s*>', text, flags=re.I | re.S):
        blocks.extend(_markdown_blocks(text[position:match.start()]))
        parser = _HTMLTable(); parser.feed(match.group())
        table = parser.table()
        blocks.append(table or {'type': 'text', 'text': match.group()})
        position = match.end()
    blocks.extend(_markdown_blocks(text[position:]))
    return _finish(blocks, 'text')


def content_html(content):
    return '\n'.join(table_html(b) if b['type'] == 'table' else '<p style="white-space:pre-wrap">' + escape(b['text']) + '</p>' for b in content['blocks'])
