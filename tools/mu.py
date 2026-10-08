"""Minimal KSP .mu reader: returns a transform tree with meshes (geometry only) and the texture list.
Format reference: taniwha/io_object_mu. Unity is left-handed; we keep Unity coordinates here.
"""
import struct


class R:
    def __init__(s, b): s.b, s.i = b, 0
    def eof(s): return s.i >= len(s.b)
    def int(s): v = struct.unpack_from('<i', s.b, s.i)[0]; s.i += 4; return v
    def ints(s, n): v = struct.unpack_from('<%di' % n, s.b, s.i); s.i += 4 * n; return v
    def floats(s, n): v = struct.unpack_from('<%df' % n, s.b, s.i); s.i += 4 * n; return v
    def byte(s): v = s.b[s.i]; s.i += 1; return v
    def str(s):
        n = sh = 0
        while True:
            c = s.byte(); n |= (c & 127) << sh; sh += 7
            if not c & 128: break
        v = s.b[s.i:s.i + n].decode('utf-8', 'replace'); s.i += n; return v


class Obj:
    def __init__(s): s.name = ''; s.pos = (0, 0, 0); s.rot = (0, 0, 0, 1); s.scl = (1, 1, 1); s.children = []; s.mesh = None; s.mats = []; s.tag = None


def read_mesh(r):
    assert r.int() == 13
    nv, nsub = r.ints(2)
    m = dict(verts=None, uv=None, normals=None, tris=[])
    while True:
        t = r.int()
        if t == 14: m['verts'] = r.floats(nv * 3)
        elif t == 15: m['uv'] = r.floats(nv * 2)
        elif t == 16: r.floats(nv * 2)
        elif t == 17: m['normals'] = r.floats(nv * 3)
        elif t == 18: r.floats(nv * 4)
        elif t == 19:
            n = r.int(); m['tris'].append(r.ints(n))
        elif t == 20: r.i += nv * 32
        elif t == 21:
            n = r.int(); r.floats(16 * n)
        elif t == 32: r.i += nv * 4
        elif t == 22: return m
        else: raise ValueError('mesh entry %d at %d' % (t, r.i))


# v<4 shader types -> fields after the name/type, in order: 't' MuMatTex(1 int + 4 floats), 'c' color(4f), 'f' float
V3_LAYOUT = {1: 't', 2: 'tcf', 3: 'tt', 4: 'ttcf', 5: 'ttc', 6: 'tcfttc'[:3] + 'tc', 7: 'ttcftc', 8: 'tf', 9: 'ttf',
             10: 'tc', 11: 'tfcf', 12: 'tc', 13: 'tc', 14: 'tcf', 15: 'tcf'}


def read_materials(r, ver, info):
    n = r.int()
    mats = []
    start = r.i
    try:
        for _ in range(n):
            name = r.str()
            if ver >= 4:
                r.str()
                tex = None
                for _ in range(r.int()):
                    pn = r.str(); pt = r.int()
                    if pt in (0, 1): r.floats(4)
                    elif pt in (2, 3): r.floats(1)
                    else:
                        idx = r.int(); r.floats(4)
                        if pn == '_MainTex': tex = idx
                mats.append(dict(name=name, tex=tex))
            else:
                typ = r.int(); tex = None
                for k, c in enumerate(V3_LAYOUT[typ]):
                    if c == 't':
                        idx = r.int(); r.floats(4)
                        if tex is None: tex = idx
                    elif c == 'c': r.floats(4)
                    else: r.floats(1)
                mats.append(dict(name=name, tex=tex))
        if r.i + 4 > len(r.b) or struct.unpack_from('<i', r.b, r.i)[0] not in (12, 2):
            raise ValueError('layout')
        info['materials'] = mats
    except Exception:
        # unknown layout: find the texture list (entry 12 + count + n strings) that ends at EOF
        r.i = start
        for p in range(start, len(r.b) - 8):
            if struct.unpack_from('<i', r.b, p)[0] == 12:
                try:
                    q = R(r.b); q.i = p + 4
                    tn = q.int()
                    if 0 < tn < 40:
                        for _ in range(tn): q.str(); q.int()
                        if q.eof():
                            r.i = p; info['materials'] = [dict(name='?', tex=0)] * n; return
                except Exception: pass
        raise ValueError('materials unparsable')


def read_obj(r, ver, info):
    o = Obj()
    o.name = r.str(); o.pos = r.floats(3); o.rot = r.floats(4); o.scl = r.floats(3)
    while not r.eof():
        t = r.int()
        if t == 0: o.children.append(read_obj(r, ver, info))
        elif t == 1: return o
        elif t == 24: o.tag = r.str(); r.int()
        elif t == 7: o.mesh = read_mesh(r)
        elif t == 8:
            if ver > 0: r.byte(); r.byte()
            n = r.int(); o.mats = list(r.ints(n))
        elif t == 9:
            n = r.int(); o.mats = list(r.ints(n)); r.floats(6); r.int(); r.byte()
            nb = r.int()
            for _ in range(nb): r.str()
            o.mesh = read_mesh(r)
        elif t in (3, 25):
            if t == 25: r.byte()
            r.byte(); read_mesh(r)
        elif t in (4, 26):
            if t == 26: r.byte()
            r.floats(4)
        elif t in (5, 27):
            if t == 27: r.byte()
            r.floats(2); r.int(); r.floats(3)
        elif t in (6, 28):
            if t == 28: r.byte()
            r.floats(6)
        elif t == 12:
            n = r.int(); info['textures'] = [(r.str(), r.int()) for _ in range(n)]
        elif t == 10:
            read_materials(r, ver, info)
        elif t == 2:
            for _ in range(r.int()):
                r.str(); r.floats(6); r.int()
                for _ in range(r.int()):
                    r.str(); r.str(); r.int(); r.ints(2)
                    for _ in range(r.int()): r.floats(2); r.floats(2); r.int()
            r.str(); r.byte()
        elif t == 31:
            r.byte(); r.int(); r.floats(3); r.floats(2); r.floats(1); r.floats(4); r.byte(); r.floats(2); r.floats(2); r.ints(2)
            r.floats(3); r.floats(3); r.floats(3); r.floats(3)        # world/local/rnd velocity, emitterVelocityScale+angular+rndAngular
            r.byte(); r.byte(); r.floats(20); r.floats(3); r.floats(3); r.floats(1)
            r.floats(3); r.floats(3); r.floats(1); r.byte(); r.byte(); r.floats(3); r.int(); r.ints(3); r.int()
        elif t == 29:
            r.floats(3); r.floats(3); r.floats(3); r.floats(5); r.floats(5)
        elif t == 23:
            r.int(); r.floats(2); r.floats(4); r.int()
            if ver > 1: r.floats(1)
        elif t == 30:
            r.int(); r.floats(4); r.int(); r.byte(); r.floats(4)
        else:
            raise ValueError('entry %d at %d (%s)' % (t, r.i, o.name))
    return o


def load(path):
    b = open(path, 'rb').read()
    r = R(b)
    magic, ver = r.ints(2)
    assert magic == 76543, 'bad magic'
    name = r.str()
    info = {'version': ver, 'name': name, 'textures': []}
    root = read_obj(r, ver, info)
    return root, info
