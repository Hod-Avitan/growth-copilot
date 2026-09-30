"use client";

import { useState } from "react";

export default function Home() {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const analyze = async () => {
    setLoading(true);

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        body: JSON.stringify({ input }),
      });

      const data = await res.json();
      setOutput(data);
    } catch (error) {
      console.error(error);

      setOutput({
        summary: "Failed to load analysis",
        root_causes: [],
        recommended_actions: [],
        risks: [],
        confidence: "low",
      });
    }

    setLoading(false);
  };

  const reset = () => {
    setInput("");
    setOutput(null);
    setLoading(false);
  };

  const rootCauses = output?.root_causes || [];
  const risks = output?.risks || [];
  const actions = output?.recommended_actions || [];

  const sortedActions = [...actions].sort(
    (a: any, b: any) => (b.priority || 0) - (a.priority || 0)
  );

  return (
    <main className="min-h-screen bg-gray-100 p-8">
      <div className="max-w-7xl mx-auto grid grid-cols-2 gap-6">

        {/* INPUT */}
        <div className="bg-white rounded-2xl shadow p-6">
          <h1 className="text-2xl font-bold mb-4">
            Growth Decision Copilot
          </h1>

          <textarea
            className="w-full h-[400px] border rounded-xl p-4"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste metrics / feedback / funnels..."
          />

          <div className="flex gap-3 mt-4">
            <button
              onClick={analyze}
              className="bg-black text-white px-6 py-3 rounded-xl"
            >
              {loading ? "Analyzing..." : "Analyze"}
            </button>

            <button
              onClick={reset}
              className="bg-gray-200 px-6 py-3 rounded-xl"
            >
              Clear
            </button>
          </div>
        </div>

        {/* OUTPUT */}
        <div className="space-y-4">

          {!output && (
            <div className="bg-white rounded-2xl shadow p-6 text-gray-500">
              AI insights will appear here.
            </div>
          )}

          {output && (
            <>
              {/* SUMMARY */}
              <div className="bg-white rounded-2xl shadow p-6">
                <h2 className="text-xl font-bold mb-2">Summary</h2>
                <p>{output?.summary || "No summary available"}</p>

                <div className="text-sm text-gray-500 mt-2">
                  Confidence: {output?.confidence || "unknown"}
                </div>
              </div>

              {/* TOP ACTION */}
              {sortedActions.length > 0 && (
                <div className="bg-black text-white rounded-2xl p-6">
                  <div className="text-sm opacity-70">
                    Top Recommendation
                  </div>

                  <div className="text-lg font-bold mt-1">
                    {sortedActions[0].action}
                  </div>
                </div>
              )}

              {/* ROOT CAUSES */}
              <div className="bg-white rounded-2xl shadow p-6">
                <h2 className="text-xl font-bold mb-3">Root Causes</h2>

                <ul className="list-disc pl-5 space-y-2">
                  {rootCauses.map((c: string, i: number) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>

              {/* ACTIONS */}
              <div className="bg-white rounded-2xl shadow p-6">
                <h2 className="text-xl font-bold mb-3">
                  Recommended Actions
                </h2>

                <div className="space-y-3">
                  {sortedActions.map((a: any, i: number) => (
                    <div key={i} className="border rounded-xl p-4">
                      <p className="font-medium">{a.action}</p>

                      <p className="text-sm text-gray-600 mt-1">
                        {a.why || ""}
                      </p>

                      <div className="text-xs text-gray-500 mt-2 flex gap-3">
                        <span>Impact {a.impact || 0}/5</span>
                        <span>Effort {a.effort || 0}/5</span>
                        <span>Priority {a.priority || 0}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* RISKS */}
              <div className="bg-white rounded-2xl shadow p-6">
                <h2 className="text-xl font-bold mb-3">Risks</h2>

                <ul className="list-disc pl-5 space-y-2">
                  {risks.map((r: string, i: number) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}