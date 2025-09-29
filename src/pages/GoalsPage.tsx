import type { ReactElement } from 'react'
import './GoalsPage.css'

type GoalsPageProps = {
  onNavigate: (tab: 'goals' | 'taskwatch' | 'reflection') => void
}

export default function GoalsPage({ onNavigate }: GoalsPageProps): ReactElement {
  return (
    <section className="site-main__inner goals-handoff" aria-label="Goals">
      <h1>Goals</h1>
      <p>This tab is ready for a fresh start. Add your new layout here whenever you&rsquo;re ready.</p>
      <div className="goals-handoff__actions">
        <button type="button" onClick={() => onNavigate('taskwatch')}>
          Go to Stopwatch
        </button>
        <button type="button" onClick={() => onNavigate('reflection')}>
          Go to Reflection
        </button>
      </div>
    </section>
  )
}
