using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using UnityEngine;
using KSP.UI.Screens;

namespace FleetTracker
{
    // Persistent addon: snapshots the fleet every few seconds and commits JSON to GitHub.
    [KSPAddon(KSPAddon.Startup.MainMenu, true)]
    public class FleetTrackerAddon : MonoBehaviour
    {
        static readonly Regex Tracked = new Regex(@"^(?<type>[^:]+):(?<name>.+)$");
        const double HeartbeatSeconds = 300;

        string root, token, repo, branch, dataDir;
        float interval = 60f;
        float timer;
        double lastUploadReal = -1e9;
        string lastHash;
        string lastBodiesHash;
        readonly Dictionary<string, string> shas = new Dictionary<string, string>();
        readonly object uploadLock = new object();
        Dictionary<string, HistoryEntry> history = new Dictionary<string, HistoryEntry>();
        string historySave;
        bool configured;
        readonly HashSet<string> texDone = new HashSet<string>();
        readonly HashSet<string> texBusy = new HashSet<string>();

        class HistoryEntry
        {
            public string Type, Name;
            public int Recoveries;
            public double LastUT;
            public string LastAt;
        }

        void Awake()
        {
            DontDestroyOnLoad(gameObject);
            root = KSPUtil.ApplicationRootPath;
            dataDir = Path.Combine(root, "GameData/FleetTracker/PluginData");
            LoadConfig();
            GameEvents.onVesselRecovered.Add(OnRecovered);
            GameEvents.onVesselRecoveryProcessingComplete.Add(OnRecoveryDone);
            GameEvents.onGameStateSaved.Add(OnSaved);
            Log("started, configured=" + configured);
        }

        void OnDestroy()
        {
            GameEvents.onVesselRecovered.Remove(OnRecovered);
            GameEvents.onVesselRecoveryProcessingComplete.Remove(OnRecoveryDone);
            GameEvents.onGameStateSaved.Remove(OnSaved);
        }

        static void Log(string m) { Debug.Log("[FleetTracker] " + m); }

        void LoadConfig()
        {
            try
            {
                string path = Path.Combine(dataDir, "config.cfg");
                if (!File.Exists(path)) { Log("no config.cfg in PluginData; uploads disabled"); return; }
                ConfigNode n = ConfigNode.Load(path);
                if (n == null) return;
                token = n.GetValue("token");
                repo = n.GetValue("repo");
                branch = n.HasValue("branch") ? n.GetValue("branch") : "data";
                float i;
                if (n.HasValue("intervalSeconds") && float.TryParse(n.GetValue("intervalSeconds"), NumberStyles.Float, CultureInfo.InvariantCulture, out i))
                    interval = Mathf.Max(15f, i);
                configured = !string.IsNullOrEmpty(token) && !string.IsNullOrEmpty(repo) && token != "PASTE_TOKEN_HERE";
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2
                string tf = TexMarkerPath();
                if (repo != null && File.Exists(tf)) foreach (string l in File.ReadAllLines(tf)) if (l.Length > 0) texDone.Add(l);
            }
            catch (Exception e) { Log("config error: " + e); }
        }

        // ---- history (per save) ----

        string HistoryPath()
        {
            string save = HighLogic.SaveFolder ?? "unknown";
            foreach (char c in Path.GetInvalidFileNameChars()) save = save.Replace(c, '_');
            return Path.Combine(dataDir, "history_" + save + ".cfg");
        }

        void EnsureHistoryLoaded()
        {
            if (HighLogic.CurrentGame == null || historySave == HighLogic.SaveFolder) return;
            historySave = HighLogic.SaveFolder;
            history = new Dictionary<string, HistoryEntry>();
            lastHash = null;
            try
            {
                string p = HistoryPath();
                if (!File.Exists(p)) return;
                ConfigNode n = ConfigNode.Load(p);
                if (n == null) return;
                foreach (ConfigNode v in n.GetNodes("VESSEL"))
                {
                    var e = new HistoryEntry
                    {
                        Type = v.GetValue("type"),
                        Name = v.GetValue("name"),
                        LastAt = v.GetValue("lastAt") ?? ""
                    };
                    int r; double u;
                    int.TryParse(v.GetValue("recoveries"), out r); e.Recoveries = r;
                    double.TryParse(v.GetValue("lastUT"), NumberStyles.Float, CultureInfo.InvariantCulture, out u); e.LastUT = u;
                    history[e.Type + ":" + e.Name] = e;
                }
            }
            catch (Exception ex) { Log("history load error: " + ex); }
        }

