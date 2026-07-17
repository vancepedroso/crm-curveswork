import { useState, useRef, useCallback, useEffect } from "react";

// ───────────────────────── constants ─────────────────────────
const TOOLS = [
  { key: "outline", label: "Roof outline", color: "#3b82f6", closed: true },
  { key: "ridge", label: "Ridge", color: "#f59e0b", closed: false },
  { key: "valley", label: "Valley", color: "#8b5cf6", closed: false },
  { key: "hip", label: "Hip", color: "#10b981", closed: false },
  { key: "eave", label: "Eave", color: "#ef4444", closed: false },
];

const PITCH_PRESETS = [
  { label: "Flat", value: 1.0 },
  { label: "4:12", value: 1.054 },
  { label: "6:12", value: 1.118 },
  { label: "8:12", value: 1.202 },
  { label: "10:12", value: 1.302 },
  { label: "12:12", value: 1.414 },
];

const CANVAS_W = 960;
const CANVAS_H = 640;

const uid = () => Math.random().toString(36).slice(2, 10);

// ── AI backend config ──
const AI_API_BASE = import.meta.env.VITE_MEASURE_API_URL || "http://localhost:8000";
const AI_API_KEY  = import.meta.env.VITE_MEASURE_API_KEY || "kR7mN2pQ9xVw4LbT8sJfYh3cGdE6nA1uZoI5rXqW0yM";

function polygonAreaPx(pts) {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    sum += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(sum / 2);
}
function polylineLenPx(pts) {
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    len += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  }
  return len;
}

