import '@testing-library/jest-dom'

// TextEncoder / TextDecoder (not always available in jsdom)
const { TextEncoder, TextDecoder } = require('util')
if (typeof globalThis.TextEncoder === 'undefined') globalThis.TextEncoder = TextEncoder
if (typeof globalThis.TextDecoder === 'undefined') globalThis.TextDecoder = TextDecoder

// Web Crypto
const { webcrypto } = require('crypto')
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, writable: true })

// TransformStream (Node 18 stream/web)
if (typeof globalThis.TransformStream === 'undefined') {
  const { TransformStream } = require('stream/web')
  globalThis.TransformStream = TransformStream
}

// Replace jsdom Blob with Node's buffer.Blob which supports .text() / .arrayBuffer()
globalThis.Blob = require('buffer').Blob

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
})

// Mock IntersectionObserver
global.IntersectionObserver = class IntersectionObserver {
  constructor() {}
  disconnect() {}
  observe() {}
  takeRecords() {
    return []
  }
  unobserve() {}
}

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
  constructor() {}
  disconnect() {}
  observe() {}
  unobserve() {}
}