        void SaveHistory()
        {
            try
            {
                Directory.CreateDirectory(dataDir);
                var n = new ConfigNode();
                foreach (var e in history.Values)
                {
                    ConfigNode v = n.AddNode("VESSEL");
                    v.AddValue("type", e.Type);
                    v.AddValue("name", e.Name);
                    v.AddValue("recoveries", e.Recoveries);
                    v.AddValue("lastUT", e.LastUT.ToString("R", CultureInfo.InvariantCulture));
                    v.AddValue("lastAt", e.LastAt);
                }
                n.Save(HistoryPath());
            }
            catch (Exception ex) { Log("history save error: " + ex); }
        }

        void OnRecovered(ProtoVessel pv, bool quick)
        {
            try
            {
                EnsureHistoryLoaded();
                if (pv == null) return;
                Match m = Tracked.Match(pv.vesselName ?? "");
                if (!m.Success) return;
                string type = m.Groups["type"].Value.Trim(), name = m.Groups["name"].Value.Trim();
                string key = type + ":" + name;
                HistoryEntry e;
                if (!history.TryGetValue(key, out e)) { e = new HistoryEntry { Type = type, Name = name }; history[key] = e; }
                e.Recoveries++;
                e.LastUT = Planetarium.GetUniversalTime();
                e.LastAt = DateTime.UtcNow.ToString("o");
                SaveHistory();
                Log("recovered " + key + " (x" + e.Recoveries + ")");
            }
            catch (Exception ex) { Log("recover error: " + ex); }
        }

        void OnRecoveryDone(ProtoVessel pv, MissionRecoveryDialog dlg, float f) { timer = interval; }
        void OnSaved(Game g) { timer = Mathf.Max(timer, interval - 5f); }

        // ---- main loop ----

        void Update()
        {
            if (!configured || HighLogic.CurrentGame == null) return;
            if (HighLogic.LoadedScene == GameScenes.MAINMENU || HighLogic.LoadedScene == GameScenes.LOADING) return;
            timer += Time.unscaledDeltaTime;
            if (timer < interval) return;
            timer = 0f;
            try { Tick(); } catch (Exception e) { Log("tick error: " + e); }
        }

        void Tick()
        {
            if (FlightGlobals.Vessels == null) return;
            EnsureHistoryLoaded();

            double ut = Planetarium.GetUniversalTime();
            string vessels = BuildVessels();
            string bodies = BuildBodies();
            string hist = BuildHistory();

            // Hash excludes ut / wall clock so a coasting fleet doesn't spam commits.
            string h = vessels + "|" + hist + "|" + TimeWarp.CurrentRate.ToString("R", CultureInfo.InvariantCulture);
            double now = Time.realtimeSinceStartup;
            bool changed = h != lastHash;
            bool heartbeat = now - lastUploadReal >= HeartbeatSeconds;
            var texes = ExportPendingTextures();
            if (texes.Count > 0) ThreadPool.QueueUserWorkItem(_ => UploadTextures(texes));
            if (!changed && !heartbeat) return;
            lastHash = h;
            lastUploadReal = now;

            string envelope = "{\"ut\":" + Num(ut)
                + ",\"savedAt\":" + Str(DateTime.UtcNow.ToString("o"))
                + ",\"save\":" + Str(HighLogic.SaveFolder)
                + ",\"warp\":" + Num(TimeWarp.CurrentRate)
                + ",\"paused\":" + (FlightDriver.Pause ? "true" : "false")
                + ",\"heartbeatSeconds\":" + Num(HeartbeatSeconds)
                + ",\"vessels\":" + vessels + "}";
            string bodiesJson = null;
            if (bodies != lastBodiesHash) { lastBodiesHash = bodies; bodiesJson = bodies; }

            string histJson = hist;
            ThreadPool.QueueUserWorkItem(_ => Upload(envelope, bodiesJson, histJson));
        }