// ───────────────────────── component ─────────────────────────
export default function RoofMeasurementPhase1({ onGeometryChange }) {
  const [stage, setStage] = useState("camera"); // camera | frozen
  const [stream, setStream] = useState(null);
  const [cameraError, setCameraError] = useState("");
  const [frameSrc, setFrameSrc] = useState(null);
  const [frameBlob, setFrameBlob] = useState(null); // raw blob sent to AI

  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);

  const [activeTool, setActiveTool] = useState("outline");
  const [drawPts, setDrawPts] = useState([]);
  const [shapes, setShapes] = useState([]); // {id, tool, pts}
  const [sections, setSections] = useState([]); // {id, name, pts, pitch}
  const [scaleLine, setScaleLine] = useState(null); // {p1,p2,knownM}
  const [knownM, setKnownM] = useState(5);
  const [settingScale, setSettingScale] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  // ── AI measurement state ──
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [aiResult, setAiResult] = useState(null); // raw response from FastAPI

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const streamRef = useRef(null);

  const openCamera = useCallback(async () => {
    setCameraError("");
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = s;
      setStream(s);
    } catch (err) {
      setCameraError(
        err?.name === "NotAllowedError"
          ? "Camera access was denied. Allow camera permissions and try again."
          : "Couldn't reach a camera on this device."
      );
    }
  }, []);

  // Attach the stream once the <video> element actually exists in the DOM
  useEffect(() => {
    if (stream && videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.play().catch((err) => {
        console.error("video.play() failed:", err);
      });
    }
  }, [stream]);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
  }

  function captureFrame() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const cv = document.createElement("canvas");
    cv.width = video.videoWidth;
    cv.height = video.videoHeight;
    cv.getContext("2d").drawImage(video, 0, 0);
    const dataUrl = cv.toDataURL("image/jpeg", 0.92);
    setFrameSrc(dataUrl);
    cv.toBlob((blob) => setFrameBlob(blob), "image/jpeg", 0.92);
    stopCamera();
    setStage("frozen");
  }

  function uploadImage(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      setFrameSrc(e.target.result);
      setStage("frozen");
    };
    reader.readAsDataURL(file);
    setFrameBlob(file);
  }

  function retake() {
    setFrameSrc(null);
    setFrameBlob(null);
    setAiResult(null);
    setAiError("");
    setStage("camera");
    setZoom(1);
    setRotation(0);
    setBrightness(100);
    setContrast(100);
    setShapes([]);
    setSections([]);
    setScaleLine(null);
    setDrawPts([]);
    openCamera();
  }

  // ── load frozen image into a ref for canvas drawing ──
  useEffect(() => {
    if (!frameSrc) return;
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      draw();
    };
    img.src = frameSrc;
  }, [frameSrc]);

  // ── scale calculation ──
  const mPerPx = (() => {
    if (!scaleLine?.p1 || !scaleLine?.p2) return null;
    const px = Math.hypot(scaleLine.p2.x - scaleLine.p1.x, scaleLine.p2.y - scaleLine.p1.y);
    return px > 0 ? scaleLine.knownM / px : null;
  })();

  // ── geometry summary ──
  const sf = mPerPx || 0.02;
  const measuredLines = TOOLS.filter((t) => !t.closed).map((t) => {
    const items = shapes.filter((sh) => sh.tool === t.key);
    const totalLen = items.reduce((a, sh) => a + polylineLenPx(sh.pts) * sf, 0);
    return { ...t, count: items.length, totalLen };
  });
  const totalFootprint = sections.reduce((a, s) => a + polygonAreaPx(s.pts) * sf * sf, 0);
  const totalSurface = sections.reduce((a, s) => {
    const factor = s.pitch ?? 1.15;
    return a + polygonAreaPx(s.pts) * sf * sf * factor;
  }, 0);

  // ── report geometry up to the parent wizard whenever it changes ──
  useEffect(() => {
    onGeometryChange?.({
      total_footprint_m2: parseFloat(totalFootprint.toFixed(2)),
      total_surface_m2: parseFloat(totalSurface.toFixed(2)),
    });
  }, [totalFootprint, totalSurface, onGeometryChange]);

  // ── send the frozen frame to the FastAPI measurement service ──
  async function measureWithAI() {
    if (!frameBlob) {
      setAiError("No captured frame to analyze yet.");
      return;
    }
    setAiLoading(true);
    setAiError("");
    try {
      const form = new FormData();
      form.append("image", frameBlob, "frame.jpg");

      const res = await fetch(`${AI_API_BASE}/api/v1/measure`, {
        method: "POST",
        headers: { "x-api-key": AI_API_KEY },
        body: form,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `API error ${res.status}`);
      }

      const data = await res.json();
      setAiResult(data);

      if (data.roofDetected && data.polygon?.length) {
        // Map polygon from the AI's native image resolution into our
        // fixed CANVAS_W × CANVAS_H drawing space.
        const scaleX = CANVAS_W / data.imageWidth;
        const scaleY = CANVAS_H / data.imageHeight;
        const pts = data.polygon.map(([x, y]) => ({ x: x * scaleX, y: y * scaleY }));

        setSections((prev) => [
          ...prev,
          { id: uid(), name: `AI Detected Roof`, pts, pitch: 1.15 },
        ]);
      }
    } catch (err) {
      setAiError(err.message || "AI measurement request failed.");
    } finally {
      setAiLoading(false);
    }
  }

  // ── drawing ──
  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.save();
    ctx.filter = `brightness(${brightness}%) contrast(${contrast}%)`;
    ctx.translate(CANVAS_W / 2, CANVAS_H / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.scale(zoom, zoom);
    ctx.translate(-CANVAS_W / 2, -CANVAS_H / 2);
    if (imgRef.current) {
      const img = imgRef.current;
      const scale = Math.max(CANVAS_W / img.width, CANVAS_H / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (CANVAS_W - w) / 2, (CANVAS_H - h) / 2, w, h);
    }
    ctx.restore();

    // shapes (ridge/valley/hip/eave)
    shapes.forEach((sh) => {
      const t = TOOLS.find((x) => x.key === sh.tool);
      ctx.strokeStyle = t.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      sh.pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      sh.pts.forEach((p) => {
        ctx.fillStyle = t.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      });
    });

    // sections (closed outlines)
    sections.forEach((sec, idx) => {
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      sec.pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = "rgba(59,130,246,0.15)";
      ctx.fill();
      const cx = sec.pts.reduce((a, p) => a + p.x, 0) / sec.pts.length;
      const cy = sec.pts.reduce((a, p) => a + p.y, 0) / sec.pts.length;
      ctx.fillStyle = "#0f172a";
      ctx.font = "bold 13px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(sec.name || `Section ${idx + 1}`, cx, cy);
    });

    // in-progress drawing
    if (drawPts.length > 0 && !settingScale) {
      const t = TOOLS.find((x) => x.key === activeTool);
      ctx.strokeStyle = t.color;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      drawPts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      ctx.setLineDash([]);
      drawPts.forEach((p, i) => {
        ctx.fillStyle = i === 0 ? "#fbbf24" : "#fff";
        ctx.beginPath();
        ctx.arc(p.x, p.y, i === 0 ? 6 : 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = t.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
    }

    // scale line
    if (scaleLine?.p1) {
      ctx.strokeStyle = "#10b981";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(scaleLine.p1.x, scaleLine.p1.y);
      if (scaleLine.p2) ctx.lineTo(scaleLine.p2.x, scaleLine.p2.y);
      ctx.stroke();
      [scaleLine.p1, scaleLine.p2].filter(Boolean).forEach((p) => {
        ctx.fillStyle = "#10b981";
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }, [shapes, sections, drawPts, activeTool, settingScale, scaleLine, zoom, rotation, brightness, contrast]);

  useEffect(() => {
    draw();
  }, [draw]);

  function getPt(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    const scaleX = CANVAS_W / rect.width;
    const scaleY = CANVAS_H / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  function handleCanvasClick(e) {
    const pt = getPt(e);
    if (settingScale) {
      if (!scaleLine?.p1) setScaleLine({ p1: pt, p2: null, knownM });
      else if (!scaleLine?.p2) {
        setScaleLine((prev) => ({ ...prev, p2: pt }));
        setSettingScale(false);
      }
      return;
    }
    const toolDef = TOOLS.find((t) => t.key === activeTool);
    if (toolDef.closed) {
      if (drawPts.length >= 3) {
        const d = Math.hypot(pt.x - drawPts[0].x, pt.y - drawPts[0].y);
        if (d < 18) {
          setSections((prev) => [
            ...prev,
            { id: uid(), name: `Section ${prev.length + 1}`, pts: drawPts, pitch: 1.15 },
          ]);
          setDrawPts([]);
          return;
        }
      }
      setDrawPts((prev) => [...prev, pt]);
    } else {
      setDrawPts((prev) => [...prev, pt]);
    }
  }

  function finishLine() {
    if (drawPts.length >= 2) {
      setShapes((prev) => [...prev, { id: uid(), tool: activeTool, pts: drawPts }]);
    }
    setDrawPts([]);
  }

  function cancelDraw() {
    setDrawPts([]);
    setSettingScale(false);
    setScaleLine((prev) => (prev && !prev.p2 ? null : prev));
  }

  function clearAll() {
    setShapes([]);
    setSections([]);
    setScaleLine(null);
    setDrawPts([]);
    setAiResult(null);
    setAiError("");
  }

  function saveProject() {
    const project = {
      id: uid(),
      created_at: new Date().toISOString(),
      scale_m_per_px: parseFloat(sf.toFixed(6)),
      sections: sections.map((s) => ({
        id: s.id,
        name: s.name,
        pitch_factor: s.pitch,
        footprint_m2: parseFloat((polygonAreaPx(s.pts) * sf * sf).toFixed(2)),
        surface_m2: parseFloat((polygonAreaPx(s.pts) * sf * sf * (s.pitch ?? 1.15)).toFixed(2)),
      })),
      lines: shapes.map((sh) => ({
        id: sh.id,
        type: sh.tool,
        length_m: parseFloat((polylineLenPx(sh.pts) * sf).toFixed(2)),
      })),
      total_footprint_m2: parseFloat(totalFootprint.toFixed(2)),
      total_surface_m2: parseFloat(totalSurface.toFixed(2)),
      ai_result: aiResult || null,
    };
    console.log("Saved roof measurement project:", project);
    setSavedMsg("Project saved");
    setTimeout(() => setSavedMsg(""), 2500);
  }

  const activeToolDef = TOOLS.find((t) => t.key === activeTool);

  // ═══════════════════════ camera stage ═══════════════════════
  if (stage === "camera") {
    return (
      <div style={styles.wrap}>
        <div style={styles.cameraStage}>
          {stream ? (
            <video ref={videoRef} autoPlay playsInline muted style={styles.video} />
          ) : (
            <div style={styles.cameraPlaceholder}>
              <div style={{ fontSize: 15, color: "#94a3b8", marginBottom: 16 }}>
                {cameraError || "Camera is not open yet."}
              </div>
              <button style={styles.primaryBtn} onClick={openCamera}>
                Open camera
              </button>
              <div style={{ marginTop: 14, fontSize: 13, color: "#64748b" }}>
                or{" "}
                <label style={{ color: "#3b82f6", cursor: "pointer" }}>
                  upload a photo
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={(e) => e.target.files[0] && uploadImage(e.target.files[0])}
                  />
                </label>
              </div>
            </div>
          )}
        </div>
        {stream && (
          <div style={styles.captureBar}>
            <button style={styles.ghostBtn} onClick={stopCamera}>
              Cancel
            </button>
            <button style={styles.captureBtn} onClick={captureFrame} aria-label="Capture frame">
              <div style={styles.captureBtnInner} />
            </button>
            <div style={{ width: 80 }} />
          </div>
        )}
      </div>
    );
  }

  // ═══════════════════════ frozen / measure stage ═══════════════════════
  return (
    <div style={styles.wrap}>
      <div style={styles.toolbar}>
        {TOOLS.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setActiveTool(t.key);
              setDrawPts([]);
              setSettingScale(false);
            }}
            style={{
              ...styles.toolBtn,
              borderColor: activeTool === t.key && !settingScale ? t.color : "rgba(255,255,255,0.15)",
              background: activeTool === t.key && !settingScale ? t.color + "26" : "transparent",
              color: activeTool === t.key && !settingScale ? t.color : "#94a3b8",
            }}
          >
            {t.label}
          </button>
        ))}
        <button
          onClick={() => {
            setSettingScale(true);
            setDrawPts([]);
          }}
          style={{
            ...styles.toolBtn,
            borderColor: settingScale ? "#10b981" : "rgba(255,255,255,0.15)",
            background: settingScale ? "#10b98126" : "transparent",
            color: settingScale ? "#10b981" : "#94a3b8",
          }}
        >
          Set scale
        </button>

        {/* ── AI measure trigger ── */}
        <button
          onClick={measureWithAI}
          disabled={aiLoading}
          style={{
            ...styles.toolBtn,
            borderColor: "#a855f7",
            background: aiLoading ? "rgba(168,85,247,0.15)" : "transparent",
            color: "#a855f7",
            opacity: aiLoading ? 0.7 : 1,
            cursor: aiLoading ? "not-allowed" : "pointer",
          }}
        >
          {aiLoading ? "Analyzing…" : "✨ Measure with AI"}
        </button>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {!activeToolDef.closed && drawPts.length >= 2 && (
            <button style={styles.doneBtn} onClick={finishLine}>
              Done
            </button>
          )}
          {(drawPts.length > 0 || settingScale) && (
            <button style={styles.ghostBtnSm} onClick={cancelDraw}>
              Cancel
            </button>
          )}
          <button style={styles.ghostBtnSm} onClick={clearAll}>
            Clear all
          </button>
        </div>
      </div>

      {(aiError || aiResult) && (
        <div
          style={{
            padding: "8px 14px",
            fontSize: 12,
            background: aiError ? "rgba(239,68,68,0.1)" : "rgba(16,185,129,0.1)",
            color: aiError ? "#f87171" : "#10b981",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          {aiError
            ? `AI error: ${aiError}`
            : aiResult.roofDetected
            ? `AI detected a roof · ${(aiResult.confidence * 100).toFixed(0)}% confidence — outline added below. Set scale for real m².`
            : "AI did not detect a roof in this frame."}
        </div>
      )}

      <div style={styles.hintBar}>
        {settingScale
          ? scaleLine?.p1
            ? "Click the second point of your known measurement"
            : "Click the first point of a known measurement (e.g. a door width)"
          : activeToolDef.closed
          ? "Click to add points, click the first point to close the outline"
          : "Click to add points along the line, then press Done"}
        {settingScale && (
          <span style={{ marginLeft: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "#64748b" }}>Known length:</span>
            <input
              type="number"
              value={knownM}
              onChange={(e) => setKnownM(parseFloat(e.target.value) || 1)}
              style={styles.numInput}
            />
            <span style={{ color: "#64748b" }}>m</span>
          </span>
        )}
      </div>

      <div style={styles.canvasWrap}>
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          onClick={handleCanvasClick}
          style={{ width: "100%", display: "block", cursor: "crosshair" }}
        />
      </div>

      <div style={styles.adjustBar}>
        <AdjustControl label="Zoom" value={zoom} min={1} max={3} step={0.05} onChange={setZoom} display={`${zoom.toFixed(2)}x`} />
        <AdjustControl label="Rotate" value={rotation} min={-45} max={45} step={1} onChange={setRotation} display={`${rotation}°`} />
        <AdjustControl label="Brightness" value={brightness} min={40} max={160} step={1} onChange={setBrightness} display={`${brightness}%`} />
        <AdjustControl label="Contrast" value={contrast} min={40} max={160} step={1} onChange={setContrast} display={`${contrast}%`} />
      </div>

      <div style={styles.summaryBar}>
        <div style={styles.summaryStat}>
          <span style={{ color: "#64748b" }}>Scale</span>
          <span style={{ color: mPerPx ? "#10b981" : "#f59e0b", fontWeight: 600 }}>
            {mPerPx ? `1px = ${(mPerPx * 100).toFixed(1)}cm` : "not set (approx.)"}
          </span>
        </div>
        <div style={styles.summaryStat}>
          <span style={{ color: "#64748b" }}>Footprint</span>
          <span style={{ fontWeight: 700 }}>{totalFootprint.toFixed(1)} m²</span>
        </div>
        <div style={styles.summaryStat}>
          <span style={{ color: "#64748b" }}>Surface area</span>
          <span style={{ fontWeight: 700, color: "#f59e0b" }}>{totalSurface.toFixed(1)} m²</span>
        </div>
      </div>

      {sections.length > 0 && (
        <div style={styles.sectionsPanel}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }}>
            Roof sections
          </div>
          {sections.map((sec, idx) => (
            <div key={sec.id} style={styles.sectionRow}>
              <input
                value={sec.name}
                onChange={(e) =>
                  setSections((prev) => prev.map((s) => (s.id === sec.id ? { ...s, name: e.target.value } : s)))
                }
                style={styles.sectionNameInput}
              />
              <select
                value={sec.pitch}
                onChange={(e) =>
                  setSections((prev) =>
                    prev.map((s) => (s.id === sec.id ? { ...s, pitch: parseFloat(e.target.value) } : s))
                  )
                }
                style={styles.pitchSelect}
              >
                {PITCH_PRESETS.map((p) => (
                  <option key={p.label} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              <span style={{ fontSize: 12, color: "#64748b", minWidth: 70, textAlign: "right" }}>
                {(polygonAreaPx(sec.pts) * sf * sf * sec.pitch).toFixed(1)} m²
              </span>
              <button
                onClick={() => setSections((prev) => prev.filter((s) => s.id !== sec.id))}
                style={styles.removeBtn}
                aria-label={`Remove ${sec.name}`}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {measuredLines.some((l) => l.count > 0) && (
        <div style={styles.sectionsPanel}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }}>
            Measured lines
          </div>
          {measuredLines
            .filter((l) => l.count > 0)
            .map((l) => (
              <div key={l.key} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13 }}>
                <span style={{ color: l.color }}>{l.label}</span>
                <span style={{ color: "#e2e8f0" }}>
                  {l.count} line{l.count > 1 ? "s" : ""} · {l.totalLen.toFixed(1)} m
                </span>
              </div>
            ))}
        </div>
      )}

      <div style={styles.bottomBar}>
        <button style={styles.ghostBtn} onClick={retake}>
          Retake photo
        </button>
        <button style={styles.primaryBtn} onClick={saveProject}>
          {savedMsg || "Save measurements"}
        </button>
      </div>
    </div>
  );
}

function AdjustControl({ label, value, min, max, step, onChange, display }) {
  return (
    <div style={styles.adjustControl}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>
        <span>{label}</span>
        <span>{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: "100%" }}
      />
    </div>
  );
}

// ───────────────────────── styles ─────────────────────────
const styles = {
  wrap: {
    fontFamily: "'DM Sans', system-ui, sans-serif",
    background: "#0f172a",
    borderRadius: 14,
    overflow: "hidden",
    color: "#e2e8f0",
    maxWidth: 1000,
    margin: "0 auto",
  },
  cameraStage: {
    position: "relative",
    width: "100%",
    aspectRatio: "16 / 10",
    background: "#000",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  video: { width: "100%", height: "100%", objectFit: "cover" },
  cameraPlaceholder: { textAlign: "center", padding: 24 },
  captureBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "18px 24px",
    background: "#0f172a",
  },
  captureBtn: {
    width: 64,
    height: 64,
    borderRadius: "50%",
    border: "3px solid #fff",
    background: "transparent",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  captureBtnInner: { width: 50, height: 50, borderRadius: "50%", background: "#fff" },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "10px 14px",
    background: "#1e293b",
    flexWrap: "wrap",
  },
  toolBtn: {
    padding: "6px 12px",
    borderRadius: 8,
    border: "1px solid",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  doneBtn: {
    padding: "6px 12px",
    borderRadius: 8,
    border: "1px solid #10b981",
    background: "#10b981",
    color: "#fff",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  ghostBtnSm: {
    padding: "6px 12px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.15)",
    background: "transparent",
    color: "#94a3b8",
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  hintBar: {
    padding: "8px 14px",
    background: "#0f172a",
    fontSize: 12,
    color: "#64748b",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
  },
  numInput: {
    width: 50,
    padding: "2px 6px",
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.2)",
    borderRadius: 4,
    color: "#fff",
    fontSize: 12,
  },
  canvasWrap: { width: "100%", background: "#020617" },
  adjustBar: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 16,
    padding: "14px 18px",
    background: "#1e293b",
  },
  adjustControl: {},
  summaryBar: {
    display: "flex",
    gap: 24,
    padding: "12px 18px",
    background: "#0f172a",
    borderTop: "1px solid rgba(255,255,255,0.06)",
    flexWrap: "wrap",
  },
  summaryStat: { display: "flex", flexDirection: "column", gap: 2, fontSize: 13 },
  sectionsPanel: { padding: "14px 18px", borderTop: "1px solid rgba(255,255,255,0.06)" },
  sectionRow: { display: "flex", alignItems: "center", gap: 8, padding: "6px 0" },
  sectionNameInput: {
    flex: 1,
    padding: "5px 8px",
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 6,
    color: "#e2e8f0",
    fontSize: 12,
    fontFamily: "inherit",
  },
  pitchSelect: {
    padding: "5px 8px",
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 6,
    color: "#e2e8f0",
    fontSize: 12,
    fontFamily: "inherit",
  },
  removeBtn: {
    padding: "3px 8px",
    border: "none",
    background: "rgba(239,68,68,0.15)",
    color: "#ef4444",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: 12,
  },
  bottomBar: {
    display: "flex",
    justifyContent: "space-between",
    padding: "16px 18px",
    background: "#1e293b",
  },
  primaryBtn: {
    padding: "10px 20px",
    borderRadius: 8,
    border: "none",
    background: "#f59e0b",
    color: "#000",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  ghostBtn: {
    padding: "10px 20px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.2)",
    background: "transparent",
    color: "#e2e8f0",
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "inherit",
  },
};