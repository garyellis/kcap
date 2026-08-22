import { describe, expect, it } from 'vitest'
import { formatCpu, formatMemory, percent } from './format'

describe('formatCpu', () => {
  it('keeps millicores below one core, where the raw number is the readable one', () => {
    expect(formatCpu(750)).toBe('750m')
  })

  it('drops the decimal on a whole number of cores', () => {
    // `2.0 cores` is noise; the tenth only earns its place when it says something.
    expect(formatCpu(2000)).toBe('2 cores')
    expect(formatCpu(2500)).toBe('2.5 cores')
  })

  it('switches units at exactly one core, and says "core" there', () => {
    // A 1-core node and a 1000m request are both ordinary, so `1 cores` is a
    // defect an operator sees. It shipped that way until this file was written.
    expect(formatCpu(999)).toBe('999m')
    expect(formatCpu(1000)).toBe('1 core')
    expect(formatCpu(1500)).toBe('1.5 cores')
  })
})

describe('formatMemory', () => {
  it('keeps MiB below one GiB', () => {
    expect(formatMemory(768)).toBe('768 MiB')
  })

  it('drops the decimal on a whole number of GiB', () => {
    expect(formatMemory(2048)).toBe('2 GiB')
    expect(formatMemory(2560)).toBe('2.5 GiB')
  })

  it('switches units at exactly one GiB, on 1024 rather than 1000', () => {
    expect(formatMemory(1023)).toBe('1023 MiB')
    expect(formatMemory(1024)).toBe('1 GiB')
  })
})

describe('percent', () => {
  it('rounds to a whole percentage', () => {
    expect(percent(1, 3)).toBe(33)
    expect(percent(2, 3)).toBe(67)
  })

  // The guard is invisible on screen and load-bearing: a pool with no capacity
  // would otherwise print `Infinity%` or `NaN%` beside a real number.
  it('reads as zero rather than dividing by an empty total', () => {
    expect(percent(500, 0)).toBe(0)
    expect(percent(500, -1)).toBe(0)
  })
})
