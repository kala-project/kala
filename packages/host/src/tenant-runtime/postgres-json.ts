const FIELD = '__kalaPostgresUtf16PathsV1'
const unsupportedText = /[\u0000\uD800-\uDFFF]/u
type Path = (string | number)[]

/** JSONB cannot represent NUL or lone UTF-16 surrogates. Preserve their exact code units. */
export function stringifyPostgresJson(value: unknown): string | undefined {
  const raw = JSON.stringify(value)
  if (raw === undefined) return undefined
  const document: unknown = JSON.parse(raw)
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    if (typeof document === 'string' && unsupportedText.test(document)) {
      throw new TypeError('PostgreSQL escaped text requires an object payload')
    }
    return raw
  }
  if (Object.hasOwn(document, FIELD)) throw new TypeError('Reserved PostgreSQL JSON encoding field')
  const paths: Path[] = []
  function encode(candidate: unknown, path: Path): unknown {
    if (typeof candidate === 'string' && unsupportedText.test(candidate)) {
      paths.push(path)
      return Buffer.from(candidate, 'utf16le').toString('base64')
    }
    if (Array.isArray(candidate)) return candidate.map((item, index) => encode(item, [...path, index]))
    if (candidate && typeof candidate === 'object') {
      return Object.fromEntries(Object.entries(candidate).map(([key, item]) => {
        if (unsupportedText.test(key)) throw new TypeError('PostgreSQL JSON property name contains unsupported text')
        return [key, encode(item, [...path, key])]
      }))
    }
    return candidate
  }
  const encoded = encode(document, [])
  if (!paths.length) return raw
  return JSON.stringify({ ...encoded as Record<string, unknown>, [FIELD]: paths })
}

export function decodePostgresJson<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, FIELD)) return value
  const document = JSON.parse(JSON.stringify(value)) as Record<string, unknown>
  const paths = document[FIELD]
  if (!Array.isArray(paths)) throw new Error('Invalid PostgreSQL UTF-16 path metadata')
  delete document[FIELD]
  for (const path of paths) {
    if (!Array.isArray(path) || !path.length || !path.every(key => typeof key === 'string'
      || (Number.isSafeInteger(key) && key >= 0))) throw new Error('Invalid PostgreSQL UTF-16 path')
    let target: object = document
    for (const key of path.slice(0, -1)) {
      if (!Object.hasOwn(target, key)) throw new Error('Missing PostgreSQL UTF-16 path')
      const next: unknown = Reflect.get(target, key)
      if (!next || typeof next !== 'object') throw new Error('Invalid PostgreSQL UTF-16 path target')
      target = next
    }
    const key = path.at(-1)!
    const encoded: unknown = Reflect.get(target, key)
    if (!Object.hasOwn(target, key) || typeof encoded !== 'string'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
      throw new Error('Invalid PostgreSQL UTF-16 bytes')
    }
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length % 2) throw new Error('Invalid PostgreSQL UTF-16 byte length')
    Reflect.set(target, key, bytes.toString('utf16le'))
  }
  return document as T
}
