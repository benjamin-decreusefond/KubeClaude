import { EventEmitter } from 'node:events';
import type { Run, RunEvent } from './types.js';

export interface AppEvents {
  'run:created': [Run];
  'run:updated': [Run];
  'run:event': [RunEvent];
  'quota:changed': [];
}

class TypedEmitter extends EventEmitter {
  override emit<K extends keyof AppEvents>(event: K, ...args: AppEvents[K]): boolean {
    return super.emit(event as string, ...args);
  }

  override on<K extends keyof AppEvents>(event: K, listener: (...args: AppEvents[K]) => void): this {
    return super.on(event as string, listener as (...args: unknown[]) => void);
  }

  override off<K extends keyof AppEvents>(event: K, listener: (...args: AppEvents[K]) => void): this {
    return super.off(event as string, listener as (...args: unknown[]) => void);
  }
}

export const bus = new TypedEmitter();
// Every SSE client subscribes to the same bus; the default cap of 10 is far too low.
bus.setMaxListeners(0);
