import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const normalize = (value?: string | null) => {
  if (!value) return value ?? undefined
  const trimmed = value.trim()
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

const envEntries = readFileSync('.env.local', 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const idx = line.indexOf('=')
    const key = line.slice(0, idx)
    const value = line.slice(idx + 1)
    return [key, normalize(value)] as const
  })

const env = Object.fromEntries(envEntries)

const supabase = createClient(env.VITE_SUPABASE_URL as string, env.VITE_SUPABASE_ANON_KEY as string)

async function run() {
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: env.VITE_SINGLE_USER_EMAIL as string,
    password: env.VITE_SINGLE_USER_PASSWORD as string,
  })
  if (signInError) {
    console.error('sign-in failed', signInError)
    return
  }
  const taskId = 'f19a594c-47ec-476f-bb6e-c8b625d2e7dd'
  const bucketId = '1470a0ba-9e94-4c96-be33-8fbd5e53d2fb'
  const { data, error } = await supabase
    .from('tasks')
    .update({ completed: false })
    .eq('id', taskId)
    .eq('bucket_id', bucketId)
    .select('id, completed')
  console.log('update response', data, error)
}

run().finally(() => {
  supabase.auth.signOut()
})
