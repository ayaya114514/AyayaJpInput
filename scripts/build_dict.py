"""把 Mozc 开源词典打包成浏览器端用的二进制文件 dict/mozc.bin.gz。

用法：python scripts/build_dict.py
数据下载到 .cache/mozc/<commit>/（已 gitignore），固定在 MOZC_COMMIT 这个版本。

输出格式（little endian）：
  magic b"AYJD" | u32 version | u32 section 数 | (u32 offset, u32 length) * n | sections
  0 meta        UTF-8 JSON
  1 readings    排序后的读音，front coding：u8 共享前缀长, u8 后缀长, 后缀字符码
                （ぁ..ゖ → 1..86，ー → 87）
  2 counts      每个读音的词条数，LEB128 varint
  3 pairs       去重后的 (lid u16, rid u16)
  4 entry_pair  每个词条的 pair 下标 u16
  5 entry_cost  每个词条的 cost u16
  6 entry_kind  0 = 显式 surface，1 = 与读音相同，2 = 读音的片假名
  7 surfaces    显式 surface 按词条顺序用 \\n 连接的 UTF-8
  8 connection  int16 N*N，下标 rid * N + lid
  9 segmenter   u16 rclass[N], u16 lclass[N], 然后 u8 boundary[nr * nl]
"""

import gzip
import json
import re
import struct
import sys
import urllib.request
from pathlib import Path

import numpy as np

MOZC_COMMIT = '0136c35782536cb43d710575c311cd4185982738'
BASE_URL = f'https://raw.githubusercontent.com/google/mozc/{MOZC_COMMIT}/src/data'
FILES = {
    **{f'dictionary0{i}.txt': f'dictionary_oss/dictionary0{i}.txt' for i in range(10)},
    'connection_single_column.txt': 'dictionary_oss/connection_single_column.txt',
    'id.def': 'dictionary_oss/id.def',
    'README.txt': 'dictionary_oss/README.txt',
    'segmenter.def': 'rules/segmenter.def',
}

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / '.cache' / 'mozc' / MOZC_COMMIT
OUT = ROOT / 'dict' / 'mozc.bin.gz'
LICENSE_OUT = ROOT / 'public' / 'LICENSE-mozc-dictionary.txt'

VERSION = 1
CHOON = 'ー'
READING_RE = re.compile(r'^[ぁ-ゖー]+$')

# 非词典字符兜底用的词性（运行时按字符类别选用）
UNKNOWN_POS = {
    'noun': '名詞,一般,*,*,*,*,*',
    'number': '名詞,数,*,*,*,*,*',
    'alphabet': '記号,アルファベット,*,*,*,*,*',
    'symbol': '記号,一般,*,*,*,*,*',
    'open': '記号,括弧開,*,*,*,*,*',
    'close': '記号,括弧閉,*,*,*,*,*',
    'period': '記号,句点,*,*,*,*,。',
    'comma': '記号,読点,*,*,*,*,、',
    'question': '記号,句点,*,*,*,*,?',
    'exclamation': '記号,句点,*,*,*,*,!',
    'tilde': '記号,句点,*,*,*,*,～',
}


def fetch():
    CACHE.mkdir(parents=True, exist_ok=True)
    for name, path in FILES.items():
        dest = CACHE / name
        if dest.exists():
            continue
        print(f'download {path}')
        tmp = dest.with_suffix('.part')
        urllib.request.urlretrieve(f'{BASE_URL}/{path}', tmp)
        tmp.rename(dest)


def katakana(s):
    return ''.join(chr(ord(c) + 0x60) if 'ぁ' <= c <= 'ゖ' else c for c in s)


def reading_code(c):
    return 87 if c == CHOON else ord(c) - 0x3040


def load_pos():
    features = []
    for line in open(CACHE / 'id.def', encoding='utf-8'):
        idx, feature = line.split()
        assert int(idx) == len(features)
        features.append(feature)
    return features


def load_entries():
    entries = []
    skipped = 0
    for i in range(10):
        for line in open(CACHE / f'dictionary0{i}.txt', encoding='utf-8'):
            # 少数行有第 6 列 SPELLING_CORRECTION，只取前 5 列
            reading, lid, rid, cost, surface = line.rstrip('\n').split('\t')[:5]
            if not READING_RE.match(reading) or '\n' in surface:
                skipped += 1
                continue
            entries.append((reading, int(lid), int(rid), int(cost), surface))
    # JS 的字符串比较按 UTF-16 code unit；读音全是 BMP 字符，和 Python 排序一致
    entries.sort(key=lambda e: (e[0], e[3], e[4]))
    return entries, skipped


