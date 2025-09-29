import { useState } from 'react'
import './ReflectionPage.css'

const MOCK_SUMMARY = [
  { id: 'g1', goal: 'Finish PopDot Beta', gradient: 'gradient-fuchsia-purple', minutes: 420, target: 720 },
  { id: 'g2', goal: 'Learn Japanese', gradient: 'gradient-emerald-cyan', minutes: 180, target: 300 },
  { id: 'g3', goal: 'Stay Fit', gradient: 'gradient-lime-emerald', minutes: 210, target: 360 },
]

const JOURNAL_PROMPTS = [
  "What was today's biggest win?",
  "What drained your energy?",
  "Any blockers you noticed recurring?",
  "What's one small improvement for tomorrow?",
]

function ThinProgress({ value, gradient }: { value: number; gradient: string }) {
  return (
    <div className="reflection-progress">
      <div className={`reflection-progress__bar ${gradient}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  )
}

export default function ReflectionPage() {
  const [journal, setJournal] = useState('')

  return (
    <section className="site-main__inner reflection-page" aria-label="Reflection">
      <div className="reflection-intro">
        <h1 className="reflection-title">Reflection</h1>
        <p className="reflection-subtitle">Review your progress and capture insights to guide tomorrow.</p>
      </div>

      {/* Progress Summary */}
      <section className="reflection-section">
        <h2 className="reflection-section__title">Weekly Progress</h2>
        <div className="reflection-goals">
          {MOCK_SUMMARY.map((g) => {
            const pct = Math.round((g.minutes / g.target) * 100)
            return (
              <div key={g.id} className="reflection-goal-card">
                <div className="reflection-goal-header">
                  <h3 className="reflection-goal-name">{g.goal}</h3>
                  <span className="reflection-goal-time">
                    {Math.round(g.minutes / 60)} / {Math.round(g.target / 60)} h
                  </span>
                </div>
                <ThinProgress value={pct} gradient={g.gradient} />
              </div>
            )
          })}
        </div>
      </section>

      {/* Journal Prompts */}
      <section className="reflection-section">
        <h2 className="reflection-section__title">Daily Reflection</h2>
        <p className="reflection-section__desc">Answer a few prompts to capture today's highlights and challenges.</p>
        
        <div className="reflection-prompts">
          {JOURNAL_PROMPTS.map((p, idx) => (
            <div key={idx} className="reflection-prompt">
              {p}
            </div>
          ))}
        </div>
        
        <textarea
          value={journal}
          onChange={(e) => setJournal(e.target.value)}
          placeholder="Write your thoughts here..."
          className="reflection-journal"
        />
        
        <div className="reflection-actions">
          <button className="reflection-save">Save Reflection</button>
        </div>
      </section>
    </section>
  )
}