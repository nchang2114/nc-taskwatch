# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

## Data egress optimizations

This app uses Supabase PostgREST under the hood. To keep payload sizes small:

- Goals list no longer includes the potentially large `tasks.notes` field. Notes are fetched lazily per task the first time you expand its details panel.
- Session history sync is limited to a recent window (default 30 days) using the `updated_at` column to reduce egress on each load.

These changes live in:

- `src/lib/goalsApi.ts` — bulk fetch omits notes; `fetchTaskNotes(taskId)` loads them on demand.
- `src/pages/GoalsPage.tsx` — triggers the lazy notes request when expanding a task.
- `src/lib/sessionHistory.ts` — adds a 30‑day `updated_at` filter by default.

You can tune the history window via `HISTORY_REMOTE_WINDOW_DAYS` in `sessionHistory.ts`.
You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

## Repeating sessions: guides, confirmations, and exceptions

Interactive guide entries (suggested by repeating rules) are supported:

- Guides open a popover like normal sessions.
- Actions in the popover:
  - Confirm: converts the guide into a real session and tags it with the originating rule and local occurrence date.
  - Skip this repetition: records an exception so the guide is hidden on that date.
- Guides auto-hide if:
  - A real entry exists with matching routine_id + occurrence_date (client-side optional tags), or
  - An exception exists for that rule/date.

Implementation details:

- History entries carry optional local tags:
  - routineId: string | null
  - occurrenceDate: YYYY-MM-DD (local) | null
- Exceptions persist locally in localStorage under `nc-taskwatch-repeating-exceptions`. Optional remote sync is gated by env.

Supabase schema proposal (optional, recommended for cross-device):

- Alter `session_history` to add:
  - routine_id: uuid or text, nullable
  - occurrence_date: date, nullable
- Create table `repeating_exceptions`:
  - id uuid primary key
  - user_id uuid (FK → auth.users.id)
  - routine_id uuid/text (FK → repeating_sessions.id if uuid)
  - occurrence_date date
  - action text check in ('skipped','rescheduled')
  - new_started_at timestamptz null
  - new_ended_at timestamptz null
  - notes text null
  - created_at timestamptz default now()
  - updated_at timestamptz default now()

Env flags for safe rollout:

- VITE_ENABLE_ROUTINE_TAGS=true to include routine_id and occurrence_date in session_history sync.
- VITE_ENABLE_REPEATING_EXCEPTIONS=true to sync exceptions to repeating_exceptions; otherwise they remain local-only.