        // ---- JSON builders ----

        static string Num(double d)
        {
            if (double.IsNaN(d) || double.IsInfinity(d)) return "null";
            return d.ToString("R", CultureInfo.InvariantCulture);
        }

        static string Str(string s)
        {
            if (s == null) return "null";
            var sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.AppendFormat("\\u{0:x4}", (int)c); else sb.Append(c);
                        break;
                }
            }
            return sb.Append('"').ToString();
        }

        static void WriteOrbit(StringBuilder s, Orbit o)
        {
            s.Append("{\"body\":").Append(Str(o.referenceBody.name))
             .Append(",\"sma\":").Append(Num(o.semiMajorAxis))
             .Append(",\"ecc\":").Append(Num(o.eccentricity))
             .Append(",\"inc\":").Append(Num(o.inclination))
             .Append(",\"lan\":").Append(Num(o.LAN))
             .Append(",\"argPe\":").Append(Num(o.argumentOfPeriapsis))
             .Append(",\"maae\":").Append(Num(o.meanAnomalyAtEpoch))
             .Append(",\"epoch\":").Append(Num(o.epoch))
             .Append(",\"period\":").Append(Num(o.period))
             .Append(",\"apA\":").Append(Num(o.ApA))
             .Append(",\"peA\":").Append(Num(o.PeA))
             .Append(",\"startUT\":").Append(Num(o.StartUT))
             .Append(",\"endUT\":").Append(Num(o.EndUT))
             .Append(",\"trans\":").Append(Str(o.patchEndTransition.ToString()))
             .Append('}');
        }

        static bool IsTrackable(Vessel v)
        {
            switch (v.vesselType)
            {
                case VesselType.Debris:
                case VesselType.Flag:
                case VesselType.EVA:
                case VesselType.SpaceObject:
                case VesselType.Unknown:
                    return false;
            }
            return true;
        }

        string BuildVessels()
        {
            var s = new StringBuilder("[");
            bool first = true;
            foreach (Vessel v in FlightGlobals.Vessels)
            {
                if (v == null || !IsTrackable(v)) continue;
                try
                {
                    var one = new StringBuilder();
                    WriteVessel(one, v);
                    if (!first) s.Append(',');
                    first = false;
                    s.Append(one);
                }
                catch (Exception e) { Log("vessel " + v.vesselName + ": " + e.Message); }
            }
            return s.Append(']').ToString();
        }

        void WriteVessel(StringBuilder s, Vessel v)
        {
            s.Append("{\"id\":").Append(v.persistentId)
             .Append(",\"name\":").Append(Str(v.vesselName))
             .Append(",\"type\":").Append(Str(v.vesselType.ToString()))
             .Append(",\"situation\":").Append(Str(v.situation.ToString()))
             .Append(",\"body\":").Append(Str(v.mainBody != null ? v.mainBody.name : null))
             .Append(",\"active\":").Append(FlightGlobals.ActiveVessel == v ? "true" : "false")
             .Append(",\"launchUT\":").Append(Num(v.launchTime))
             .Append(",\"missionTime\":").Append(Num(v.missionTime))
             .Append(",\"lat\":").Append(Num(v.latitude))
             .Append(",\"lon\":").Append(Num(v.longitude))
             .Append(",\"alt\":").Append(Num(v.altitude));

            Match m = Tracked.Match(v.vesselName ?? "");
            if (m.Success)
                s.Append(",\"tracked\":{\"type\":").Append(Str(m.Groups["type"].Value.Trim()))
                 .Append(",\"name\":").Append(Str(m.Groups["name"].Value.Trim())).Append('}');

            // crew
            s.Append(",\"crew\":[");
            var crew = v.GetVesselCrew();
            for (int i = 0; i < crew.Count; i++)
            {
                if (i > 0) s.Append(',');
                s.Append("{\"name\":").Append(Str(crew[i].name))
                 .Append(",\"trait\":").Append(Str(crew[i].trait))
                 .Append(",\"level\":").Append(crew[i].experienceLevel).Append('}');
            }
            s.Append(']');

            // resources
            var amt = new Dictionary<string, double[]>();
            if (v.loaded)
            {
                foreach (Part p in v.parts)
                    foreach (PartResource r in p.Resources)
                        Add(amt, r.resourceName, r.amount, r.maxAmount);
            }
            else if (v.protoVessel != null)
            {
                foreach (ProtoPartSnapshot pp in v.protoVessel.protoPartSnapshots)
                    foreach (ProtoPartResourceSnapshot r in pp.resources)
                        Add(amt, r.resourceName, r.amount, r.maxAmount);
            }
            s.Append(",\"resources\":{");
            bool f = true;
            foreach (var kv in amt)
            {
                if (!f) s.Append(',');
                f = false;
                s.Append(Str(kv.Key)).Append(":{\"amount\":").Append(Num(kv.Value[0]))
                 .Append(",\"max\":").Append(Num(kv.Value[1])).Append('}');
            }
            s.Append('}');

            // orbit patches
            s.Append(",\"patches\":[");
            int n = 0;
            for (Orbit o = v.orbit; o != null && n < 6; o = o.nextPatch, n++)
            {
                if (n > 0) s.Append(',');
                WriteOrbit(s, o);
                if (o.patchEndTransition == Orbit.PatchTransitionType.FINAL
                    || o.patchEndTransition == Orbit.PatchTransitionType.INITIAL) break;
            }
            s.Append(']');

            // maneuver nodes
            s.Append(",\"maneuvers\":[");
            bool mf = true;
            if (v.patchedConicSolver != null)
            {
                foreach (ManeuverNode mn in v.patchedConicSolver.maneuverNodes)
                {
                    if (!mf) s.Append(',');
                    mf = false;
                    s.Append("{\"ut\":").Append(Num(mn.UT))
                     .Append(",\"dv\":[").Append(Num(mn.DeltaV.x)).Append(',').Append(Num(mn.DeltaV.y)).Append(',').Append(Num(mn.DeltaV.z))
                     .Append("],\"dvMag\":").Append(Num(mn.DeltaV.magnitude)).Append('}');
                }
            }
            else if (v.protoVessel != null && v.protoVessel.flightPlan != null)
            {
                foreach (ConfigNode mn in v.protoVessel.flightPlan.GetNodes("MANEUVER"))
                {
                    double ut = 0;
                    double.TryParse(mn.GetValue("UT"), NumberStyles.Float, CultureInfo.InvariantCulture, out ut);
                    Vector3d dv = Vector3d.zero;
                    string dvs = mn.GetValue("dV");
                    if (dvs != null)
                    {
                        string[] p = dvs.Split(',');
                        if (p.Length == 3)
                        {
                            double.TryParse(p[0], NumberStyles.Float, CultureInfo.InvariantCulture, out dv.x);
                            double.TryParse(p[1], NumberStyles.Float, CultureInfo.InvariantCulture, out dv.y);
                            double.TryParse(p[2], NumberStyles.Float, CultureInfo.InvariantCulture, out dv.z);
                        }
                    }
                    if (!mf) s.Append(',');
                    mf = false;
                    s.Append("{\"ut\":").Append(Num(ut))
                     .Append(",\"dv\":[").Append(Num(dv.x)).Append(',').Append(Num(dv.y)).Append(',').Append(Num(dv.z))
                     .Append("],\"dvMag\":").Append(Num(dv.magnitude)).Append('}');
                }
            }
            s.Append("]}");
        }

        static void Add(Dictionary<string, double[]> d, string name, double a, double m)
        {
            double[] x;
            if (!d.TryGetValue(name, out x)) { x = new double[2]; d[name] = x; }
            x[0] += a; x[1] += m;
        }

        string BuildBodies()
        {
            var s = new StringBuilder("{\"bodies\":[");
            bool first = true;
            foreach (CelestialBody b in FlightGlobals.Bodies)
            {
                if (!first) s.Append(',');
                first = false;
                s.Append("{\"name\":").Append(Str(b.name))
                 .Append(",\"radius\":").Append(Num(b.Radius))
                 .Append(",\"mu\":").Append(Num(b.gravParameter))
                 .Append(",\"soi\":").Append(Num(b.sphereOfInfluence))
                 .Append(",\"rotationPeriod\":").Append(Num(b.rotationPeriod))
                 .Append(",\"atmosphere\":").Append(b.atmosphere ? "true" : "false");
                if (b.orbitDriver != null)
                {
                    Color c = b.orbitDriver.orbitColor;
                    s.Append(",\"color\":").Append(Str(ColorUtility.ToHtmlStringRGB(c)));
                }
                if (b.orbit != null && b.referenceBody != b)
                {
                    s.Append(",\"orbit\":");
                    WriteOrbit(s, b.orbit);
                }
                s.Append('}');
            }
            return s.Append("]}").ToString();
        }

        string BuildHistory()
        {
            var s = new StringBuilder("{\"save\":").Append(Str(HighLogic.SaveFolder)).Append(",\"entries\":{");
            bool first = true;
            foreach (var kv in history)
            {
                if (!first) s.Append(',');
                first = false;
                s.Append(Str(kv.Key)).Append(":{\"type\":").Append(Str(kv.Value.Type))
                 .Append(",\"name\":").Append(Str(kv.Value.Name))
                 .Append(",\"recoveries\":").Append(kv.Value.Recoveries)
                 .Append(",\"lastRecoveredUT\":").Append(Num(kv.Value.LastUT))
                 .Append(",\"lastRecoveredAt\":").Append(Str(kv.Value.LastAt)).Append('}');
            }
            return s.Append("}}").ToString();
        }

        // ---- body textures (map-view diffuse maps, exported once per body) ----

        string TexMarkerPath()
        {
            string r = (repo ?? "none").Replace('/', '_');
            return Path.Combine(dataDir, "textures_" + r + ".txt");
        }

        List<KeyValuePair<string, byte[]>> ExportPendingTextures()
        {
            var list = new List<KeyValuePair<string, byte[]>>();
            foreach (CelestialBody b in FlightGlobals.Bodies)
            {
                if (list.Count >= 3) break;
                lock (texBusy) { if (texDone.Contains(b.name) || texBusy.Contains(b.name)) continue; }
                byte[] jpg = null;
                try { jpg = ExportTexture(b); }
                catch (Exception e) { Log("texture " + b.name + ": " + e.Message); }
                lock (texBusy)
                {
                    if (jpg == null) { texDone.Add(b.name); continue; } // nothing to export; don't retry every tick
                    texBusy.Add(b.name);
                }
                list.Add(new KeyValuePair<string, byte[]>(b.name, jpg));
            }
            return list;
        }

        static byte[] ExportTexture(CelestialBody b)
        {
            if (b.scaledBody == null) return null;
            Renderer r = b.scaledBody.GetComponent<Renderer>();
            if (r == null || r.sharedMaterial == null) return null;
            Material m = r.sharedMaterial;
            Texture tex = null;
            foreach (string prop in new[] { "_MainTex", "_ColorMap", "_Diffuse", "_EmissiveMap" })
                if (m.HasProperty(prop)) { tex = m.GetTexture(prop); if (tex != null) break; }
            if (tex == null) return null;
            int w = Mathf.Min(tex.width, 2048), h = Mathf.Min(tex.height, 1024);
            if (w < 2 || h < 2) return null;
            RenderTexture rt = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.Default);
            RenderTexture prev = RenderTexture.active;
            try
            {
                Graphics.Blit(tex, rt);
                RenderTexture.active = rt;
                var t2 = new Texture2D(w, h, TextureFormat.RGB24, false);
                t2.ReadPixels(new Rect(0, 0, w, h), 0, 0);
                t2.Apply();
                byte[] bytes = t2.EncodeToJPG(85);
                Destroy(t2);
                Log("exported texture " + b.name + " " + w + "x" + h + " (" + bytes.Length / 1024 + " KB)");
                return bytes;
            }
            finally { RenderTexture.active = prev; RenderTexture.ReleaseTemporary(rt); }
        }

        void UploadTextures(List<KeyValuePair<string, byte[]>> texes)
        {
            lock (uploadLock)
            {
                foreach (var kv in texes)
                {
                    try
                    {
                        PutBytes("data/textures/" + kv.Key + ".jpg", kv.Value);
                        lock (texBusy)
                        {
                            texDone.Add(kv.Key); texBusy.Remove(kv.Key);
                            Directory.CreateDirectory(dataDir);
                            File.AppendAllText(TexMarkerPath(), kv.Key + "\n");
                        }
                    }
                    catch (Exception e)
                    {
                        Log("texture upload " + kv.Key + " failed: " + e.Message);
                        lock (texBusy) texBusy.Remove(kv.Key); // retried on a later tick
                    }
                }
            }
        }

        // ---- GitHub upload (runs on a pool thread) ----

        void Upload(string vessels, string bodies, string hist)
        {
            lock (uploadLock)
            {
                try
                {
                    Put("data/vessels.json", vessels);
                    Put("data/history.json", hist);
                    if (bodies != null) Put("data/bodies.json", bodies);
                }
                catch (Exception e) { Log("upload failed: " + e.Message); }
            }
        }

        void Put(string path, string content) { PutBytes(path, Encoding.UTF8.GetBytes(content)); }

        void PutBytes(string path, byte[] content)
        {
            string url = "https://api.github.com/repos/" + repo + "/contents/" + path;
            for (int attempt = 0; attempt < 2; attempt++)
            {
                string sha;
                if (!shas.TryGetValue(path, out sha)) sha = FetchSha(url);
                var body = new StringBuilder("{\"message\":")
                    .Append(Str("telemetry " + path))
                    .Append(",\"branch\":").Append(Str(branch))
                    .Append(",\"content\":").Append(Str(Convert.ToBase64String(content)));
                if (sha != null) body.Append(",\"sha\":").Append(Str(sha));
                body.Append('}');

                var req = NewRequest(url, "PUT");
                byte[] bytes = Encoding.UTF8.GetBytes(body.ToString());
                req.ContentType = "application/json";
                req.ContentLength = bytes.Length;
                using (var rs = req.GetRequestStream()) rs.Write(bytes, 0, bytes.Length);
                try
                {
                    using (var resp = (HttpWebResponse)req.GetResponse())
                    using (var sr = new StreamReader(resp.GetResponseStream()))
                    {
                        string text = sr.ReadToEnd();
                        // the response has commit.sha first and content.sha; take the one inside "content"
                        Match m = Regex.Match(text, "\"content\"\\s*:\\s*\\{.*?\"sha\"\\s*:\\s*\"([0-9a-f]+)\"", RegexOptions.Singleline);
                        shas[path] = m.Success ? m.Groups[1].Value : null;
                        return;
                    }
                }
                catch (WebException we)
                {
                    var r = we.Response as HttpWebResponse;
                    shas.Remove(path); // stale sha: refetch and retry once
                    if (r == null || (r.StatusCode != HttpStatusCode.Conflict && (int)r.StatusCode != 422) || attempt == 1)
                        throw;
                }
            }
        }

        string FetchSha(string url)
        {
            var req = NewRequest(url + "?ref=" + Uri.EscapeDataString(branch), "GET");
            try
            {
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(resp.GetResponseStream()))
                {
                    Match m = Regex.Match(sr.ReadToEnd(), "\"sha\"\\s*:\\s*\"([0-9a-f]+)\"");
                    return m.Success ? m.Groups[1].Value : null;
                }
            }
            catch (WebException we)
            {
                var r = we.Response as HttpWebResponse;
                if (r != null && r.StatusCode == HttpStatusCode.NotFound) return null; // new file
                throw;
            }
        }

        HttpWebRequest NewRequest(string url, string method)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = method;
            req.UserAgent = "KSP-FleetTracker";
            req.Accept = "application/vnd.github+json";
            req.Headers["Authorization"] = "Bearer " + token;
            req.Headers["X-GitHub-Api-Version"] = "2022-11-28";
            req.Timeout = 20000;
            return req;
        }
    }
}
