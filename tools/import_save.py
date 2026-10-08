#!/usr/bin/env python3
"""Convert a KSP persistent.sfs into the site's data/vessels.json (offline snapshot).

usage: import_save.py <persistent.sfs> <out_data_dir>
Body table order assumes the stock system (indices as in KSP's FlightGlobals.Bodies).
"""
import json, math, os, re, sys

BODIES = ["Sun", "Kerbin", "Mun", "Minmus", "Moho", "Eve", "Duna", "Ike", "Jool", "Laythe", "Vall", "Tylo", "Bop", "Pol", "Dres", "Eeloo", "Gilly"]
RADIUS = dict(Sun=261600000, Kerbin=600000, Mun=200000, Minmus=60000, Moho=250000, Eve=700000, Duna=320000, Ike=130000, Jool=6000000,
              Laythe=500000, Vall=300000, Tylo=600000, Bop=65000, Pol=44000, Dres=138000, Eeloo=210000, Gilly=13000)
MU = dict(Sun=1.1723328e18, Kerbin=3.5316e12, Mun=6.5138398e10, Minmus=1.7658e9, Moho=1.6860938e11, Eve=8.1717302e12, Duna=3.0136321e11,
          Ike=1.8568369e10, Jool=2.82528e14, Laythe=1.962e12, Vall=2.074815e11, Tylo=2.82528e12, Bop=2.4868349e9, Pol=7.2170208e8,
          Dres=2.1484489e10, Eeloo=7.4410815e10, Gilly=8.289449e6)
SKIP = {"Debris", "Flag", "EVA", "SpaceObject", "Unknown", "DroppedPart", "DeployedSciencePart", "DeployedGroundPart"}


def parse(lines):
    """Parse KSP ConfigNode text into (values: list[(k,v)], children: list[(name, node)])."""
    root = ([], [])
    stack = [root]
    pending = None
    for raw in lines:
        s = raw.strip()
        if not s or s.startswith("//"):
            continue
        if s == "{":
            node = ([], [])
            stack[-1][1].append((pending, node))
            stack.append(node)
        elif s == "}":
            stack.pop()
        elif "=" in s:
            k, _, v = s.partition("=")
            stack[-1][0].append((k.strip(), v.strip()))
        else:
            pending = s
    return root


def val(node, key, default=None):
    for k, v in node[0]:
        if k == key:
            return v
    return default


def vals(node, key):
    return [v for k, v in node[0] if k == key]


def kids(node, name):
    return [n for k, n in node[1] if k == name]


def num(s, d=0.0):
    try:
        return float(s)
    except (TypeError, ValueError):
        return d


# name: (parent, sma, ecc, inc, lan, argPe, maae, colour, atmosphere)
STOCK = dict(
    Moho=("Sun", 5263138304, .2, 7, 70, 15, 3.14, "b5875e", False), Eve=("Sun", 9832684544, .01, 2.1, 15, 0, 3.14, "a070c0", True),
    Gilly=("Eve", 31500000, .55, 12, 80, 10, .9, "bbbbbb", False), Kerbin=("Sun", 13599840256, 0, 0, 0, 0, 3.14, "5090e0", True),
    Mun=("Kerbin", 12000000, 0, 0, 0, 0, 1.7, "aaaaaa", False), Minmus=("Kerbin", 47000000, 0, 6, 78, 38, .9, "aaeedd", False),
    Duna=("Sun", 20726155264, .051, .06, 135.5, 0, 3.14, "d05a40", True), Ike=("Duna", 3200000, .03, .2, 0, 0, 1.7, "999999", False),
    Dres=("Sun", 40839348203, .145, 5, 280, 90, 3.14, "bbbbbb", False), Jool=("Sun", 68773560320, .05, 1.304, 52, 0, .1, "60b050", True),
    Laythe=("Jool", 27184000, 0, 0, 0, 0, 3.14, "4a78b0", True), Vall=("Jool", 43152000, 0, 0, 0, 0, .9, "a8c8d8", False),
    Tylo=("Jool", 68500000, 0, .025, 0, 0, 3.14, "aaaaaa", False), Bop=("Jool", 128500000, .235, 15, 10, 25, .9, "7a6a5a", False),
    Pol=("Jool", 179890000, .171, 4.25, 2, 15, .9, "c8c070", False), Eeloo=("Sun", 90118820000, .26, 6.15, 50, 260, 3.14, "ccddee", False))


def write_bodies(out):
    bodies = [dict(name="Sun", radius=RADIUS["Sun"], mu=MU["Sun"], soi=None, rotationPeriod=432000, atmosphere=True, color="ffcc55")]
    for n in BODIES[1:]:
        par, sma, ecc, inc, lan, arg, maae, col, atm = STOCK[n]
        soi = sma * (MU[n] / MU[par]) ** 0.4
        bodies.append(dict(name=n, radius=RADIUS[n], mu=MU[n], soi=soi, rotationPeriod=0, atmosphere=atm, color=col,
                           orbit=dict(body=par, sma=sma, ecc=ecc, inc=inc, lan=lan, argPe=arg, maae=maae, epoch=0, period=0,
                                      apA=0, peA=0, startUT=0, endUT=0, trans="FINAL")))
    json.dump(dict(bodies=bodies), open(os.path.join(out, "bodies.json"), "w"), indent=1)