def build_segmenter(features):
    """按 gen_segmenter_code.py 的语义：第一条匹配的规则决定是否分段，默认 true。"""
    n = len(features)
    result = np.full((n, n), -1, dtype=np.int8)
    for line in open(CACHE / 'segmenter.def', encoding='utf-8'):
        if len(line) <= 1 or line[0] == '#':
            continue
        left, right, value = line.split()
        value = 1 if value.lower() == 'true' else 0

        def ids(pattern):
            if pattern == '*':
                return np.ones(n, dtype=bool)
            pat = re.compile(pattern.replace('*', '[^,]+'))
            return np.array([bool(pat.match(f)) for f in features])

        mask = np.outer(ids(left), ids(right)) & (result < 0)
        result[mask] = value
    result[result < 0] = 1
    result[0, :] = 1  # BOS
    result[:, 0] = 1  # EOS

    rows, rclass = np.unique(result, axis=0, return_inverse=True)
    cols, lclass = np.unique(rows, axis=1, return_inverse=True)
    return rclass.astype('<u2'), lclass.astype('<u2'), cols.astype(np.uint8)


def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def main():
    fetch()
    features = load_pos()
    n = len(features)
    entries, skipped = load_entries()
    print(f'entries {len(entries)} (skipped {skipped})')

    readings = []
    counts = []
    for e in entries:
        if readings and readings[-1] == e[0]:
            counts[-1] += 1
        else:
            readings.append(e[0])
            counts.append(1)

    reading_bytes = bytearray()
    prev = ''
    for r in readings:
        shared = 0
        while shared < min(len(prev), len(r), 255) and prev[shared] == r[shared]:
            shared += 1
        suffix = r[shared:]
        reading_bytes += bytes([shared, len(suffix)]) + bytes(reading_code(c) for c in suffix)
        prev = r

    pairs = {}
    entry_pair = np.empty(len(entries), dtype='<u2')
    entry_cost = np.empty(len(entries), dtype='<u2')
    entry_kind = np.empty(len(entries), dtype=np.uint8)
    surfaces = []
    for i, (reading, lid, rid, cost, surface) in enumerate(entries):
        entry_pair[i] = pairs.setdefault((lid, rid), len(pairs))
        entry_cost[i] = cost
        if surface == reading:
            entry_kind[i] = 1
        elif surface == katakana(reading):
            entry_kind[i] = 2
        else:
            entry_kind[i] = 0
            surfaces.append(surface)
    assert len(pairs) < 65536
    pair_array = np.array(list(pairs.keys()), dtype='<u2').reshape(-1)

    tokens = open(CACHE / 'connection_single_column.txt').read().split()
    assert int(tokens[0]) == n
    connection = np.array(tokens[1:], dtype=np.int32)
    assert connection.size == n * n and connection.max() < 32768
    connection = connection.astype('<i2')

    rclass, lclass, boundary = build_segmenter(features)
    print(f'segmenter classes r={boundary.shape[0]} l={boundary.shape[1]}')

    unknown = {k: features.index(v) for k, v in UNKNOWN_POS.items()}
    meta = {
        'mozcCommit': MOZC_COMMIT,
        'posSize': n,
        'readings': len(readings),
        'entries': len(entries),
        'pairs': len(pairs),
        'segmenterR': int(boundary.shape[0]),
        'segmenterL': int(boundary.shape[1]),
        'unknownPos': unknown,
    }

    sections = [
        json.dumps(meta, ensure_ascii=False).encode('utf-8'),
        bytes(reading_bytes),
        b''.join(varint(c) for c in counts),
        pair_array.tobytes(),
        entry_pair.tobytes(),
        entry_cost.tobytes(),
        entry_kind.tobytes(),
        '\n'.join(surfaces).encode('utf-8'),
        connection.tobytes(),
        rclass.tobytes() + lclass.tobytes() + boundary.tobytes(),
    ]

    header_size = 12 + 8 * len(sections)
    header = bytearray(b'AYJD' + struct.pack('<II', VERSION, len(sections)))
    offset = header_size
    for s in sections:
        # 每段按 4 字节对齐，方便直接建 TypedArray
        offset += (-offset) % 4
        header += struct.pack('<II', offset, len(s))
        offset += len(s)
    body = bytearray(header)
    for s in sections:
        body += b'\0' * ((-len(body)) % 4)
        body += s

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_bytes(gzip.compress(bytes(body), compresslevel=9, mtime=0))
    LICENSE_OUT.write_text(
        f'Data in mozc.bin.gz is derived from the Mozc open-source dictionary\n'
        f'https://github.com/google/mozc/tree/{MOZC_COMMIT}/src/data/dictionary_oss\n\n'
        + (CACHE / 'README.txt').read_text(encoding='utf-8'),
        encoding='utf-8',
    )

    names = ['meta', 'readings', 'counts', 'pairs', 'entry_pair', 'entry_cost',
             'entry_kind', 'surfaces', 'connection', 'segmenter']
    for name, s in zip(names, sections):
        print(f'  {name:11s} {len(s) / 1e6:7.2f} MB  gz {len(gzip.compress(s, 6)) / 1e6:6.2f} MB')
    print(f'raw {len(body) / 1e6:.2f} MB -> {OUT.relative_to(ROOT)} {OUT.stat().st_size / 1e6:.2f} MB')


if __name__ == '__main__':
    sys.exit(main())
