/** Web token process fixture using real runtime, HTTP routes, and Loader reloads. */
import type { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import { apply as applyWeb, internals, type Config } from '@deepseek-ai/dsh-web-app'

export { name, inject, Config } from '@deepseek-ai/dsh-web-app'

/** Mount the shipped Web runtime with a fixture page and one authenticated route. */
export function apply(ctx: Context, config: Config): void {
  internals.resolveDistIndex = () => fileURLToPath(new URL('./index.html', import.meta.url))
  applyWeb(ctx, config)
  ctx.inject(['connection'], (owner) => {
    owner.effect(() => owner.connection.fetch.register({
      path: '/api/token-check', methods: ['GET'], requestBody: 'buffered',
      fetch: () => Promise.resolve(new Response('authenticated')),
    }))
  })
  const receive = (command: unknown): void => {
    if (command !== 'reload') return
    void (async () => {
      const entry = [...ctx.loader.entries()].find(row => row.options.id === 'connection')
      if (entry === undefined) throw new Error('Connection entry missing from Loader')
      await entry.refresh()
      await ctx.loader.await()
      const connection = ctx.get('connection')
      if (connection === undefined) throw new Error('Connection missing after reload')
      process.send?.({ command: 'reload', url: connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`) })
    })().catch((error: unknown) => {
      process.send?.({ command: 'reload', error: error instanceof Error ? error.message : String(error) })
    })
  }
  ctx.effect(() => {
    process.on('message', receive)
    return () => { process.off('message', receive) }
  })
}