def clean(x):
    """JSON has no NaN/Infinity: turn any non-finite number into null."""
    if isinstance(x, float) and not math.isfinite(x): return None
    if isinstance(x, dict): return {k: clean(v) for k, v in x.items()}
    if isinstance(x, list): return [clean(v) for v in x]
    return x


def main(src, out):
    root = parse(open(src, encoding="utf-8", errors="replace"))
    game = kids(root, "GAME")[0]
    fs = kids(game, "FLIGHTSTATE")[0]
    ut = num(val(fs, "UT"), num(val(game, "UT")))
    roster = {}
    for ros in kids(game, "ROSTER"):
        for kn in kids(ros, "KERBAL"):
            roster[val(kn, "name")] = (val(kn, "trait", "Pilot"), int(num(val(kn, "lvl", val(kn, "experienceLevel", 0)))))

    vessels = []
    for v in kids(fs, "VESSEL"):
        vtype = val(v, "type")
        if vtype in SKIP:
            continue
        orb = kids(v, "ORBIT")
        body, patches = None, []
        if orb:
            o = orb[0]
            ref = int(num(val(o, "REF")))
            body = BODIES[ref] if ref < len(BODIES) else None
            sma, ecc = num(val(o, "SMA")), num(val(o, "ECC"))
            elems = [sma, ecc] + [num(val(o, k)) for k in ("INC", "LAN", "LPE", "MNA", "EPH")]
            R = RADIUS.get(body, 0)
            mu = MU.get(body, 1)
            # the save stores NaN/Infinity for some invalid orbits; those vessels keep their position data but get no trajectory
            if all(math.isfinite(x) for x in elems):
                period = 2 * math.pi * math.sqrt(abs(sma) ** 3 / mu) if 0 <= ecc < 1 else None
                patches.append(dict(body=body, sma=sma, ecc=ecc, inc=elems[2], lan=elems[3], argPe=elems[4], maae=elems[5],
                                    epoch=elems[6], period=period, apA=sma * (1 + ecc) - R if ecc < 1 else None,
                                    peA=sma * (1 - ecc) - R, startUT=elems[6], endUT=None, trans="FINAL"))
        if body is None:
            continue
        # crew and resources
        crew, res = [], {}
        for p in kids(v, "PART"):
            for c in vals(p, "crew"):
                tr = roster.get(c, ("Pilot", 0))
                crew.append(dict(name=c, trait=tr[0], level=tr[1]))
            for r in kids(p, "RESOURCE"):
                n = val(r, "name")
                e = res.setdefault(n, dict(amount=0.0, max=0.0))
                e["amount"] += num(val(r, "amount"))
                e["max"] += num(val(r, "maxAmount"))
        mans = []
        for fp in kids(v, "FLIGHTPLAN"):
            for m in kids(fp, "MANEUVER"):
                dv = [num(x) for x in (val(m, "dV", "0,0,0")).split(",")]
                mans.append(dict(ut=num(val(m, "UT")), dv=dv, dvMag=math.sqrt(sum(x * x for x in dv))))
        name = val(v, "name")
        m = re.match(r"^([^:]+):(.+)$", name or "")
        item = dict(id=int(num(val(v, "persistentId", val(v, "pid", "0")).replace("-", "")[:9], 0) or len(vessels) + 1),
                    name=name, type=vtype, situation=val(v, "sit"), body=body, active=False,
                    launchUT=num(val(v, "lct")), missionTime=num(val(v, "met")), lat=num(val(v, "lat")),
                    lon=num(val(v, "lon")), alt=num(val(v, "alt")), crew=crew, resources=res,
                    patches=patches, maneuvers=mans)
        if m:
            item["tracked"] = dict(type=m.group(1).strip(), name=m.group(2).strip())
        vessels.append(item)

    # ids must be unique for the UI
    seen = set()
    for i, v in enumerate(vessels):
        while v["id"] in seen:
            v["id"] += 1
        seen.add(v["id"])

    mtime = os.path.getmtime(src)
    import datetime
    saved = datetime.datetime.fromtimestamp(mtime, datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    os.makedirs(out, exist_ok=True)
    json.dump(clean(dict(ut=ut, savedAt=saved, save=os.path.basename(os.path.dirname(src)), warp=1, paused=True,
                   heartbeatSeconds=300, vessels=vessels)), open(os.path.join(out, "vessels.json"), "w"), indent=1, allow_nan=False)
    write_bodies(out)
    json.dump(dict(save="default", entries={}), open(os.path.join(out, "history.json"), "w"))
    print(f"{len(vessels)} vessels at UT {ut:.0f}; types:", sorted({v['type'] for v in vessels}), "bodies:", sorted({v['body'] for v in vessels}))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
