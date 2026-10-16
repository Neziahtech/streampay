"use client";

import { useState, useId } from "react";
import Link from "next/link";
import { streamedAt, computeVestingAccrual } from "@/lib/oracle";

interface SegmentInput {
  duration: number;
  percent: number; // 0 to 100
}

export default function SimulatorPage() {
  const [totalDeposit, setTotalDeposit] = useState<number>(10000);
  const [totalDuration, setTotalDuration] = useState<number>(3600); // 1 hour in seconds
  const [cliffDuration, setCliffDuration] = useState<number>(600); // 10 minutes
  const [cliffPercent, setCliffPercent] = useState<number>(20); // 20%
  const [timeCursor, setTimeCursor] = useState<number>(1800); // 30 minutes
  const [useSegments, setUseSegments] = useState<boolean>(false);
  const [segments, setSegments] = useState<SegmentInput[]>([
    { duration: 1800, percent: 40 },
    { duration: 1800, percent: 60 },
  ]);

  const depositId = useId();
  const durationId = useId();
  const cliffDurId = useId();
  const cliffPctId = useId();
  const scrubberId = useId();

  const depositBig = BigInt(Math.max(0, Math.floor(totalDeposit)));
  const durationBig = BigInt(Math.max(1, Math.floor(totalDuration)));
  const cliffDurBig = BigInt(Math.max(0, Math.min(totalDuration, Math.floor(cliffDuration))));
  const cliffAmountBig = (depositBig * BigInt(Math.max(0, Math.min(100, cliffPercent)))) / 100n;
  const cursorBig = BigInt(Math.max(0, Math.min(totalDuration, Math.floor(timeCursor))));

  const accrualParams = {
    deposit: depositBig,
    duration: durationBig,
    cliffDuration: cliffDurBig,
    cliffAmount: cliffAmountBig,
    segments: useSegments
      ? segments.map((s) => ({
          duration: BigInt(Math.max(1, Math.floor(s.duration))),
          percentBps: BigInt(Math.max(0, Math.floor(s.percent * 100))),
        }))
      : undefined,
  };

  // Pure contract streamed_at without cliff
  const pureContractAccrued = streamedAt(depositBig, durationBig, cursorBig);
  // Vesting schedule accrual with cliff / segments
  const scheduleAccrued = computeVestingAccrual(accrualParams, cursorBig);

  // Sample points for claimable-at-t curve chart (SVG)
  const steps = 100;
  const chartPoints = Array.from({ length: steps + 1 }, (_, i) => {
    const t = (BigInt(i) * durationBig) / BigInt(steps);
    const accrued = computeVestingAccrual(accrualParams, t);
    return {
      t: Number(t),
      accrued: Number(accrued),
      pureAccrued: Number(streamedAt(depositBig, durationBig, t)),
    };
  });

  const svgWidth = 600;
  const svgHeight = 240;
  const padding = 40;
  const plotWidth = svgWidth - padding * 2;
  const plotHeight = svgHeight - padding * 2;

  const maxVal = Math.max(1, totalDeposit);
  const maxT = Math.max(1, totalDuration);

  const getX = (t: number) => padding + (t / maxT) * plotWidth;
  const getY = (val: number) => svgHeight - padding - (val / maxVal) * plotHeight;

  const schedulePath = chartPoints
    .map((p, i) => `${i === 0 ? "M" : "L"} ${getX(p.t).toFixed(1)} ${getY(p.accrued).toFixed(1)}`)
    .join(" ");

  const contractPath = chartPoints
    .map((p, i) => `${i === 0 ? "M" : "L"} ${getX(p.t).toFixed(1)} ${getY(p.pureAccrued).toFixed(1)}`)
    .join(" ");

  const cursorX = getX(timeCursor);
  const cursorY = getY(Number(scheduleAccrued));

  return (
    <main className="wrap">
      <div style={{ marginBottom: "16px" }}>
        <Link href="/" style={{ color: "var(--accent2)", textDecoration: "none", fontSize: "14px" }}>
          ← Back to StreamPay
        </Link>
      </div>

      <div className="kicker mono" style={{ letterSpacing: "0.15em", color: "var(--accent2)" }}>
        INTERACTIVE TS ORACLE PLAYGROUND
      </div>
      <h1>Accrual & Vesting Simulator</h1>
      <p className="muted">
        Pure client-side accrual oracle and vesting schedule playground. Drag parameters to model
        streamed_at rates, cliffs, and multi-segment milestones with instant curve visualization.
      </p>

      {/* Interactive Controls */}
      <section className="card">
        <h2>Schedule Parameters</h2>
        <div className="row">
          <div>
            <label htmlFor={depositId}>Total Deposit (tokens): {totalDeposit.toLocaleString()}</label>
            <input
              id={depositId}
              type="range"
              min="100"
              max="1000000"
              step="100"
              value={totalDeposit}
              onChange={(e) => setTotalDeposit(Number(e.target.value))}
            />
          </div>
          <div>
            <label htmlFor={durationId}>Total Duration (seconds): {totalDuration}s ({Math.round(totalDuration / 60)}m)</label>
            <input
              id={durationId}
              type="range"
              min="60"
              max="86400"
              step="60"
              value={totalDuration}
              onChange={(e) => {
                const val = Number(e.target.value);
                setTotalDuration(val);
                if (cliffDuration > val) setCliffDuration(val);
                if (timeCursor > val) setTimeCursor(val);
              }}
            />
          </div>
        </div>

        <div style={{ marginTop: "16px", display: "flex", gap: "12px", alignItems: "center" }}>
          <label style={{ margin: 0, display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={useSegments}
              onChange={(e) => setUseSegments(e.target.checked)}
            />
            <span>Enable Multi-Segment Milestones</span>
          </label>
        </div>

        {!useSegments ? (
          <div className="row" style={{ marginTop: "12px" }}>
            <div>
              <label htmlFor={cliffDurId}>Cliff Duration (seconds): {cliffDuration}s ({Math.round(cliffDuration / 60)}m)</label>
              <input
                id={cliffDurId}
                type="range"
                min="0"
                max={totalDuration}
                step="30"
                value={cliffDuration}
                onChange={(e) => setCliffDuration(Number(e.target.value))}
              />
            </div>
            <div>
              <label htmlFor={cliffPctId}>Cliff Unlock: {cliffPercent}% ({cliffAmountBig.toString()} tokens)</label>
              <input
                id={cliffPctId}
                type="range"
                min="0"
                max="100"
                step="5"
                value={cliffPercent}
                onChange={(e) => setCliffPercent(Number(e.target.value))}
              />
            </div>
          </div>
        ) : (
          <div style={{ marginTop: "14px" }}>
            <p className="muted" style={{ marginBottom: "8px" }}>Custom Piecewise Segments:</p>
            {segments.map((seg, idx) => (
              <div key={idx} className="row" style={{ marginBottom: "8px", alignItems: "center" }}>
                <div>
                  <span className="mono" style={{ fontSize: "12px" }}>Segment {idx + 1} Duration (s):</span>
                  <input
                    type="number"
                    min="1"
                    value={seg.duration}
                    onChange={(e) => {
                      const updated = [...segments];
                      updated[idx].duration = Number(e.target.value);
                      setSegments(updated);
                    }}
                  />
                </div>
                <div>
                  <span className="mono" style={{ fontSize: "12px" }}>Allocation (%):</span>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={seg.percent}
                    onChange={(e) => {
                      const updated = [...segments];
                      updated[idx].percent = Number(e.target.value);
                      setSegments(updated);
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Time Scrubber */}
      <section className="card">
        <h2>Time Scrubber (Elapsed: {timeCursor}s / {totalDuration}s)</h2>
        <div style={{ margin: "14px 0" }}>
          <label htmlFor={scrubberId}>Scrub Time (t = {timeCursor}s)</label>
          <input
            id={scrubberId}
            type="range"
            min="0"
            max={totalDuration}
            step="1"
            value={timeCursor}
            onChange={(e) => setTimeCursor(Number(e.target.value))}
            style={{ width: "100%" }}
          />
        </div>

        <div className="row" style={{ marginTop: "16px" }}>
          <div style={{ padding: "12px", background: "#0b121e", borderRadius: "8px", border: "1px solid var(--line)" }}>
            <span className="muted">Claimable at t (Vesting Schedule)</span>
            <div style={{ fontSize: "22px", fontWeight: "bold", color: "var(--green)" }} className="mono">
              {scheduleAccrued.toString()} tokens
            </div>
            <span className="muted" style={{ fontSize: "12px" }}>
              {totalDeposit > 0 ? ((Number(scheduleAccrued) / totalDeposit) * 100).toFixed(2) : 0}% unlocked
            </span>
          </div>

          <div style={{ padding: "12px", background: "#0b121e", borderRadius: "8px", border: "1px solid var(--line)" }}>
            <span className="muted">Contract Pure streamed_at (Linear)</span>
            <div style={{ fontSize: "22px", fontWeight: "bold", color: "var(--accent2)" }} className="mono">
              {pureContractAccrued.toString()} tokens
            </div>
            <span className="muted" style={{ fontSize: "12px" }}>
              Floor pro-rata reference
            </span>
          </div>
        </div>
      </section>

      {/* Visual Chart Canvas / SVG */}
      <section className="card">
        <h2>Claim Curves (Claimable vs Time)</h2>
        <div style={{ overflowX: "auto", display: "flex", justifyContent: "center" }}>
          <svg
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            style={{
              width: "100%",
              maxWidth: `${svgWidth}px`,
              background: "#080c14",
              borderRadius: "8px",
              border: "1px solid var(--line)",
            }}
          >
            {/* Grid & Axis */}
            <line x1={padding} y1={svgHeight - padding} x2={svgWidth - padding} y2={svgHeight - padding} stroke="#22304a" />
            <line x1={padding} y1={padding} x2={padding} y2={svgHeight - padding} stroke="#22304a" />

            {/* Contract Pure Linear Line (dashed blue) */}
            <path d={contractPath} fill="none" stroke="var(--accent2)" strokeWidth="2" strokeDasharray="4 4" opacity="0.6" />

            {/* Vesting Schedule Curve (solid purple/green) */}
            <path d={schedulePath} fill="none" stroke="var(--green)" strokeWidth="3" />

            {/* Cliff Marker */}
            {cliffDuration > 0 && !useSegments && (
              <line
                x1={getX(cliffDuration)}
                y1={padding}
                x2={getX(cliffDuration)}
                y2={svgHeight - padding}
                stroke="var(--red)"
                strokeDasharray="2 2"
                opacity="0.8"
              />
            )}

            {/* Cursor Marker */}
            <line
              x1={cursorX}
              y1={padding}
              x2={cursorX}
              y2={svgHeight - padding}
              stroke="var(--accent)"
              strokeWidth="2"
            />
            <circle cx={cursorX} cy={cursorY} r="5" fill="var(--green)" stroke="#fff" strokeWidth="2" />

            {/* Labels */}
            <text x={padding} y={svgHeight - 12} fill="var(--muted)" fontSize="11" fontFamily="monospace">0s</text>
            <text x={svgWidth - padding - 30} y={svgHeight - 12} fill="var(--muted)" fontSize="11" fontFamily="monospace">{totalDuration}s</text>
            <text x={10} y={padding + 10} fill="var(--muted)" fontSize="11" fontFamily="monospace">{totalDeposit}</text>
            <text x={10} y={svgHeight - padding} fill="var(--muted)" fontSize="11" fontFamily="monospace">0</text>
          </svg>
        </div>

        <div style={{ display: "flex", gap: "20px", marginTop: "14px", fontSize: "13px", justifyContent: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ width: "16px", height: "3px", background: "var(--green)", display: "inline-block" }}></span>
            <span>Vesting Schedule Curve</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ width: "16px", height: "2px", borderTop: "2px dashed var(--accent2)", display: "inline-block" }}></span>
            <span>Pure streamed_at Reference</span>
          </div>
          {cliffDuration > 0 && !useSegments && (
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ width: "16px", height: "2px", borderTop: "2px dashed var(--red)", display: "inline-block" }}></span>
              <span>Cliff Point</span>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
