// TODO: OG REFLECTION STYLES I WANT...

import React, { useState } from "react";

// Reflection Page Mockup — End-of-day/weekly notes + review charts
// Summaries of time spent per goal/bucket, plus a journal prompt list.

function classNames(...xs) {
  return xs.filter(Boolean).join(" ");
}

const MOCK_SUMMARY = [
  { id: "g1", goal: "Finish PopDot Beta", color: "from-fuchsia-500 to-purple-500", minutes: 420, target: 720 },
  { id: "g2", goal: "Learn Japanese", color: "from-emerald-500 to-cyan-500", minutes: 180, target: 300 },
  { id: "g3", goal: "Stay Fit", color: "from-lime-400 to-emerald-500", minutes: 210, target: 360 },
];

const JOURNAL_PROMPTS = [
  "What was today’s biggest win?",
  "What drained your energy?",
  "Any blockers you noticed recurring?",
  "What’s one small improvement for tomorrow?",
];

const Tab = ({ label, active }) => (
  <button
    className={classNames(
      "px-3 py-2 text-sm font-medium transition relative",
      active
        ? "text-white after:absolute after:left-0 after:right-0 after:-bottom-1 after:h-0.5 after:bg-white"
        : "text-white/70 hover:text-white"
    )}
  >
    {label}
  </button>
);

const ThinProgress = ({ value, gradient }) => (
  <div className="w-full h-2 rounded-full bg-white/10 overflow-hidden shadow-inner">
    <div
      className={classNames("h-full rounded-full bg-gradient-to-r", gradient)}
      style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
    />
  </div>
);

function ReflectionPage() {
  const [journal, setJournal] = useState("");

  return (
    <div
      className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 text-white antialiased"
      style={{ fontFamily: "Montserrat, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial" }}
    >
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap');`}</style>

      {/* Top Navbar */}
      <header className="sticky top-0 z-20 backdrop-blur-md supports-[backdrop-filter]:bg-white/5 bg-white/5 border-b border-white/10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-xl bg-gradient-to-br from-white/60 to-white/20 shadow" />
            <span className="font-semibold tracking-tight">Taskwatch</span>
          </div>
          <nav className="flex items-center gap-2">
            <Tab label="Goals" />
            <Tab label="Stopwatch" />
            <Tab label="Reflection" active />
          </nav>
          <div className="flex items-center gap-2">
            <button className="px-3 py-1.5 rounded-xl bg-white text-gray-900 text-sm font-semibold">
              + New Goal
            </button>
          </div>
        </div>
      </header>

      {/* Reflection Content */}
      <main className="max-w-3xl mx-auto px-4 py-10 space-y-10">
        <section>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">Reflection</h1>
          <p className="text-white/70 mt-1 max-w-lg">
            Review your progress and capture insights to guide tomorrow.
          </p>
        </section>

        {/* Progress Summary */}
        <section className="space-y-5">
          <h2 className="text-xl font-semibold tracking-tight">Weekly Progress</h2>
          {MOCK_SUMMARY.map((g) => {
            const pct = Math.round((g.minutes / g.target) * 100);
            return (
              <div key={g.id} className="p-4 rounded-2xl bg-white/5 border border-white/10 space-y-3">
                <div className="flex justify-between items-center">
                  <h3 className="font-medium">{g.goal}</h3>
                  <span className="text-sm text-white/80">
                    {Math.round(g.minutes / 60)} / {Math.round(g.target / 60)} h
                  </span>
                </div>
                <ThinProgress value={pct} gradient={g.color} />
              </div>
            );
          })}
        </section>

        {/* Journal Prompts */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold tracking-tight">Daily Reflection</h2>
          <p className="text-white/70 text-sm">Answer a few prompts to capture today’s highlights and challenges.</p>
          <div className="space-y-3">
            {JOURNAL_PROMPTS.map((p, idx) => (
              <div key={idx} className="p-3 rounded-xl bg-white/5 border border-white/10 text-sm text-left">
                {p}
              </div>
            ))}
          </div>
          <textarea
            value={journal}
            onChange={(e) => setJournal(e.target.value)}
            placeholder="Write your thoughts here..."
            className="w-full mt-4 min-h-[120px] p-3 rounded-xl bg-white/10 outline-none focus:ring-2 ring-white/30 text-sm"
          />
          <div className="flex justify-end">
            <button className="px-4 py-2 rounded-xl bg-white text-gray-900 font-semibold hover:bg-white/90">
              Save Reflection
            </button>
          </div>
        </section>
      </main>

      {/* Decorative gradient blobs */}
      <div className="pointer-events-none fixed -z-10 inset-0 opacity-30">
        <div className="absolute -top-24 -left-24 h-72 w-72 bg-fuchsia-500 blur-3xl rounded-full mix-blend-screen" />
        <div className="absolute -bottom-28 -right-24 h-80 w-80 bg-indigo-500 blur-3xl rounded-full mix-blend-screen" />
      </div>
    </div>
  );
}

export default ReflectionPage;
