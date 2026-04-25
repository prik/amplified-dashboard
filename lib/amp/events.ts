import { EventEmitter } from 'node:events'

// Module-level event bus. The indexer emits here when new txs land; SSE route
// handlers subscribe and push to connected browser clients. Single bus for the
// whole Node process — shared across all instrumentation + route handlers.

export const ampEvents = new EventEmitter()
// Many SSE clients can be connected at once; default limit of 10 would warn.
ampEvents.setMaxListeners(0)

export interface TxEvent { stored: number; total: number; reason: 'tail' | 'backfill' }
