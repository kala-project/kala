export function nonnegativeDecimal(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new Error('invalid usage accounting')
  return BigInt(value)
}

export function decimalForWire(value: bigint): number | string {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString()
}
