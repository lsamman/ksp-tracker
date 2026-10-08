"""Resolve part names (as stored in a save) to their final merged config and .mu model(s)."""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
import import_save as I

GAME = os.path.expanduser("~/.local/share/Steam/steamapps/common/Kerbal Space Program")


def vec(s, n, d):
    try:
        v = [float(x) for x in s.replace(' ', '').split(',')]
        return v if len(v) == n else d
    except Exception:
        return d


def load_part_table(cache=GAME + "/GameData/ModuleManager.ConfigCache"):
    root = I.parse(open(cache, encoding='utf-8', errors='replace'))
    table = {}
    for _, uc in root[1]:
        url = I.val(uc, 'parentUrl') or ''
        for p in I.kids(uc, 'PART'):
            table[I.val(p, 'name')] = (url, p)      # last definition wins (final patched config)
    return table


def models_for(url, p):
    """-> list of dict(path, pos, rot, scl) in KSP model space. path is an absolute .mu file."""
    base = float(I.val(p, 'rescaleFactor', 1) or 1)
    scale = vec(I.val(p, 'scale', '1,1,1') if ',' in I.val(p, 'scale', '1') else I.val(p, 'scale', '1') + ',' + I.val(p, 'scale', '1') + ',' + I.val(p, 'scale', '1'), 3, [1, 1, 1])
    out = []
    for m in I.kids(p, 'MODEL'):
        mp = I.val(m, 'model')
        if not mp: continue
        s = vec(I.val(m, 'scale', '1,1,1'), 3, [1, 1, 1])
        out.append(dict(path=os.path.join(GAME, 'GameData', mp + '.mu'), pos=vec(I.val(m, 'position', '0,0,0'), 3, [0, 0, 0]),
                        rot=vec(I.val(m, 'rotation', '0,0,0'), 3, [0, 0, 0]), scl=s))
    if not out:
        mesh = I.val(p, 'mesh', 'model.mu')
        out.append(dict(path=os.path.join(GAME, 'GameData', os.path.dirname(url), mesh), pos=[0, 0, 0], rot=[0, 0, 0], scl=[1, 1, 1]))
    for o in out:
        o['global'] = [a * b * base for a, b in zip(scale, [1, 1, 1])]
    return out
