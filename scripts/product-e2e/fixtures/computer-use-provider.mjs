import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const output = process.env.KALA_TEST_EVIDENCE_DIR
if (!output) throw new Error('KALA_TEST_EVIDENCE_DIR is required for the isolated provider fixture')
mkdirSync(output, { recursive: true, mode: 0o700 })
const evidence = []
const save = () => writeFileSync(join(output, 'provider.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 })
const send = (response, event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
createServer(async (request, response) => {
  try {
    if (request.method !== 'POST') { response.writeHead(404).end(); return }
    const chunks = []
    let bytes = 0
    for await (const chunk of request) {
      bytes += chunk.length
      if (bytes > 20 * 1024 * 1024) throw new Error('Provider fixture request exceeds limit')
      chunks.push(chunk)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const results = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((block) => block.type === 'tool_result') : [])
    const images = results.flatMap((result) => Array.isArray(result.content) ? result.content.filter((block) => block.type === 'image') : [])
    const image = images.at(-1)
    const containsBase64Text = results.some((result) => typeof result.content === 'string' && result.content.includes('kala.computer-use.screenshot.v1'))
    let text
    if (image) {
      const png = Buffer.from(image.source.data, 'base64')
      if (image.source.type !== 'base64' || image.source.media_type !== 'image/png' || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Agent observation was not a native PNG image block')
      if (containsBase64Text) throw new Error('Desktop base64 leaked into ordinary model text')
      evidence.push({ ok: true, imageBytes: png.length, width: png.readUInt32BE(16), height: png.readUInt32BE(20), containsBase64Text })
      text = 'KALA_DESKTOP_IMAGE_RECEIVED: the controlled provider received a real native PNG image block.'
    } else if (containsBase64Text || results.some((result) => result.is_error)) {
      evidence.push({ ok: false, error: containsBase64Text ? 'Desktop screenshot arrived as text, not a native image' : 'Desktop tool execution failed' })
      text = 'KALA_DESKTOP_IMAGE_FAILED'
    }
    const toolName = body.tools?.some((tool) => tool.name === 'computer_use') ? 'computer_use' : 'tool_search'
    if (!text && !body.tools?.some((tool) => tool.name === toolName)) throw new Error('No computer-use tool or catalog search is available')
    save()
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    send(response, { type: 'message_start', message: { id: 'desktop-fixture', usage: { input_tokens: 10, output_tokens: 0 } } })
    if (text) {
      send(response, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      send(response, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    } else {
      send(response, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `desktop-${Date.now()}`, name: toolName, input: {} } })
      send(response, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolName === 'computer_use'
        ? { operation: 'screenshot', _intent: 'Verify that the explicitly authorized real desktop reaches the model as a native image observation.' }
        : { query: 'computer_use', _intent: 'Discover the desktop tool needed to verify the explicitly authorized real desktop observation.' }) } })
    }
    send(response, { type: 'content_block_stop', index: 0 })
    send(response, { type: 'message_delta', delta: { stop_reason: text ? 'end_turn' : 'tool_use' }, usage: { output_tokens: 20 } })
    send(response, { type: 'message_stop' })
    response.end()
  } catch (error) {
    evidence.push({ ok: false, error: error instanceof Error ? error.message : String(error) })
    save()
    response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { type: 'fixture_error', message: evidence.at(-1).error } }))
  }
}).listen(Number(process.env.KALA_TEST_PROVIDER_PORT ?? 3334), '127.0.0.1', () => console.log('Isolated controlled computer-use provider ready'))
