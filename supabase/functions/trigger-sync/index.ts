import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const GITHUB_PAT = Deno.env.get('GITHUB_PAT') ?? ''
const REPO = 'fixxx-dev/my-prototype2'

serve(async () => {
  if (!GITHUB_PAT) {
    return new Response(JSON.stringify({ error: 'GITHUB_PAT not set' }), { status: 500 })
  }

  const res = await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GITHUB_PAT}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ event_type: 'sync-catalog' }),
  })

  if (!res.ok) {
    const text = await res.text()
    return new Response(JSON.stringify({ error: text }), { status: 500 })
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200 })
})
